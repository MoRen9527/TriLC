// ── Init CLI Text Flow（i2-1 拆解 §四.2：trilc chat 文本化）──
// chat 模式启动时 chain/status 呈初始化阶段 → 文本化流程：
//   selfcheck 诊断卡（blocked 置顶 + 组合规则注记）→ 可选触发自检 →
//   onboarding：岗位编号多选（默认勾选 D1 五岗）→ CEO 名/员工名问答（REQ-016
//   断点续跑：已答不重复问）→ 汇总确认 → POST assemble（entry=trilc-chat）。
//
// 零本地执行契约：本流程不写任何文件、不执行装配——只渲染 + 发 daemon 端点
// 指令（GET status/role-catalog/onboarding-state、POST progress/selfcheck-run/assemble）。
//
// 员工 --agent 会话路径不动：cmdChat 仅在非 agent 模式调用本流程。

import { resolve } from 'node:path';

interface ChainStatusPayload {
  schemaVersion?: number;
  chainState: string;
  phaseDetail?: {
    selfcheck?: {
      runId: string | null;
      summary: 'pass' | 'degraded' | 'blocked' | null;
      checks: Array<{ id: string; status: string; detail: string; hint: string }>;
      finishedAt: string | null;
      retryCount: number;
    };
  };
  lastTransitionAt?: string | null;
  eventSeq?: number;
  sourceEntry?: string | null;
}

interface RoleCatalogPayload {
  schemaVersion?: number;
  roles: Array<{
    roleId: string;
    roleName: string;
    oneLinePositioning: string;
    isGovernance: boolean;
    defaultSelected: boolean;
  }>;
}

interface OnboardingStatePayload {
  state: string;
  ceoName: string | null;
  employees: Array<{ role: string; name: string }>;
  step: string | null;
  selectedRoles: string[];
  employeeNames: Record<string, string>;
  updatedAt?: string;
}

interface InspectPayload {
  kind: 'managed-worktree' | 'project-clone' | 'unlinked';
  projectKey?: string;
  branch?: string;
  worktree: boolean;
}

interface SyncStatusPayload {
  chainState: string;
  phaseDetail?: { status: string; bundleId: string | null };
  localBundleId: string | null;
  localBundleGeneratedAt: string | null;
  remote: {
    reachable: boolean;
    appliedBundleId: string | null;
    appliedGeneratedAt: string | null;
    fleetHead: { branch: string; commit: string } | null;
    dims: Record<string, string> | null;
  } | null;
}

interface SyncRunPayload {
  status: number;
  bundleId?: string;
  generatedAt?: string;
  chainState?: string;
  dims?: Record<string, 'synced' | 'unavailable'>;
  rePushedOnly?: boolean;
  busy?: boolean;
  error?: string;
  classification?: string;
  message?: string;
  retryable?: boolean;
}

export interface InitCliFlowResult {
  outcome: 'assembled' | 'skipped' | 'blocked' | 'error';
  detail?: string;
}

async function getJson<T>(port: number, path: string): Promise<{ status: number; json: T | null }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const text = await res.text();
    let json: T | null = null;
    try { json = JSON.parse(text) as T; } catch { /* keep null */ }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: null };
  }
}

async function postJson(port: number, path: string, body: unknown): Promise<{ status: number; json: any }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* keep null */ }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: { error: (err as Error).message } };
  }
}

async function ask(question: string): Promise<string> {
  const { createInterface } = await import('node:readline');
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── selfcheck 诊断卡渲染（呈现层组合规则：blocked 置顶 + trimodel blocked
// 且 plane-hint ok 时注记「问周面冒烟绿 ≠ 模型链可用」— i2-1 §四.1）──

function renderSelfcheckCard(selfcheck: NonNullable<ChainStatusPayload['phaseDetail']>['selfcheck']): string {
  const checks = selfcheck?.checks ?? [];
  const order: Record<string, number> = { fail: 0, degraded: 1, ok: 2, skipped: 3 };
  const sorted = [...checks].sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4));
  const lines = sorted.map((c) => {
    const mark = c.status === 'fail' ? '[FAIL]' : c.status === 'degraded' ? '[~]' : c.status === 'ok' ? '[OK]' : '[--]';
    const hint = c.hint ? ` — ${c.hint}` : '';
    return `  ${mark} ${c.id}: ${c.detail}${hint}`;
  });
  const trimodel = checks.find((c) => c.id === 'trimodel');
  const planeHint = checks.find((c) => c.id === 'plane-hint-probe');
  if (trimodel?.status === 'fail' && planeHint?.status === 'ok') {
    lines.push('  注记：问周面冒烟绿 ≠ 模型链可用（trimodel 认证面 blocked 时任务链路仍可能经 TriModel 转发可用，以第五探测为准）');
  }
  const summary = selfcheck?.summary ?? '（未运行）';
  const runId = selfcheck?.runId ? `（runId=${selfcheck.runId}）` : '';
  return [
    `[trilc:init] 自检状态：${summary}${runId}`,
    ...lines,
  ].join('\n');
}

// ── onboarding 流程 ──

async function runOnboardingFlow(port: number): Promise<InitCliFlowResult> {
  const catalogRes = await getJson<RoleCatalogPayload>(port, '/internal/v1/init/role-catalog');
  if (!catalogRes.json || catalogRes.status !== 200) {
    return { outcome: 'error', detail: `role-catalog 不可用（http ${catalogRes.status}）— daemon 岗位目录未就绪` };
  }
  const roles = catalogRes.json.roles;
  if (roles.length === 0) {
    return { outcome: 'error', detail: '岗位目录为空 — daemon 合同/roster 未加载' };
  }

  // 断点续跑（A3）：已答不重复问、可回看
  const stateRes = await getJson<OnboardingStatePayload>(port, '/internal/v1/init/onboarding/state');
  const progress = stateRes.json;

  let ceoName = progress?.ceoName?.trim() ?? '';
  if (ceoName) {
    console.log(`[trilc:init] 断点续跑：CEO 已作答（${ceoName}），不再重复提问`);
  } else {
    ceoName = await ask('请问您的名字？（您将是公司的 CEO）> ');
    if (!ceoName) {
      console.log('[trilc:init] 名字必填 — 未作答，返回聊天。');
      return { outcome: 'error', detail: 'ceoName required' };
    }
    await postJson(port, '/internal/v1/init/onboarding/progress', { step: 'name', ceoName });
  }

  // 岗位编号多选（默认勾选 = D1 DEFAULT_SELECTED_ROLES 五岗；≥1 岗可开张）
  let selectedIds: string[] = progress?.selectedRoles ?? [];
  if (selectedIds.length > 0) {
    console.log(`[trilc:init] 断点续跑：岗位已选（${selectedIds.join(', ')}），不再重复提问`);
  } else {
    console.log('\n[trilc:init] 请选择要启用的岗位（标准岗位目录；推荐至少 5 岗，含治理角色）：');
    roles.forEach((r, i) => {
      const gov = r.isGovernance ? '（治理）' : '';
      const def = r.defaultSelected ? ' *默认' : '';
      console.log(`  [${i + 1}] ${r.roleName}${gov}${def} — ${r.oneLinePositioning}`);
    });
    const input = await ask('输入岗位编号（逗号分隔；直接回车 = 默认勾选 5 岗）> ');
    if (!input) {
      selectedIds = roles.filter((r) => r.defaultSelected).map((r) => r.roleId);
    } else {
      const picked: string[] = [];
      for (const part of input.split(/[,，\s]+/)) {
        const n = parseInt(part, 10);
        if (Number.isFinite(n) && n >= 1 && n <= roles.length) {
          const id = roles[n - 1].roleId;
          if (!picked.includes(id)) picked.push(id);
        }
      }
      selectedIds = picked;
    }
    if (selectedIds.length < 1) {
      console.log('[trilc:init] 至少选择 1 个岗位（A4 0 人拦截）— 未作答，返回聊天。');
      return { outcome: 'error', detail: 'no roles selected' };
    }
    await postJson(port, '/internal/v1/init/onboarding/progress', { step: 'roles', selectedRoles: selectedIds });
  }

  // 逐个起名（岗位是标准资产，名字是用户资产；断点续跑跳过已答）
  const employeeNames: Record<string, string> = { ...(progress?.employeeNames ?? {}) };
  for (const roleId of selectedIds) {
    if (employeeNames[roleId]?.trim()) continue;
    const role = roles.find((r) => r.roleId === roleId);
    const name = await ask(`为岗位 ${role?.roleName ?? roleId} 的员工起名 > `);
    if (!name) {
      console.log('[trilc:init] 员工名字必填 — 未作答，返回聊天。');
      return { outcome: 'error', detail: `name required for ${roleId}` };
    }
    employeeNames[roleId] = name;
    await postJson(port, '/internal/v1/init/onboarding/progress', { step: 'naming', employeeNames });
  }

  // 汇总确认
  console.log('\n[trilc:init] 开张汇总：');
  console.log(`  CEO：${ceoName}`);
  for (const roleId of selectedIds) {
    const role = roles.find((r) => r.roleId === roleId);
    console.log(`  - ${role?.roleName ?? roleId}：${employeeNames[roleId]}`);
  }
  if (selectedIds.length < 5) {
    console.log(`  提示：推荐至少 5 岗，当前 ${selectedIds.length} 岗（可选，不强制）`);
  }
  const confirm = await ask('确认开张？（y/n）> ');
  if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
    console.log('[trilc:init] 已取消 — 进度已保存，下次从当前步骤继续。');
    return { outcome: 'skipped', detail: 'cancelled at confirm' };
  }
  await postJson(port, '/internal/v1/init/onboarding/progress', { step: 'confirm' });

  // assemble 提交（执行体 = daemon 端点；本入口只发指令）
  const selections = selectedIds.map((roleId) => ({ roleId, name: employeeNames[roleId] }));
  const assembleRes = await postJson(port, '/internal/v1/init/assemble', {
    ceoName,
    selections,
    entry: 'trilc-chat',
  });
  if (assembleRes.status === 200) {
    const body = assembleRes.json as { employees?: Array<{ role: string; name: string }>; preserved?: string[]; warning?: { recommendedMin: number; current: number } };
    console.log('\n[trilc:init] 公司开张完成！');
    console.log(`  CEO：${ceoName}`);
    for (const e of body.employees ?? []) console.log(`  - ${e.role}：${e.name}`);
    if (body.warning) console.log(`  提示：当前 ${body.warning.current} 岗（推荐至少 ${body.warning.recommendedMin} 岗，可选）`);
    if (body.preserved?.length) console.log(`  保留既有文件：${body.preserved.join(', ')}`);
    await postJson(port, '/internal/v1/init/onboarding/progress', { step: 'done' }).catch(() => undefined);
    return { outcome: 'assembled' };
  }
  if (assembleRes.status === 409 && assembleRes.json?.busy) {
    console.log('[trilc:init] 装配进行中（单执行体互斥）— 稍后重试同一载荷。');
    return { outcome: 'error', detail: 'assemble busy' };
  }
  if (assembleRes.status === 422) {
    console.log(`[trilc:init] 当前链路状态不允许装配（${assembleRes.json?.chainState}）— 请先完成前置阶段。`);
    return { outcome: 'error', detail: `assemble 422: ${assembleRes.json?.chainState}` };
  }
  if (assembleRes.status === 500 && assembleRes.json?.retryable) {
    console.log(`[trilc:init] 装配提交段失败（可重试）：${assembleRes.json?.error} — 重新提交同一载荷即续跑。`);
    return { outcome: 'error', detail: `assemble retryable: ${assembleRes.json?.error}` };
  }
  console.log(`[trilc:init] 装配失败（http ${assembleRes.status}）：${assembleRes.json?.error ?? 'unknown'} — ${assembleRes.json?.message ?? ''}`);
  return { outcome: 'error', detail: `assemble ${assembleRes.status}` };
}

// ── project-link 流程（I3 增量：inspect 呈现 → 源选择问答 → POST link 收结果；
// 零本地执行——不写文件、不执行 git，只渲染 + 发 daemon 端点指令）──

async function runProjectLinkFlow(port: number): Promise<InitCliFlowResult> {
  const cwd = process.cwd();
  console.log(`[trilc:init] 当前目录：${cwd}`);

  // inspect 呈现（识别分流：受管 worktree / 项目仓普通克隆 / 未关联）
  const inspectRes = await getJson<InspectPayload>(
    port,
    `/internal/v1/projects/inspect?path=${encodeURIComponent(cwd)}`,
  );
  if (inspectRes.status !== 200 || !inspectRes.json) {
    return { outcome: 'error', detail: `inspect 不可用（http ${inspectRes.status}）— daemon 项目面端点未就绪` };
  }
  const insp = inspectRes.json;

  if (insp.kind === 'managed-worktree') {
    console.log(`[trilc:init] 当前目录已是受管 worktree（${insp.projectKey} / ${insp.branch}）— 认领登记即可。`);
    const claimRes = await postJson(port, '/internal/v1/projects/claim', { path: cwd });
    if (claimRes.status === 200) {
      console.log(`[trilc:init] 认领完成：${claimRes.json?.projectKey} / ${claimRes.json?.branch} — PROJECT-LINK 已 linked。`);
      return { outcome: 'skipped', detail: 'project-link linked (claim)' };
    }
    console.log(`[trilc:init] 认领失败（http ${claimRes.status}）：${claimRes.json?.message ?? claimRes.json?.error ?? 'unknown'}`);
    return { outcome: 'error', detail: `claim ${claimRes.status}` };
  }
  if (insp.kind === 'project-clone') {
    console.log(
      `[trilc:init] 当前目录是项目仓普通克隆（${insp.projectKey}，分支 ${insp.branch}）— 非受管形态；\n` +
        '  升级引导：以本目录为主检出（local 源）建立受管 worktree，或走 GitHub 源重链。',
    );
  } else {
    console.log('[trilc:init] 当前目录未关联项目仓（轻提示）— 可走以下两种源建立项目链路。');
  }

  // 源选择问答
  console.log('\n[trilc:init] 项目源选择：');
  console.log('  [1] 本地源：已有主检出（localPath），在其外建立 worktree');
  console.log('  [2] GitHub 源：白名单校验后克隆建主检出（git 系统凭据管理器）');
  console.log('  [3] 认领指定路径（已是受管 worktree 的目录）');
  const choice = await ask('输入编号（其他键跳过进入聊天）> ');
  if (choice === '1' || choice === '2') {
    const isLocal = choice === '1';
    let targetPath = '';
    const payload: Record<string, unknown> = { source: isLocal ? 'local' : 'github', entry: 'trilc-chat' };
    if (isLocal) {
      const localPath = await ask('主检出路径（如 D:/Code/ai/TriMetaverse）> ');
      if (!localPath) return { outcome: 'error', detail: 'localPath required' };
      payload.localPath = resolve(localPath.trim());
      targetPath = await ask('worktree 落点（空目录或不存在；不落主检出检出内）> ');
      if (!targetPath) return { outcome: 'error', detail: 'targetPath required' };
      payload.targetPath = resolve(targetPath.trim());
    } else {
      const repoUrl = await ask('仓库 URL（白名单校验；https/ssh 均可）> ');
      if (!repoUrl) return { outcome: 'error', detail: 'repoUrl required' };
      payload.repoUrl = repoUrl.trim();
      const cloneTarget = await ask('克隆主检出落点（回车 = ~/trilc-projects/<key>）> ');
      if (cloneTarget.trim()) payload.targetPath = resolve(cloneTarget.trim());
    }
    console.log(`[trilc:init] 提交 link（${isLocal ? 'local' : 'github'} 源）— daemon 端点执行（git 单身份），进度经 init:project-link-* 事件族…`);
    const linkRes = await postJson(port, '/internal/v1/projects/link', payload);
    if (linkRes.status === 200) {
      const r = linkRes.json;
      console.log(`[trilc:init] 项目链路建立完成：${r.projectKey} / ${r.branch}`);
      console.log(`  worktree 落点：${r.worktreePath}`);
      console.log('  PROJECT-LINK 已 linked — 请在 TriPilot 打开该 worktree 目录继续（同步阶段归后续流程）。');
      return { outcome: 'skipped', detail: 'project-link linked' };
    }
    if (linkRes.status === 409 && linkRes.json?.chainState) {
      console.log(`[trilc:init] 当前链路状态不允许 project-link（${linkRes.json?.chainState}）— 请先完成前置阶段。`);
      return { outcome: 'error', detail: `link 409: ${linkRes.json?.chainState}` };
    }
    if (linkRes.status === 409 && linkRes.json?.busy) {
      console.log('[trilc:init] 链路执行中（单执行体互斥）— 稍后重试。');
      return { outcome: 'error', detail: 'link busy' };
    }
    console.log(
      `[trilc:init] link 失败（http ${linkRes.status}，分类=${linkRes.json?.classification ?? 'unknown'}）：` +
        `${linkRes.json?.message ?? linkRes.json?.error ?? 'unknown'}${linkRes.json?.rollback ? `（回滚=${linkRes.json?.rollback}）` : ''}`,
    );
    return { outcome: 'error', detail: `link ${linkRes.status}: ${linkRes.json?.classification ?? ''}` };
  }
  if (choice === '3') {
    const claimPath = await ask('要认领的目录路径（已是受管 worktree）> ');
    if (!claimPath.trim()) return { outcome: 'error', detail: 'path required' };
    const claimRes = await postJson(port, '/internal/v1/projects/claim', { path: resolve(claimPath.trim()) });
    if (claimRes.status === 200) {
      console.log(`[trilc:init] 认领完成：${claimRes.json?.projectKey} / ${claimRes.json?.branch} — PROJECT-LINK 已 linked。`);
      return { outcome: 'skipped', detail: 'project-link linked (claim)' };
    }
    console.log(`[trilc:init] 认领失败（http ${claimRes.status}）：${claimRes.json?.message ?? claimRes.json?.error ?? 'unknown'}`);
    return { outcome: 'error', detail: `claim ${claimRes.status}` };
  }
  return { outcome: 'skipped', detail: 'project-link flow skipped' };
}

// ── sync 流程（I4 增量：五维同步状态呈现 + 触发问答 + applied 收敛轮询；
// 零本地执行——不写文件、不执行 git、不生成 bundle，只渲染 + 发 daemon
// 端点指令）──

const SYNC_DIM_LABELS: Record<string, string> = {
  company: '公司',
  model: '模型',
  keys: '密钥（仅指纹）',
  employees: '员工',
  project: '项目',
};

function renderSyncStatus(status: SyncStatusPayload): string {
  const lines: string[] = [];
  const phase = status.phaseDetail?.status ?? 'pending';
  const local = status.localBundleId ? status.localBundleId.slice(0, 8) : null;
  lines.push(`  链态：${status.chainState}（sync=${phase}${local ? `，bundle=${local}` : ''}）`);
  if (status.remote) {
    const applied = status.remote.appliedBundleId ? status.remote.appliedBundleId.slice(0, 8) : null;
    const head = status.remote.fleetHead?.commit.slice(0, 8) ?? '?';
    lines.push(
      `  服务器面：${status.remote.reachable ? '可达' : '不可达'}${applied ? `，已应用 bundle=${applied}` : '，未应用'}` +
        `（fleetHead=${head}）`,
    );
  } else {
    lines.push('  服务器面：不可达（同步仍可推送，applied 收敛由 fleet 每 15min 拉取）');
  }
  return lines.join('\n');
}

async function runSyncFlow(port: number): Promise<InitCliFlowResult> {
  // 状态呈现（诊断数据源 = daemon sync/status）
  const statusRes = await getJson<SyncStatusPayload>(port, '/internal/v1/init/sync/status');
  if (statusRes.status !== 200 || !statusRes.json) {
    return { outcome: 'error', detail: `sync/status 不可用（http ${statusRes.status}）— daemon 同步端点未就绪` };
  }
  console.log(renderSyncStatus(statusRes.json));

  const trigger = await ask('输入 s 触发五维同步（其他键跳过进入聊天）> ');
  if (trigger.toLowerCase() !== 's') {
    return { outcome: 'skipped', detail: 'sync not triggered（面板常驻「待补」入口，随时可重跑 sync/run）' };
  }

  console.log('[trilc:init] 提交同步（entry=trilc-chat）— daemon 端点执行（git 固定身份 + 双远端 push），进度经 init:sync-* 事件族…');
  const runRes = await postJson(port, '/internal/v1/init/sync/run', { entry: 'trilc-chat' });
  const body = runRes.json as SyncRunPayload | null;
  if (runRes.status === 200 && body) {
    console.log('\n[trilc:init] 五维同步完成（bundle 已生成 + 已推送）：');
    const dims = body.dims ?? {};
    for (const dim of ['company', 'model', 'keys', 'employees', 'project']) {
      const state = dims[dim] ?? 'synced';
      const mark = state === 'unavailable' ? '[降级]' : '[OK]';
      console.log(`  ${mark} ${SYNC_DIM_LABELS[dim] ?? dim}：${state}`);
    }
    console.log(`  bundleId：${body.bundleId?.slice(0, 8)}…（${body.rePushedOnly ? '内容未变，纯重推' : '新生成'}）`);
    // applied 收敛轮询（fleet 每 15min apply；同步提交即探针，无需额外文件）
    console.log('[trilc:init] 等待服务器 applied 收敛（每 5s 轮询，最多 90s）…');
    let waited = 0;
    while (waited < 90_000) {
      await new Promise((r) => setTimeout(r, 5_000));
      waited += 5_000;
      const poll = await getJson<SyncStatusPayload>(port, '/internal/v1/init/sync/status');
      const remote = poll.json?.remote;
      if (remote?.reachable && remote.appliedBundleId && poll.json?.localBundleId === remote.appliedBundleId) {
        console.log('[trilc:init] 服务器已应用同 bundleId — SYNC 全链闭环（协同确认卡可继续）。');
        return { outcome: 'skipped', detail: 'sync applied' };
      }
      if (poll.json?.chainState === 'confirm') continue; // 已转移 confirm，继续等 applied
    }
    console.log('[trilc:init] 已推送待应用（fleet 每 15min 拉取收敛；稍后在确认卡查看）。');
    return { outcome: 'skipped', detail: 'sync pushed, applied pending' };
  }
  if (runRes.status === 409 && body?.busy) {
    console.log('[trilc:init] 同步进行中（单执行体互斥）— 稍后重试同一入口。');
    return { outcome: 'error', detail: 'sync busy' };
  }
  if (runRes.status === 409 && body?.chainState) {
    console.log(`[trilc:init] 当前链路状态不允许同步（${body.chainState}）— 请先完成前置阶段。`);
    return { outcome: 'error', detail: `sync 409: ${body.chainState}` };
  }
  if (body?.classification === 'company-not-initialized') {
    console.log('[trilc:init] 公司态未开张 — 请先完成 ONBOARDING 开张流程再同步。');
    return { outcome: 'error', detail: 'sync: company-not-initialized' };
  }
  if (body?.classification === 'project-not-linked' || body?.classification === 'project-link-not-linked') {
    console.log('[trilc:init] 项目链路未就绪 — 请先走 PROJECT-LINK 流程（link/claim）再同步。');
    return { outcome: 'error', detail: `sync: ${body.classification}` };
  }
  if (body?.retryable) {
    console.log(`[trilc:init] 同步可重试失败（${body.classification}）：${body.message ?? ''} — 重新提交同一入口即续跑（幂等重跑）。`);
    return { outcome: 'error', detail: `sync retryable: ${body.classification}` };
  }
  console.log(`[trilc:init] 同步失败（http ${runRes.status}）：${body?.message ?? body?.error ?? 'unknown'}`);
  return { outcome: 'error', detail: `sync ${runRes.status}` };
}

/**
 * chat 启动入口：chain/status 呈初始化阶段 → 文本化流程。
 * - selfcheck：诊断卡（blocked → 流程结束返回聊天；pass/degraded → 继续开张；
 *   未运行 → 提示可触发自检「r」并轮询结果）
 * - onboarding：结构化开张流程 → assemble 提交
 * - project-link：inspect 呈现 + 源选择问答 + POST link/claim（零本地执行）
 * - sync：五维同步状态呈现 + 触发问答 + POST sync/run + applied 收敛轮询
 * - confirm：打印当前阶段提示，返回聊天（Phase D 确认卡承接）
 * - ready / uninitialized：跳过（普通聊天）
 */
export async function runInitCliFlow(port: number): Promise<InitCliFlowResult> {
  const statusRes = await getJson<ChainStatusPayload>(port, '/internal/v1/init/chain/status');
  if (!statusRes.json || statusRes.status !== 200) {
    return { outcome: 'error', detail: `chain/status 不可用（http ${statusRes.status}）` };
  }
  const status = statusRes.json;
  const selfcheck = status.phaseDetail?.selfcheck;

  switch (status.chainState) {
    case 'selfcheck': {
      console.log('\n[trilc:init] 初始化阶段：SELFCHECK（自检）');
      console.log(renderSelfcheckCard(selfcheck));
      if (selfcheck?.summary === 'blocked') {
        console.log('[trilc:init] 自检阻塞 — 修复后重新运行自检；key 类失败降级继续口径见诊断卡。');
        return { outcome: 'blocked', detail: 'selfcheck blocked' };
      }
      if (selfcheck?.summary === 'pass' || selfcheck?.summary === 'degraded') {
        console.log('[trilc:init] 自检已完结 — 进入公司开张流程。');
        return runOnboardingFlow(port);
      }
      const trigger = await ask('自检未运行 — 输入 r 触发自检（其他键跳过进入聊天）> ');
      if (trigger.toLowerCase() === 'r') {
        const runRes = await postJson(port, '/internal/v1/init/selfcheck/run', {});
        if (runRes.status !== 202) {
          console.log(`[trilc:init] 自检触发失败（http ${runRes.status}）：${JSON.stringify(runRes.json)}`);
          return { outcome: 'error', detail: `selfcheck run ${runRes.status}` };
        }
        console.log('[trilc:init] 自检运行中（含第五探测真实模型会话，约 30-90s）…');
        let waited = 0;
        while (waited < 180_000) {
          await new Promise((r) => setTimeout(r, 5_000));
          waited += 5_000;
          const poll = await getJson<ChainStatusPayload>(port, '/internal/v1/init/chain/status');
          const sc = poll.json?.phaseDetail?.selfcheck;
          if (sc?.finishedAt) {
            console.log(renderSelfcheckCard(sc));
            if (sc.summary === 'blocked') {
              return { outcome: 'blocked', detail: 'selfcheck blocked' };
            }
            // A' 裁决：自检完结（pass/degraded）→ daemon 已自动推进 onboarding，
            // 直接进入开张流程（链态仍 selfcheck 的极端延迟给一次短等待重查）。
            if (poll.json?.chainState === 'onboarding') {
              return runOnboardingFlow(port);
            }
            await new Promise((r) => setTimeout(r, 2_000));
            const again = await getJson<ChainStatusPayload>(port, '/internal/v1/init/chain/status');
            if (again.json?.chainState === 'onboarding') {
              return runOnboardingFlow(port);
            }
            console.log('[trilc:init] 自检完成但链路未推进 — 返回聊天。');
            return { outcome: 'error', detail: 'chain did not advance after selfcheck' };
          }
        }
        console.log('[trilc:init] 自检轮询超时 — 返回聊天。');
        return { outcome: 'error', detail: 'selfcheck poll timeout' };
      }
      return { outcome: 'skipped', detail: 'selfcheck not triggered' };
    }
    case 'onboarding':
      console.log('\n[trilc:init] 初始化阶段：ONBOARDING（公司开张）');
      return runOnboardingFlow(port);
    case 'project-link':
      console.log('\n[trilc:init] 初始化阶段：PROJECT-LINK（项目面初始化）');
      return runProjectLinkFlow(port);
    case 'sync':
      console.log('\n[trilc:init] 初始化阶段：SYNC（五维同步）');
      return runSyncFlow(port);
    case 'confirm':
      console.log('\n[trilc:init] 初始化阶段：CONFIRM（协同确认）— 由后续流程承接，进入聊天。');
      return { outcome: 'skipped', detail: 'confirm phase' };
    default:
      // ready / uninitialized：普通聊天
      return { outcome: 'skipped', detail: `chainState=${status.chainState}` };
  }
}
