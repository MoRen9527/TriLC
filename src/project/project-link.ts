// ── Project Link / Claim / Inspect 执行体 ──
// design-v2 §五.1 链路五步（检测→关联判定→认领→建立→去重）+ 注入/验证落地
// （i3-1 拆解 §二端点契约）：daemon 端点单执行体（git 单身份，OBS-20260814-002），
// TriPilot / trilc chat 两入口只发指令。
//
// link 六步原子序（同一请求内完成，无独立热更新端点）：
//   1 检测     目标路径形态判别（不存在/空目录/.git 文件/.git 目录/非 git）
//   2 关联判定 remote origin URL ↔ 白名单规范化比对（https/ssh 同仓等价）
//   3 门禁     hasNpmFileDeps 标记仓拒绝自动 add（INCIDENT-20260814-001 纪律）
//   4a 认领   目标已是本仓 worktree → 只登记，绝不重复 add（认领路径零 git 写）
//   4b 建立   本地源：git worktree add <target> -b project/<key>；
//             GitHub 源：白名单比对 → clone 建主 checkout（凭据走 git 系统
//             凭据管理器，密钥永不进代码）→ 登记 mainCheckoutPath → 转本地链路
//   5 登记去重 注册点原子登记（主键去重）+ git worktree list 交叉验证
//   6 链态更新 init-chain project-link 阶段快照（status=linked）+ init:*
//             事件族 + 内存态热更新同一请求内
//
// 失败分类 + 回滚：4b 建立之后任一失败 → worktree remove（非 --force——全仓禁用
// --force，INCIDENT-20260814-001 教训）+ 注册点登记移除；认领路径零 git/项目
// 磁盘写（注册点/链态元数据写除外——「认领登记」契约本身）。
//
// 链态门：link/claim 仅 chainState='project-link' 生效，其他态 409 { chainState }
// （转移仅经 transitionTo 线性表，本树不转出 project-link；→sync 归 I4）。
// inspect 为只读判定接口（识别分流，design-v2 §2.5），不受链态门限制。

import { execFile } from 'node:child_process';
import { lstat, readdir, stat } from 'node:fs/promises';
import { resolve, normalize, join, isAbsolute, relative } from 'node:path';
import { homedir } from 'node:os';
import type { LocalBusEvent } from '../localbus/bus.js';
import type { ChainState, InitChain, ProjectLinkPhase } from '../company/init-chain.js';
import { ProjectRegistry, type RegistryProjectEntry } from './project-registry.js';

// ── Types ──

export interface GitExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => Promise<GitExecResult>;

/** git 单执行体（daemon 端点内单身份）：execFile 无 shell，参数数组零注入面。 */
export function createGitRunner(): GitRunner {
  return (args, opts) =>
    new Promise((resolvePromise) => {
      execFile(
        'git',
        args,
        {
          cwd: opts?.cwd,
          timeout: opts?.timeoutMs ?? 30_000,
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            const errCode = (error as NodeJS.ErrnoException & { code?: unknown }).code;
            const code = typeof errCode === 'number' ? errCode : -1;
            resolvePromise({
              code,
              stdout: String(stdout),
              stderr: `${(error as Error).message} ${String(stderr)}`.trim(),
            });
          } else {
            resolvePromise({ code: 0, stdout: String(stdout), stderr: String(stderr) });
          }
        },
      );
    });
}

export type LinkSource = 'local' | 'github';
export type LinkEntry = 'tripilot' | 'trilc-chat' | 'daemon';

export interface LinkRequest {
  source: LinkSource;
  localPath?: string;
  repoUrl?: string;
  targetPath?: string;
  entry: LinkEntry;
}

/** SSE 事件族 step 枚举（i3-1 §三）。 */
export const LINK_STEPS = [
  'detect',
  'match',
  'gate',
  'claim',
  'clone',
  'worktree-add',
  'register',
  'chain-update',
] as const;
export type LinkStep = (typeof LINK_STEPS)[number];

export type LinkFailureClassification =
  | 'not-a-git-repo'
  | 'target-invalid'
  | 'not-whitelisted'
  | 'gate-blocked'
  | 'worktree-owned-elsewhere'
  | 'clone-failed'
  | 'branch-conflict'
  | 'worktree-add-failed'
  | 'register-failed'
  | 'chain-update-failed';

export type ProjectLinkResult =
  | {
      status: 200;
      runId: string;
      projectKey: string;
      worktreePath: string;
      branch: string;
      chainState: 'project-link';
    }
  | { status: 409; busy: true; runId: string }
  | { status: 409; chainState: ChainState }
  | {
      status: 422 | 500;
      error: string;
      classification: LinkFailureClassification | 'busy' | 'chain-state';
      message: string;
      runId: string;
      rollback?: 'completed' | 'failed' | 'not-needed';
    };

export interface ProjectLinkDeps {
  registry: ProjectRegistry;
  chain: InitChain;
  publish: (event: LocalBusEvent) => void;
  /** git 执行器（测试注入 mock；默认 createGitRunner）。 */
  git?: GitRunner;
  /** GitHub 源克隆默认落点根（默认 ~/trilc-projects）。 */
  cloneRoot?: string;
  /** 测试注入点：注册点登记抛错（回滚单测）。 */
  failRegister?: boolean;
  /** 测试注入点：链态快照抛错（注册点回滚 + worktree remove 单测）。 */
  failChainUpdate?: boolean;
}

// ── 防重入互斥（单执行体）──

let _linking = false;
let _activeLinkRunId: string | null = null;

export function isLinking(): boolean {
  return _linking;
}

/** 测试复位。 */
export function resetLinkForTest(): void {
  _linking = false;
  _activeLinkRunId = null;
}

function newRunId(): string {
  return `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// ── URL 规范化（白名单比对：https/ssh 同仓等价，去尾 .git，主机+路径小写）──

export function normalizeGitUrl(url: string): string {
  let u = url.trim();
  // scp 形态（git@host:path）；排除协议形态（https://、ssh://…）
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) {
    const scp = u.match(/^(?:[^@/]+@)?([^:]+):(.+)$/);
    if (scp) u = `${scp[1]}/${scp[2]}`;
  }
  u = u
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  return u.toLowerCase();
}

// ── 载荷校验（纯函数）──

export type LinkPayloadValidation =
  | { ok: true; request: LinkRequest }
  | { ok: false; error: string; message: string };

export function validateLinkPayload(body: unknown): LinkPayloadValidation {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'bad_request', message: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  const source = b.source;
  if (source !== 'local' && source !== 'github') {
    return { ok: false, error: 'bad_request', message: "source must be 'local' or 'github'" };
  }
  const entry = b.entry === undefined ? 'daemon' : b.entry;
  if (entry !== 'tripilot' && entry !== 'trilc-chat' && entry !== 'daemon') {
    return { ok: false, error: 'bad_request', message: "entry must be 'tripilot' | 'trilc-chat' | 'daemon'" };
  }
  const localPath = typeof b.localPath === 'string' ? b.localPath.trim() : '';
  const repoUrl = typeof b.repoUrl === 'string' ? b.repoUrl.trim() : '';
  const targetPath = typeof b.targetPath === 'string' ? b.targetPath.trim() : '';

  if (source === 'local') {
    // local 源：localPath = 主检出路径；targetPath = worktree 落点（均必填绝对路径）
    if (!localPath) {
      return { ok: false, error: 'bad_request', message: 'localPath is required for local source' };
    }
    if (!isAbsolute(localPath)) {
      return { ok: false, error: 'bad_request', message: 'localPath must be an absolute path' };
    }
    if (!targetPath) {
      return { ok: false, error: 'bad_request', message: 'targetPath (worktree 落点) is required for local source' };
    }
    if (!isAbsolute(targetPath)) {
      return { ok: false, error: 'bad_request', message: 'targetPath must be an absolute path' };
    }
    return { ok: true, request: { source, localPath: normalize(localPath), targetPath: normalize(targetPath), entry } };
  }
  // github 源：repoUrl = 链接源；targetPath = 克隆主检出落点（可选，默认 cloneRoot/<key>）
  if (!repoUrl) {
    return { ok: false, error: 'bad_request', message: 'repoUrl is required for github source' };
  }
  if (targetPath && !isAbsolute(targetPath)) {
    return { ok: false, error: 'bad_request', message: 'targetPath must be an absolute path' };
  }
  return {
    ok: true,
    request: {
      source,
      repoUrl,
      ...(targetPath ? { targetPath: normalize(targetPath) } : {}),
      entry,
    },
  };
}

export type ClaimPayloadValidation =
  | { ok: true; path: string }
  | { ok: false; error: string; message: string };

export function validateClaimPayload(body: unknown): ClaimPayloadValidation {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'bad_request', message: 'body must be a JSON object' };
  }
  const path = (body as Record<string, unknown>).path;
  if (typeof path !== 'string' || !path.trim()) {
    return { ok: false, error: 'bad_request', message: 'path is required' };
  }
  if (!isAbsolute(path.trim())) {
    return { ok: false, error: 'bad_request', message: 'path must be an absolute path' };
  }
  return { ok: true, path: normalize(path.trim()) };
}

// ── 路径关系工具 ──

/** p 是否在 dir 内（含相等）。 */
function isInside(p: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// ── 步骤 1/4a 检测与认领判定（.git 文件/目录形态判别）──

interface TargetDetection {
  kind: 'absent' | 'empty-dir' | 'worktree' | 'git-repo' | 'non-git-dir';
  /** worktree 形态时：git rev-parse --absolute-git-dir 实测值。 */
  gitdir?: string;
  /** worktree 形态时：属主主检出路径（gitdir 剥 /worktrees/<name> 再剥 /.git）。 */
  ownerMainPath?: string;
}

async function detectTarget(deps: ProjectLinkDeps, targetPath: string): Promise<TargetDetection> {
  const git = deps.git ?? createGitRunner();
  let st;
  try {
    st = await stat(targetPath);
  } catch {
    return { kind: 'absent' };
  }
  if (!st.isDirectory()) return { kind: 'non-git-dir' };
  let dotGit;
  try {
    dotGit = await lstat(join(targetPath, '.git'));
  } catch {
    // 无 .git：空目录（可落点）或非 git 目录
    const entries = await readdir(targetPath).catch(() => ['.']);
    return entries.length === 0 ? { kind: 'empty-dir' } : { kind: 'non-git-dir' };
  }
  if (dotGit.isFile()) {
    // .git 文件 = worktree 形态
    const gitdirRes = await git(['rev-parse', '--absolute-git-dir'], { cwd: targetPath });
    if (gitdirRes.code !== 0) return { kind: 'non-git-dir' };
    const gitdir = normalize(gitdirRes.stdout.trim());
    const ownerMainPath = worktreeOwnerMainPath(gitdir);
    return { kind: 'worktree', gitdir, ...(ownerMainPath ? { ownerMainPath } : {}) };
  }
  if (dotGit.isDirectory()) return { kind: 'git-repo' };
  return { kind: 'non-git-dir' };
}

/** gitdir（<main>/.git/worktrees/<name>）→ 属主主检出路径（<main>）；非 worktree 形态返回 null。 */
function worktreeOwnerMainPath(gitdir: string): string | null {
  const m = gitdir.match(/^(.+)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/);
  return m ? m[1] : null;
}

/** gitdir 属主仓判定：主检出 remote origin 规范化后命中项目白名单 → projectKey。 */
async function matchWorktreeOwner(
  deps: ProjectLinkDeps,
  ownerMainPath: string,
): Promise<string | null> {
  const git = deps.git ?? createGitRunner();
  const remoteRes = await git(['-C', ownerMainPath, 'remote', 'get-url', 'origin']);
  if (remoteRes.code !== 0) return null;
  return matchWhitelist(await deps.registry.load(), remoteRes.stdout.trim());
}

/** URL 白名单比对（规范化同仓等价）：命中 → projectKey；未命中 → null。 */
function matchWhitelist(frame: ReturnType<ProjectRegistry['getSnapshot']>, url: string): string | null {
  const needle = normalizeGitUrl(url);
  for (const [key, project] of Object.entries(frame.projects)) {
    if (normalizeGitUrl(project.repoUrl) === needle) return key;
  }
  return null;
}

// ── 步骤 5 交叉验证：git worktree list --porcelain 与注册点比对 ──

/** 解析 git worktree list --porcelain → { worktree 绝对路径: branch }。 */
function parseWorktreeList(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  let path: string | null = null;
  let branch: string | null = null;
  const flush = () => {
    if (path) map.set(normalize(path), branch ?? 'detached');
    path = null;
    branch = null;
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim();
    else if (line.startsWith('branch ')) branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    else if (line.trim() === '') flush();
  }
  flush();
  return map;
}

/**
 * 注册点有而 git 无 → 登记移除（幽灵项，不删磁盘）；git 有而注册点无 →
 * 不动作（未认领 worktree 属正常态，design-v2 §六）。
 * 多主检出纪律：仅校验 gitdir 属主 = 本主检出（mainPath）的登记项——他主
 * worktree 不出现在本主 git worktree list 属正常，不得误判为幽灵项。
 */
async function crossValidateWithGit(
  deps: ProjectLinkDeps,
  projectKey: string,
  mainPath: string,
): Promise<void> {
  const git = deps.git ?? createGitRunner();
  const listRes = await git(['-C', mainPath, 'worktree', 'list', '--porcelain']);
  if (listRes.code !== 0) return; // 交叉验证失败不阻塞（登记真源仍以注册点为准）
  const live = parseWorktreeList(listRes.stdout);
  const frame = await deps.registry.load();
  const project = frame.projects[projectKey];
  if (!project) return;
  const mainWorktreesGitdir = normalize(join(mainPath, '.git', 'worktrees'));
  for (const wt of [...project.worktrees]) {
    if (!isInside(normalize(wt.gitdir), mainWorktreesGitdir)) continue; // 他主检出登记项跳过
    if (!live.has(normalize(wt.path))) {
      console.log(
        `[trilc:project] cross-validate: registry entry not in git worktree list — dropping registration for ${wt.path}（不删磁盘）`,
      );
      await deps.registry.unregisterWorktree(projectKey, wt.path);
    }
  }
}

// ── 事件发布 ──

function publishStep(deps: ProjectLinkDeps, runId: string, step: LinkStep, status: string, detail: string): void {
  deps.publish({ type: 'init:project-link-progress', runId, step, status, detail });
}

// ── link 执行体 ──

export async function runLink(deps: ProjectLinkDeps, req: LinkRequest): Promise<ProjectLinkResult> {
  if (_linking) return { status: 409, busy: true, runId: _activeLinkRunId ?? '' };
  _linking = true;
  _activeLinkRunId = newRunId();
  const runId = _activeLinkRunId;
  try {
    return await doLink(deps, req, runId);
  } finally {
    _linking = false;
    _activeLinkRunId = null;
  }
}

async function doLink(deps: ProjectLinkDeps, req: LinkRequest, runId: string): Promise<ProjectLinkResult> {
  const git = deps.git ?? createGitRunner();
  const chainFrame = await deps.chain.load();
  const state = chainFrame.chainState;
  // 链态门：仅 project-link 生效（转移仅经 transitionTo 线性表）
  if (state !== 'project-link') {
    return { status: 409, chainState: state };
  }

  const fail = (
    classification: LinkFailureClassification,
    message: string,
  ): Extract<ProjectLinkResult, { status: 422 | 500 }> => ({
    status: classification === 'register-failed' || classification === 'chain-update-failed' ? 500 : 422,
    error: classification,
    classification,
    message,
    runId,
  });

  /** 失败即发 failed 进度事件（向导 Step 4 失败反馈渲染源）。 */
  const failAnd = (
    step: LinkStep,
    classification: LinkFailureClassification,
    message: string,
  ): Extract<ProjectLinkResult, { status: 422 | 500 }> => {
    publishStep(deps, runId, step, 'failed', `${classification}: ${message}`);
    return fail(classification, message);
  };

  // ── 步骤 1 检测 + 步骤 2 关联判定 + 步骤 3 门禁 ──
  // local 源按契约顺序 detect → match → gate；github 源 match 先行（克隆默认
  // 落点 cloneRoot/<key> 依赖 key，语义不变）。
  const frame = await deps.registry.load();
  let projectKey: string;
  let project: RegistryProjectEntry;
  let mainPath: string;
  let targetPath: string;
  let targetDetection: TargetDetection;

  if (req.source === 'github') {
    // 步骤 2 关联判定（URL 规范化白名单比对）
    const key = matchWhitelist(frame, req.repoUrl!);
    if (!key) {
      return failAnd('match', 'not-whitelisted', `repoUrl 未命中项目仓白名单（${req.repoUrl}）— 拒绝自动流程，防克隆非项目仓`);
    }
    projectKey = key;
    project = frame.projects[projectKey];
    // 步骤 1 检测（克隆落点）
    const cloneTarget = req.targetPath ?? join(deps.cloneRoot ?? join(homedir(), 'trilc-projects'), projectKey);
    deps.publish({ type: 'init:project-link-started', runId, source: req.source, targetPath: cloneTarget });
    publishStep(deps, runId, 'detect', 'ok', `detect clone target ${cloneTarget}`);
    targetDetection = await detectTarget(deps, cloneTarget);
    if (targetDetection.kind !== 'absent' && targetDetection.kind !== 'empty-dir') {
      return failAnd('detect', 'target-invalid', `克隆落点非空（${cloneTarget}，形态=${targetDetection.kind}）— 请换空目录或指定 targetPath`);
    }
    publishStep(deps, runId, 'match', 'ok', `whitelist matched project=${projectKey}`);
    // 步骤 3 门禁
    if (project.hasNpmFileDeps) {
      return failAnd('gate', 'gate-blocked', `项目仓 ${projectKey} 标记 hasNpmFileDeps — 拒绝自动 worktree add（node_modules junction 级联风险），请手动评估`);
    }
    publishStep(deps, runId, 'gate', 'ok', `hasNpmFileDeps=${project.hasNpmFileDeps}`);
    // 步骤 4 建立（GitHub 源）：克隆建主 checkout（凭据走 git 系统凭据管理器）
    publishStep(deps, runId, 'clone', 'ok', `clone ${req.repoUrl} → ${cloneTarget}（凭据走 git 系统凭据管理器）`);
    const cloneRes = await git(['clone', req.repoUrl!, cloneTarget], { timeoutMs: 600_000 });
    if (cloneRes.code !== 0) {
      const errText = `${cloneRes.stderr} ${cloneRes.stdout}`.trim().slice(0, 300);
      return failAnd('clone', 'clone-failed', `克隆失败（${errText}）— 检查网络/凭据（git 系统凭据管理器）后可重试，或改走 local 源`);
    }
    // 默认分支对齐（defaultBranch 与远端实际分支一致才 checkout）
    const headRes = await git(['-C', cloneTarget, 'rev-parse', '--abbrev-ref', 'HEAD']);
    if (headRes.code === 0 && headRes.stdout.trim() !== project.defaultBranch) {
      const coRes = await git(['-C', cloneTarget, 'checkout', project.defaultBranch]);
      if (coRes.code !== 0) {
        // defaultBranch 不存在于远端 → 保持 clone 默认分支（不阻塞；登记真源记录实际分支）
        console.log(`[trilc:project] defaultBranch ${project.defaultBranch} checkout failed — keep clone default: ${coRes.stderr}`);
      }
    }
    try {
      await deps.registry.setMainCheckout(projectKey, cloneTarget);
    } catch (err) {
      return failAnd('clone', 'register-failed', `主检出登记失败：${(err as Error).message}`);
    }
    mainPath = cloneTarget;
    // 转本地链路：worktree 落点 = 主检出同级 <cloneTarget>-worktree（派生落点恒不存在，免复检）
    targetPath = `${cloneTarget}-worktree`;
    targetDetection = { kind: 'absent' };
  } else {
    // 步骤 1 检测（目标路径形态判别）
    targetPath = req.targetPath!;
    deps.publish({ type: 'init:project-link-started', runId, source: req.source, targetPath });
    publishStep(deps, runId, 'detect', 'ok', `detect target ${targetPath}`);
    targetDetection = await detectTarget(deps, targetPath);
    if (targetDetection.kind !== 'absent' && targetDetection.kind !== 'empty-dir' && targetDetection.kind !== 'worktree') {
      const kindZh = targetDetection.kind === 'git-repo' ? '已是 git 仓' : '普通文件夹';
      return failAnd('detect', 'target-invalid', `目标路径 ${targetPath} ${kindZh}（形态=${targetDetection.kind}）— worktree 落点须为空目录或不存在`);
    }
    // 步骤 2 关联判定（主检出 remote origin ↔ 白名单）
    publishStep(deps, runId, 'match', 'ok', `match remote origin of ${req.localPath}`);
    const remoteRes = await git(['-C', req.localPath!, 'remote', 'get-url', 'origin']);
    if (remoteRes.code !== 0) {
      return failAnd('match', 'not-whitelisted', `localPath 无 origin remote（${remoteRes.stderr || 'git 失败'}）— 拒绝自动流程`);
    }
    const key = matchWhitelist(frame, remoteRes.stdout.trim());
    if (!key) {
      return failAnd('match', 'not-whitelisted', `remote origin 未命中项目仓白名单（${remoteRes.stdout.trim()}）— 拒绝自动流程，防克隆非项目仓`);
    }
    projectKey = key;
    project = frame.projects[projectKey];
    // 步骤 3 门禁
    if (project.hasNpmFileDeps) {
      return failAnd('gate', 'gate-blocked', `项目仓 ${projectKey} 标记 hasNpmFileDeps — 拒绝自动 worktree add（node_modules junction 级联风险），请手动评估`);
    }
    publishStep(deps, runId, 'gate', 'ok', `hasNpmFileDeps=${project.hasNpmFileDeps}`);
    // 本地源：主检出 = localPath（步骤 2 已验证 remote 白名单）；登记运行态
    try {
      await deps.registry.setMainCheckout(projectKey, req.localPath!);
    } catch (err) {
      return failAnd('match', 'register-failed', `主检出登记失败：${(err as Error).message}`);
    }
    mainPath = req.localPath!;
  }

  // 落点校验（i3-1 §二 4b：不落主 checkout 检出内、不与其他 worktree 重叠）
  if (targetDetection.kind !== 'worktree' && isInside(targetPath, mainPath)) {
    return failAnd('detect', 'target-invalid', `worktree 落点不得在主检出检出内（${targetPath} ⊂ ${mainPath}）`);
  }
  for (const wt of project.worktrees) {
    if (normalize(wt.path) === normalize(targetPath)) continue; // 同 worktree → 4a 认领路径（绝不重复 add）
    if (isInside(targetPath, wt.path) || isInside(wt.path, targetPath)) {
      return failAnd('detect', 'target-invalid', `worktree 落点与其他 worktree 重叠（${targetPath} ↔ ${wt.path}）`);
    }
  }

  // 步骤 4a 认领：目标已是本仓 worktree → 只登记，绝不重复 add
  let worktreePath = targetPath;
  let worktreeGitdir: string;
  let worktreeBranch: string;
  let worktreeAdded = false;
  if (targetDetection.kind === 'worktree') {
    const owner = targetDetection.ownerMainPath
      ? await matchWorktreeOwner(deps, targetDetection.ownerMainPath)
      : null;
    if (!owner) {
      return failAnd('claim', 'worktree-owned-elsewhere', `目标 ${targetPath} 的 gitdir 不属于项目仓（未命中白名单）— 拒绝认领`);
    }
    if (owner !== projectKey) {
      return failAnd('claim', 'worktree-owned-elsewhere', `目标 ${targetPath} 的 gitdir 属主仓为 ${owner}（非 ${projectKey}）— 拒绝认领`);
    }
    publishStep(deps, runId, 'claim', 'ok', `claim existing worktree ${targetPath}（绝不重复 add）`);
    worktreeGitdir = targetDetection.gitdir!;
    const branchRes = await git(['-C', targetPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
    worktreeBranch = branchRes.code === 0 ? branchRes.stdout.trim() : project.defaultBranch;
  } else {
    // 步骤 4b 建立：worktree add（分支规约：常驻分支 project/<key>）
    const branch = `project/${projectKey}`;
    publishStep(deps, runId, 'worktree-add', 'ok', `worktree add ${targetPath} -b ${branch}（from ${mainPath}）`);
    const addRes = await git(['-C', mainPath, 'worktree', 'add', targetPath, '-b', branch]);
    if (addRes.code !== 0) {
      // 分支已存在 → 检出既有分支；已被其他 worktree 检出 → branch-conflict
      if (/already exists/i.test(addRes.stderr)) {
        const coRes = await git(['-C', mainPath, 'worktree', 'add', targetPath, branch]);
        if (coRes.code !== 0) {
          const errText = coRes.stderr.slice(0, 300);
          return failAnd('worktree-add', 'branch-conflict', `分支 ${branch} 已被其他 worktree 检出（${errText}）— 请换落点或走新 feature 分支（P4 承接）`);
        }
      } else {
        const errText = addRes.stderr.slice(0, 300);
        return failAnd('worktree-add', 'worktree-add-failed', `worktree add 失败（${errText}）— 检查磁盘权限/落点状态`);
      }
    }
    worktreeAdded = true;
    const gitdirRes = await git(['-C', targetPath, 'rev-parse', '--absolute-git-dir']);
    if (gitdirRes.code !== 0) {
      await rollbackWorktree(deps, mainPath, targetPath, worktreeAdded);
      return { ...failAnd('worktree-add', 'worktree-add-failed', `worktree add 后 gitdir 解析失败（${gitdirRes.stderr}）`), rollback: 'completed' };
    }
    worktreeGitdir = normalize(gitdirRes.stdout.trim());
    const branchRes = await git(['-C', targetPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
    worktreeBranch = branchRes.code === 0 ? branchRes.stdout.trim() : branch;
  }

  // 步骤 5 登记去重（注册点原子登记 + git worktree list 交叉验证）
  publishStep(deps, runId, 'register', 'ok', `register worktree ${worktreePath}（主键去重）`);
  try {
    if (deps.failRegister) throw new Error('injected register failure');
    await deps.registry.registerWorktree(projectKey, {
      path: worktreePath,
      gitdir: worktreeGitdir,
      branch: worktreeBranch,
    });
    await crossValidateWithGit(deps, projectKey, mainPath);
  } catch (err) {
    const rollback = await rollbackWorktree(deps, mainPath, targetPath, worktreeAdded);
    return {
      ...failAnd('register', 'register-failed', `注册点登记失败：${(err as Error).message}`),
      rollback: !worktreeAdded ? 'not-needed' : rollback ? 'completed' : 'failed',
    };
  }

  // 步骤 6 链态更新（project-link 阶段快照 + 事件族 + 内存态热更新同请求）
  publishStep(deps, runId, 'chain-update', 'ok', `chain snapshot status=linked（projectKey=${projectKey}）`);
  try {
    if (deps.failChainUpdate) throw new Error('injected chain update failure');
    const patch: Partial<ProjectLinkPhase> = {
      status: 'linked',
      source: req.source,
      projectKey,
      worktreePath,
    };
    const frame = await deps.chain.updateProjectLink(patch);
    deps.publish({
      type: 'init:project-link-finished',
      runId,
      projectKey,
      worktreePath,
      branch: worktreeBranch,
      chainState: 'project-link',
      phaseDetail: frame.phaseDetail['project-link'],
    });
    deps.publish({
      type: 'init:step-event',
      phase: 'project-link',
      step: 'linked',
      entry: req.entry,
      payload: { runId, projectKey, worktreePath, branch: worktreeBranch },
    });
    return {
      status: 200,
      runId,
      projectKey,
      worktreePath,
      branch: worktreeBranch,
      chainState: 'project-link',
    };
  } catch (err) {
    // 链态失败 → 注册点回滚 + worktree remove（非 --force）
    let rollbackOk = true;
    try {
      await deps.registry.unregisterWorktree(projectKey, worktreePath);
    } catch (unregErr) {
      rollbackOk = false;
      console.error(`[trilc:project] rollback unregister failed: ${(unregErr as Error).message}`);
    }
    const removed = await rollbackWorktree(deps, mainPath, targetPath, worktreeAdded);
    if (!removed) rollbackOk = false;
    return {
      ...failAnd('chain-update', 'chain-update-failed', `链态快照更新失败：${(err as Error).message}`),
      rollback: rollbackOk ? 'completed' : 'failed',
    };
  }
}

/** worktree 回滚：非 --force remove（全仓禁用 --force，INCIDENT-20260814-001）。 */
async function rollbackWorktree(
  deps: ProjectLinkDeps,
  mainPath: string,
  targetPath: string,
  added: boolean,
): Promise<boolean> {
  if (!added) return true; // 未 add 无 worktree 可回滚
  const git = deps.git ?? createGitRunner();
  const res = await git(['-C', mainPath, 'worktree', 'remove', targetPath]);
  if (res.code !== 0) {
    console.error(
      `[trilc:project] rollback worktree remove failed（非 --force，保留现场待人工处理）：${targetPath} — ${res.stderr}`,
    );
    return false;
  }
  console.log(`[trilc:project] rollback: worktree removed（非 --force）：${targetPath}`);
  return true;
}

// ── claim 执行体（§4a 同构 + 认领登记；零 git/项目磁盘写）──

export type ClaimResult =
  | { status: 200; projectKey: string; branch: string; claimed: true }
  | { status: 409; chainState: ChainState }
  | { status: 422; error: string; kind: 'project-clone' | 'unlinked' | 'not-found'; message: string }
  | { status: 500; error: 'register-failed' | 'chain-update-failed'; message: string };

export async function runClaim(deps: ProjectLinkDeps, path: string): Promise<ClaimResult> {
  const chainFrame = await deps.chain.load();
  const state = chainFrame.chainState;
  if (state !== 'project-link') {
    return { status: 409, chainState: state };
  }
  const git = deps.git ?? createGitRunner();

  // 打开文件夹认领路径：仅受管 worktree（.git 文件 + gitdir 属主仓）可认领
  let st;
  try {
    st = await stat(path);
  } catch {
    return { status: 422, error: 'not_found', kind: 'not-found', message: `路径不存在：${path}` };
  }
  if (!st.isDirectory()) {
    return { status: 422, error: 'not_claimable', kind: 'unlinked', message: `路径不是目录：${path}` };
  }
  let dotGit;
  try {
    dotGit = await lstat(join(path, '.git'));
  } catch {
    return { status: 422, error: 'not_claimable', kind: 'unlinked', message: '目标不是 git 目录（未关联轻提示）' };
  }
  if (dotGit.isDirectory()) {
    // 项目仓普通克隆（.git 目录）→ 非受管 + 升级引导（不自动升级不强制）
    const remoteRes = await git(['-C', path, 'remote', 'get-url', 'origin']);
    const key = remoteRes.code === 0 ? matchWhitelist(await deps.registry.load(), remoteRes.stdout.trim()) : null;
    if (key) {
      return {
        status: 422,
        error: 'not_a_worktree',
        kind: 'project-clone',
        message: `项目仓普通克隆（${key}）非受管 worktree — 升级引导：走 link 流程建立受管 worktree`,
      };
    }
    return { status: 422, error: 'not_claimable', kind: 'unlinked', message: '其他 git 仓（未命中项目仓白名单）' };
  }
  if (!dotGit.isFile()) {
    return { status: 422, error: 'not_claimable', kind: 'unlinked', message: '目标无 .git 形态（未关联轻提示）' };
  }

  // worktree 形态：gitdir 属主仓判定（认领绝不重复 add，零 git 写）
  const gitdirRes = await git(['rev-parse', '--absolute-git-dir'], { cwd: path });
  if (gitdirRes.code !== 0) {
    return { status: 422, error: 'not_claimable', kind: 'unlinked', message: `gitdir 解析失败（${gitdirRes.stderr}）` };
  }
  const gitdir = normalize(gitdirRes.stdout.trim());
  const ownerMainPath = worktreeOwnerMainPath(gitdir);
  if (!ownerMainPath) {
    return { status: 422, error: 'not_a_worktree', kind: 'project-clone', message: 'gitdir 非 worktree 形态（主检出不可认领为 worktree）' };
  }
  const projectKey = await matchWorktreeOwner(deps, ownerMainPath);
  if (!projectKey) {
    return { status: 422, error: 'not_claimable', kind: 'unlinked', message: 'worktree 属主仓未命中项目仓白名单' };
  }
  const branchRes = await git(['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchRes.code === 0 ? branchRes.stdout.trim() : '';

  // 认领登记（主键去重幂等）+ 链态快照（§4a 同构 = 只登记 + 链态尾）
  try {
    await deps.registry.registerWorktree(projectKey, { path, gitdir, branch });
  } catch (err) {
    return { status: 500, error: 'register-failed', message: `认领登记失败：${(err as Error).message}` };
  }
  try {
    await deps.chain.updateProjectLink({
      status: 'linked',
      source: 'local',
      projectKey,
      worktreePath: path,
    });
  } catch (err) {
    return { status: 500, error: 'chain-update-failed', message: `链态快照更新失败：${(err as Error).message}` };
  }
  return { status: 200, projectKey, branch, claimed: true };
}

// ── inspect 执行体（识别分流判定接口；只读，不受链态门限制）──

export type InspectKind = 'managed-worktree' | 'project-clone' | 'unlinked';

export interface InspectResult {
  kind: InspectKind;
  projectKey?: string;
  branch?: string;
  worktree: boolean;
}

export async function inspectPath(deps: ProjectLinkDeps, path: string): Promise<InspectResult> {
  const git = deps.git ?? createGitRunner();
  const unlinked: InspectResult = { kind: 'unlinked', worktree: false };
  let st;
  try {
    st = await stat(path);
  } catch {
    return unlinked;
  }
  if (!st.isDirectory()) return unlinked;
  let dotGit;
  try {
    dotGit = await lstat(join(path, '.git'));
  } catch {
    return unlinked;
  }
  const branchOf = async (p: string): Promise<string | undefined> => {
    const res = await git(['-C', p, 'rev-parse', '--abbrev-ref', 'HEAD']);
    return res.code === 0 ? res.stdout.trim() : undefined;
  };
  if (dotGit.isFile()) {
    // worktree 形态：gitdir 属主仓判定
    const gitdirRes = await git(['rev-parse', '--absolute-git-dir'], { cwd: path });
    if (gitdirRes.code !== 0) return unlinked;
    const ownerMainPath = worktreeOwnerMainPath(normalize(gitdirRes.stdout.trim()));
    if (!ownerMainPath) return unlinked;
    const projectKey = await matchWorktreeOwner(deps, ownerMainPath);
    if (!projectKey) return unlinked;
    return { kind: 'managed-worktree', projectKey, branch: await branchOf(path), worktree: true };
  }
  if (dotGit.isDirectory()) {
    // 项目仓普通克隆（.git 目录 + remote 命中白名单）
    const remoteRes = await git(['-C', path, 'remote', 'get-url', 'origin']);
    const projectKey = remoteRes.code === 0
      ? matchWhitelist(await deps.registry.load(), remoteRes.stdout.trim())
      : null;
    if (!projectKey) return unlinked;
    return { kind: 'project-clone', projectKey, branch: await branchOf(path), worktree: false };
  }
  return unlinked;
}

// ── 幽灵路径说明（design-v2 §六，注册点侧惰性清理见 project-registry.ts）──
// worktree remove --force 全仓禁用（含测试代码）：INCIDENT-20260814-001——
// --force 会连带删除 node_modules junction 级联。本模块回滚一律非 --force。
