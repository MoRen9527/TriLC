// ── Init Assemble ──
// POST /internal/v1/init/assemble 执行体（i2-1 拆解 §一）：
//   ① 校验先行（≥1 岗 / roleId ∈ 岗位目录 / 去重 / 名字必填 / 阶段门禁 422 /
//     防重入 409）→ ② 预写段（白名单落点 tmp→rename + .bak 备份目录）→
//   ③ 提交段（公司态先、链路态后）→ ④ 事件发布（init:step-event）。
//
// 零本地执行契约（W30 沿用）：装配动作只在 daemon 端点内发生；TriPilot /
// trilc chat 两入口只发指令（本端点载荷），不写文件、不执行装配。
//
// 阶段门禁口径（i2-1 §一.2 + 候选 A）：
//   - chainState === 'onboarding' → 直接放行；
//   - chainState === 'selfcheck' 且自检已完结（summary ∈ {pass, degraded}）
//     → 提交段先补 selfcheck→onboarding 转移再装配（两入口流程自洽）；
//   - 其余（uninitialized / selfcheck 未完成或 blocked / project-link+）→ 422。
//
// 幂等重试（i2-1 §一.4）：公司态 save 成功但 transition 失败 → 不回滚文件；
// 重入时公司态已 initialized 且链路态仍 onboarding → 跳过文件段与 state save，
// 校验员工一致后直接补 transitionTo。
//
// 落点白名单（枚举，任何逃逸在 validateAssemblePayload 拒绝）：
//   - {workspaceRoot}/.claude/agents/<roleId>.md（roleId 必须来自岗位目录）
//   - {workspaceRoot}/docs/registry/company-state.json
//   - {workspaceRoot}/docs/registry/business-state.md（既有真实内容不覆盖）
//   - {workspaceRoot}/AGENTS.md（既有真实内容不覆盖）
//   - {dataDir}/company/state.json（经 CompanyInitState.save() 机制沿用，
//     init-state.ts 零改动；REQ-019 baseline commit 随机制触发）

import { mkdir, writeFile, rename, copyFile, access, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import type { LocalBusEvent } from '../localbus/bus.js';
import type { ChainState, InitChain } from './init-chain.js';
import type { CompanyEmployee, CompanyInitState, CompanyState, OnboardingProgress } from './init-state.js';
import type { RoleCatalogEntry } from '../config/contract-resolver.js';

// ── Types ──

export type AssembleEntry = 'tripilot' | 'trilc-chat';

export interface AssembleSelection {
  roleId: string;
  name: string;
}

export interface AssembleRequest {
  ceoName: string;
  selections: AssembleSelection[];
  entry: AssembleEntry;
}

export interface AssembleDeps {
  dataDir: string;
  workspaceRoot: string;
  chain: InitChain;
  companyState: CompanyInitState;
  publish: (event: LocalBusEvent) => void;
  /** 岗位目录只读访问器（contract-resolver.getRoleCatalog，注入便于测试）。 */
  getRoleCatalog: () => { roles: RoleCatalogEntry[] } | null;
  /** 测试注入点：预写段第 N 个目标写 tmp 后抛错（回滚单测）。 */
  failOnTarget?: number;
  /** 测试注入点：公司态 save 成功后 transitionTo 抛错（幂等重试单测）。 */
  failOnTransition?: boolean;
}

export type AssembleResult =
  | {
      status: 200;
      ok: true;
      chainState: 'project-link';
      companyState: 'initialized';
      employees: CompanyEmployee[];
      /** 既有真实内容未覆盖的文件（白名单内、缺失才写的占位类产物）。 */
      preserved: string[];
      advancedFromSelfcheck: boolean;
      warning?: { recommendedMin: number; current: number };
    }
  | { status: 409; busy: true }
  | { status: 409; conflict: 'employees_mismatch'; existing: CompanyEmployee[] }
  | { status: 422; chainState: ChainState }
  | { status: 500; error: string; rollback?: 'completed' | 'failed'; retryable?: boolean };

// ── 校验（纯函数，先校验后动作；单测矩阵覆盖）──

const ROLE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;
const MAX_NAME_LEN = 64;

export type AssembleValidation =
  | { ok: true; ceoName: string; selections: AssembleSelection[] }
  | { ok: false; error: string; message: string };

export function validateAssemblePayload(
  body: unknown,
  catalog: { roles: RoleCatalogEntry[] } | null,
): AssembleValidation {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'bad_request', message: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;

  const ceoName = typeof b.ceoName === 'string' ? b.ceoName.trim() : '';
  if (!ceoName || ceoName.length > MAX_NAME_LEN) {
    return { ok: false, error: 'bad_request', message: 'ceoName is required (trimmed 1..64 chars)' };
  }
  const entry = b.entry;
  if (entry !== 'tripilot' && entry !== 'trilc-chat') {
    return { ok: false, error: 'bad_request', message: "entry must be 'tripilot' or 'trilc-chat'" };
  }
  if (!Array.isArray(b.selections)) {
    return { ok: false, error: 'bad_request', message: 'selections must be an array' };
  }
  const selections = b.selections as unknown[];
  if (selections.length < 1) {
    return { ok: false, error: 'bad_request', message: 'selections must contain at least 1 role (A4 0 人拦截)' };
  }
  if (!catalog) {
    return { ok: false, error: 'role_catalog_unavailable', message: 'role catalog not loaded' };
  }

  const catalogIds = new Set(catalog.roles.map((r) => r.roleId));
  const seen = new Set<string>();
  const cleaned: AssembleSelection[] = [];
  for (const item of selections) {
    if (typeof item !== 'object' || item === null) {
      return { ok: false, error: 'bad_request', message: 'each selection must be an object' };
    }
    const sel = item as Record<string, unknown>;
    const roleId = typeof sel.roleId === 'string' ? sel.roleId : '';
    // 白名单纪律：roleId 形状 + 岗位目录成员双校验——路径注入/逃逸直接拒绝
    if (!ROLE_ID_PATTERN.test(roleId)) {
      return { ok: false, error: 'bad_request', message: `invalid roleId: ${JSON.stringify(roleId)}` };
    }
    if (!catalogIds.has(roleId)) {
      return { ok: false, error: 'bad_request', message: `roleId not in role catalog: ${roleId}` };
    }
    if (seen.has(roleId)) {
      return { ok: false, error: 'bad_request', message: `duplicate roleId: ${roleId}` };
    }
    seen.add(roleId);
    const name = typeof sel.name === 'string' ? sel.name.trim() : '';
    if (!name || name.length > MAX_NAME_LEN) {
      return { ok: false, error: 'bad_request', message: `name is required for ${roleId} (trimmed 1..64 chars)` };
    }
    cleaned.push({ roleId, name });
  }
  return { ok: true, ceoName, selections: cleaned };
}

// ── 防重入互斥（单执行体）──

let _assembling = false;

export function isAssembling(): boolean {
  return _assembling;
}

/** 测试复位。 */
export function resetAssembleForTest(): void {
  _assembling = false;
}

// ── 装配产物模板 ──

function yamlQuote(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildAgentMd(roleId: string, roleName: string, oneLinePositioning: string, name: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: "${yamlQuote(oneLinePositioning)}"`,
    `roleId: ${roleId}`,
    `role: ${roleName}`,
    '---',
    '',
    `你是 TriCompany 的 ${roleName} 岗位员工，工作名「${name}」。`,
    '',
    `- 岗位标准定义（真源）：TriCompany/source-agents/${roleId}/（合同五件套：soul / agent-body / agent-frontmatter / memory / colleagues / social）`,
    '- 本文件由 TriCade 初始化装配端点生成（POST /internal/v1/init/assemble），承载工作区员工索引与名字绑定；岗位职责修订走源侧合同。',
    `- 运行时身份注入由 TriLC contract-resolver 按 agent_id=${roleId} 执行；岗位是标准资产，名字是用户资产（CEO 开张时指定）。`,
    '',
  ].join('\n');
}

function buildCompanyStateJson(ceoName: string, employees: CompanyEmployee[], entry: AssembleEntry): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      ceoName,
      employees,
      assembledAt: new Date().toISOString(),
      entry,
    },
    null,
    2,
  ) + '\n';
}

function buildBusinessStateMd(ceoName: string, employees: CompanyEmployee[]): string {
  const lines = employees.map((e) => `- ${e.role} — ${e.name}`);
  return [
    '# TriCompany Business State',
    '',
    `公司已开张（CEO：${ceoName}）。`,
    '',
    '## 员工名单',
    '',
    ...lines,
    '',
    '- 公司状态写真源：daemon `{dataDir}/company/state.json` + 本仓 `docs/registry/company-state.json`',
    '- 本文件为装配占位；业务状态内容由公司 Registry 工作层维护。',
    '',
  ].join('\n');
}

function buildAgentsMd(ceoName: string, employees: CompanyEmployee[]): string {
  const lines = employees.map((e) => `- ${e.role} — ${e.name}（.claude/agents/${e.role}.md）`);
  return [
    '# TriCompany Agents',
    '',
    `公司已开张（CEO：${ceoName}），由 TriCade 初始化装配生成。`,
    '',
    '## 员工岗位',
    '',
    ...lines,
    '',
    '- 岗位标准定义真源：TriCompany/source-agents/<roleId>/（合同五件套）',
    '- 员工文件：.claude/agents/<roleId>.md（名字绑定索引）',
    '',
  ].join('\n');
}

// ── 预写段（白名单落点 tmp→rename + .bak 备份目录）──

interface PrewriteTarget {
  /** 白名单相对路径（bak 键 + preserved 报告）。 */
  relPath: string;
  absPath: string;
  content: string;
  tmpPath: string;
  /** 原文件存在时记录其 .bak 副本路径。 */
  bakPath: string | null;
  applied: boolean;
  /** 既有真实内容不覆盖：存在即跳过（preserved）。 */
  onlyIfMissing: boolean;
  preserved: boolean;
}

function buildTargets(
  deps: AssembleDeps,
  req: AssembleRequest,
  catalog: { roles: RoleCatalogEntry[] },
): PrewriteTarget[] {
  const root = resolve(deps.workspaceRoot);
  const byId = new Map(catalog.roles.map((r) => [r.roleId, r]));
  const employees: CompanyEmployee[] = req.selections.map((s) => ({ role: s.roleId, name: s.name.trim() }));
  const targets: PrewriteTarget[] = [];

  for (const sel of req.selections) {
    const meta = byId.get(sel.roleId);
    const relPath = `.claude/agents/${sel.roleId}.md`;
    const absPath = resolve(root, '.claude', 'agents', `${sel.roleId}.md`);
    targets.push({
      relPath,
      absPath,
      content: buildAgentMd(sel.roleId, meta?.roleName ?? sel.roleId, meta?.oneLinePositioning ?? '', sel.name.trim()),
      tmpPath: `${absPath}.tmp`,
      bakPath: null,
      applied: false,
      onlyIfMissing: false,
      preserved: false,
    });
  }

  const companyStateRel = 'docs/registry/company-state.json';
  const companyStateAbs = resolve(root, 'docs', 'registry', 'company-state.json');
  targets.push({
    relPath: companyStateRel,
    absPath: companyStateAbs,
    content: buildCompanyStateJson(req.ceoName.trim(), employees, req.entry),
    tmpPath: `${companyStateAbs}.tmp`,
    bakPath: null,
    applied: false,
    onlyIfMissing: false,
    preserved: false,
  });

  // business-state.md / AGENTS.md 为占位类产物：缺失才写；既有真实内容
  // （如现状真源 docs/registry/business-state.md 为 Registry 工作层）不覆盖，
  // 响应 preserved 字段报告——.bak+git 可恢复但占位覆盖真实 registry 属破坏性操作。
  const businessStateRel = 'docs/registry/business-state.md';
  const businessStateAbs = resolve(root, 'docs', 'registry', 'business-state.md');
  targets.push({
    relPath: businessStateRel,
    absPath: businessStateAbs,
    content: buildBusinessStateMd(req.ceoName.trim(), employees),
    tmpPath: `${businessStateAbs}.tmp`,
    bakPath: null,
    applied: false,
    onlyIfMissing: true,
    preserved: false,
  });

  const agentsRel = 'AGENTS.md';
  const agentsAbs = resolve(root, 'AGENTS.md');
  targets.push({
    relPath: agentsRel,
    absPath: agentsAbs,
    content: buildAgentsMd(req.ceoName.trim(), employees),
    tmpPath: `${agentsAbs}.tmp`,
    bakPath: null,
    applied: false,
    onlyIfMissing: true,
    preserved: false,
  });

  return targets;
}

function newBakDirPath(dataDir: string): string {
  return join(dataDir, 'company', 'assemble-bak', `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`);
}

async function prewriteAll(deps: AssembleDeps, targets: PrewriteTarget[], bakDir: string): Promise<void> {
  let bakDirCreated = false;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (t.onlyIfMissing) {
      try {
        await access(t.absPath);
        t.preserved = true;
        continue;
      } catch { /* 缺失 → 走写入 */ }
    }
    await mkdir(dirname(t.absPath), { recursive: true });
    await writeFile(t.tmpPath, t.content, 'utf-8');
    // 已存在原文件 → 备份至 .bak 目录（白名单逐文件真原子写前置）
    try {
      await access(t.absPath);
      if (!bakDirCreated) {
        await mkdir(bakDir, { recursive: true });
        bakDirCreated = true;
      }
      const bakPath = join(bakDir, t.relPath.replace(/[\\/]/g, '__'));
      await copyFile(t.absPath, bakPath);
      t.bakPath = bakPath;
    } catch { /* 原文件不存在 → 新建 */ }
    if (deps.failOnTarget !== undefined && i === deps.failOnTarget) {
      throw new Error(`injected prewrite failure at target #${i}`);
    }
    await rename(t.tmpPath, t.absPath);
    t.applied = true;
  }
}

/** 回滚：已 rename 的目标按 .bak 恢复（无 bak 即删新文件）+ 清 tmp 残留。 */
async function rollbackPrewrite(targets: PrewriteTarget[], bakDir: string): Promise<boolean> {
  let ok = true;
  for (const t of [...targets].reverse()) {
    if (!t.applied) continue;
    try {
      if (t.bakPath) await copyFile(t.bakPath, t.absPath);
      else await rm(t.absPath, { force: true });
    } catch {
      ok = false;
    }
  }
  for (const t of targets) {
    try {
      await rm(t.tmpPath, { force: true });
    } catch { /* 残留 tmp 清理 best-effort */ }
  }
  // 恢复全部成功才删 .bak 目录；有失败则保留现场供手工恢复
  if (ok) {
    try {
      await rm(bakDir, { recursive: true, force: true });
    } catch {
      ok = false;
    }
  }
  return ok;
}

// ── 执行体 ──

function publishStepEvent(
  deps: AssembleDeps,
  step: string,
  entry: AssembleEntry,
  payload: unknown,
): void {
  deps.publish({ type: 'init:step-event', phase: 'onboarding', step, entry, payload });
}

export async function runAssemble(deps: AssembleDeps, req: AssembleRequest): Promise<AssembleResult> {
  if (_assembling) return { status: 409, busy: true };
  _assembling = true;
  try {
    return await doAssemble(deps, req);
  } finally {
    _assembling = false;
  }
}

async function doAssemble(deps: AssembleDeps, req: AssembleRequest): Promise<AssembleResult> {
  const chainFrame = await deps.chain.load();
  const state = chainFrame.chainState;
  const selfcheckSummary = chainFrame.phaseDetail.selfcheck.summary;
  const fromSelfcheck = state === 'selfcheck' && (selfcheckSummary === 'pass' || selfcheckSummary === 'degraded');
  if (state !== 'onboarding' && !fromSelfcheck) {
    return { status: 422, chainState: state };
  }

  const employees: CompanyEmployee[] = req.selections.map((s) => ({ role: s.roleId, name: s.name.trim() }));
  const ceoName = req.ceoName.trim();

  const company = await deps.companyState.load();
  // 幂等重试路径：公司态已 initialized（前次 save 成功、transition 失败/中断）
  // → 跳过文件段与 state save，校验员工一致后直接补 transition（i2-1 §一.4）。
  if (company.state === 'initialized') {
    const existing = company.employees ?? [];
    const same =
      existing.length === employees.length &&
      employees.every((e) => existing.some((x) => x.role === e.role && x.name === e.name));
    if (!same) {
      return { status: 409, conflict: 'employees_mismatch', existing };
    }
    try {
      if (deps.failOnTransition) throw new Error('injected transition failure (retry path)');
      // 前次可能在 selfcheck→onboarding 转移前即失败：重试补全缺的转移步
      if (deps.chain.getState() === 'selfcheck') {
        await deps.chain.transitionTo('onboarding', req.entry);
      }
      await deps.chain.transitionTo('project-link', req.entry);
    } catch (err) {
      publishStepEvent(deps, 'assemble-failed', req.entry, { error: (err as Error).message });
      return { status: 500, error: (err as Error).message, retryable: true };
    }
    publishStepEvent(deps, 'assembled', req.entry, { ceoName, employees });
    return {
      status: 200,
      ok: true,
      chainState: 'project-link',
      companyState: 'initialized',
      employees,
      preserved: [],
      advancedFromSelfcheck: false,
      ...(employees.length < 5 ? { warning: { recommendedMin: 5, current: employees.length } } : {}),
    };
  }

  // ④-开始：assembling 事件
  publishStepEvent(deps, 'assembling', req.entry, null);

  const catalog = deps.getRoleCatalog();
  if (!catalog) {
    publishStepEvent(deps, 'assemble-failed', req.entry, { error: 'role catalog not loaded' });
    return { status: 500, error: 'role catalog not loaded' };
  }
  const targets = buildTargets(deps, req, catalog);
  const bakDir = newBakDirPath(deps.dataDir);

  // ② 预写段：任一失败 → .bak 恢复 + 删新增文件 → 500 { rollback }
  try {
    await prewriteAll(deps, targets, bakDir);
  } catch (err) {
    const rollbackOk = await rollbackPrewrite(targets, bakDir);
    publishStepEvent(deps, 'assemble-failed', req.entry, { error: (err as Error).message });
    return { status: 500, error: (err as Error).message, rollback: rollbackOk ? 'completed' : 'failed' };
  }

  // ③ 提交段：公司态先（save() 机制沿用，REQ-019 随机制触发）、链路态后。
  // save 成功但 transition 失败 → 不回滚文件（幂等重试路径承接，§一.4）。
  try {
    await deps.companyState.save({ state: 'initialized', ceoName, employees });
    if (deps.failOnTransition) throw new Error('injected transition failure');
    if (fromSelfcheck) {
      await deps.chain.transitionTo('onboarding', req.entry);
    }
    await deps.chain.transitionTo('project-link', req.entry);
  } catch (err) {
    publishStepEvent(deps, 'assemble-failed', req.entry, { error: (err as Error).message });
    return { status: 500, error: (err as Error).message, retryable: true };
  }

  // 装配完整成功：.bak 目录使命结束（REQ-019 baseline commit 已留 git 史）
  try {
    await rm(bakDir, { recursive: true, force: true });
  } catch { /* best-effort */ }

  // ④-成功：assembled 事件（chain-changed 由 transitionTo 自动发布，同帧）
  publishStepEvent(deps, 'assembled', req.entry, { ceoName, employees });

  return {
    status: 200,
    ok: true,
    chainState: 'project-link',
    companyState: 'initialized',
    employees,
    preserved: targets.filter((t) => t.preserved).map((t) => t.relPath),
    advancedFromSelfcheck: fromSelfcheck,
    ...(employees.length < 5 ? { warning: { recommendedMin: 5, current: employees.length } } : {}),
  };
}

// ── Onboarding 断点续跑真源（i2-1 §四：装配模块同包两小端点逻辑）──

export interface OnboardingStateProjection {
  state: CompanyState;
  ceoName: string | null;
  employees: CompanyEmployee[];
  step: string | null;
  selectedRoles: string[];
  employeeNames: Record<string, string>;
  updatedAt?: string;
}

export async function getOnboardingStateProjection(
  companyState: CompanyInitState,
): Promise<OnboardingStateProjection> {
  const s = await companyState.load();
  return {
    state: s.state,
    // 断点续跑语义：进行中答案（progress.ceoName）优先于已装配真源（state.ceoName）
    ceoName: s.ceoName ?? s.progress?.ceoName ?? null,
    employees: s.employees ?? [],
    step: s.progress?.step ?? null,
    selectedRoles: s.progress?.selectedRoles ?? [],
    employeeNames: s.progress?.employeeNames ?? {},
    ...(s.progress?.updatedAt ? { updatedAt: s.progress.updatedAt } : {}),
  };
}

/** REQ-016 断点续接步骤枚举（onboarding.ts 叙事态同构，真源语义保留）。 */
export const ONBOARDING_PROGRESS_STEPS = [
  'greeted',
  'name',
  'roles',
  'naming',
  'confirm',
  'assembling',
  'done',
] as const;

export type OnboardingProgressStep = (typeof ONBOARDING_PROGRESS_STEPS)[number];

export type ProgressUpsertValidation =
  | { ok: true; patch: Partial<OnboardingProgress> }
  | { ok: false; error: string; message: string };

export function validateProgressUpsert(body: unknown): ProgressUpsertValidation {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'bad_request', message: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  const patch: Partial<OnboardingProgress> = {};
  if (b.step !== undefined) {
    if (typeof b.step !== 'string' || !(ONBOARDING_PROGRESS_STEPS as readonly string[]).includes(b.step)) {
      return { ok: false, error: 'bad_request', message: `step must be one of ${ONBOARDING_PROGRESS_STEPS.join('/')}` };
    }
    patch.step = b.step as OnboardingProgressStep;
  }
  if (b.ceoName !== undefined) {
    if (typeof b.ceoName !== 'string' || !b.ceoName.trim() || b.ceoName.trim().length > MAX_NAME_LEN) {
      return { ok: false, error: 'bad_request', message: 'ceoName must be a trimmed 1..64 char string' };
    }
    patch.ceoName = b.ceoName.trim();
  }
  if (b.selectedRoles !== undefined) {
    if (!Array.isArray(b.selectedRoles) || b.selectedRoles.some((r) => typeof r !== 'string')) {
      return { ok: false, error: 'bad_request', message: 'selectedRoles must be a string array' };
    }
    patch.selectedRoles = [...new Set(b.selectedRoles as string[])];
  }
  if (b.employeeNames !== undefined) {
    if (typeof b.employeeNames !== 'object' || b.employeeNames === null || Array.isArray(b.employeeNames)) {
      return { ok: false, error: 'bad_request', message: 'employeeNames must be an object' };
    }
    const names: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.employeeNames as Record<string, unknown>)) {
      if (typeof v !== 'string' || !v.trim() || v.trim().length > MAX_NAME_LEN) {
        return { ok: false, error: 'bad_request', message: `employeeNames.${k} must be a trimmed 1..64 char string` };
      }
      names[k] = v.trim();
    }
    patch.employeeNames = names;
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'bad_request', message: 'no progress fields to upsert' };
  }
  return { ok: true, patch };
}

/** upsert 部分字段 → 经 CompanyInitState.save({ progress }) 持久（init-state.ts 零改动）。 */
export async function upsertOnboardingProgress(
  companyState: CompanyInitState,
  patch: Partial<OnboardingProgress>,
): Promise<void> {
  const current = await companyState.load();
  const next: OnboardingProgress = {
    step: patch.step ?? current.progress?.step ?? 'greeted',
    ...(patch.ceoName !== undefined ? { ceoName: patch.ceoName } : current.progress?.ceoName !== undefined ? { ceoName: current.progress.ceoName } : {}),
    ...(patch.selectedRoles !== undefined ? { selectedRoles: patch.selectedRoles } : current.progress?.selectedRoles !== undefined ? { selectedRoles: current.progress.selectedRoles } : {}),
    ...(patch.employeeNames !== undefined ? { employeeNames: patch.employeeNames } : current.progress?.employeeNames !== undefined ? { employeeNames: current.progress.employeeNames } : {}),
    updatedAt: new Date().toISOString(),
  };
  await companyState.save({ progress: next });
}

// ── 会话初始化器 init 模式路由（i2-1 §三：新函数，落 app.ts 任务提交路径）──

/** init 模式链路状态集（§三：不含 uninitialized——启动转移后恒为 selfcheck+）。 */
export const INIT_MODE_CHAIN_STATES: readonly ChainState[] = [
  'selfcheck',
  'onboarding',
  'project-link',
  'sync',
  'confirm',
];

const INIT_MODE_STAGE_HINTS: Partial<Record<ChainState, string>> = {
  selfcheck: '自检阶段：查看/等待自检结果（chain/status 的 phaseDetail.selfcheck）；自检由 daemon 端点触发，通过后进入公司开张。',
  onboarding: '公司开张阶段：引导 CEO 在 TriPilot 面板阶段卡或 trilc chat 初始化流程中选择员工岗位并起名；装配由 daemon 端点 POST /internal/v1/init/assemble 执行。',
  'project-link': '项目面初始化阶段：引导 CEO 完成项目源选择（本地仓 / GitHub 链接）与 worktree 建立。',
  sync: '五维同步阶段：等待/推进与 TriMC 的公司、模型、key、员工、项目同步。',
  confirm: '协同确认阶段：三方比对确认后进入可协同态。',
};

/**
 * init 模式会话 bootstrap（§三）：链态 ∈ INIT_MODE_CHAIN_STATES 且请求非
 * 员工 agent 显式会话（无 client systemPrompt）时，替代 defaultSystemPrompt
 * 注入 init 状态真源引用 + init 端点指令面。员工合同装配路径（6.4）不动。
 */
export function buildInitModeSystemPrompt(chainState: ChainState): string | null {
  if (!(INIT_MODE_CHAIN_STATES as readonly string[]).includes(chainState)) return null;
  const hint = INIT_MODE_STAGE_HINTS[chainState as (typeof INIT_MODE_CHAIN_STATES)[number]];
  return [
    '你是 TriCade 安装初始化阶段的会话助手。公司初始化链路当前阶段：' + chainState + '。',
    '',
    '- 结构化初始化流程由两入口承载（TriPilot 面板阶段卡 / trilc chat 初始化流程）；你只负责指引与答疑，不执行任何装配、探测或文件写动作（零本地执行契约）。',
    '- 状态真源（只读，daemon 端点）：',
    '  - GET /internal/v1/init/chain/status — 链路状态与阶段快照',
    '  - GET /internal/v1/init/role-catalog — 岗位目录（结构化员工选择载荷）',
    '  - GET /internal/v1/init/onboarding/state — 开张进度（断点续跑真源）',
    '- 装配执行体 = daemon 端点 POST /internal/v1/init/assemble（单执行体互斥）；你不得调用该端点，也不得用工具写任何公司装配文件。',
    '- 当前阶段提示：' + hint,
  ].join('\n');
}
