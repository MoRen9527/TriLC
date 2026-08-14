// ── TriCompany Init Confirm 执行体（I4 Phase D：L1-L4 协同确认）──
// init-collab-i4-five-dim-sync i4-1 拆解 §六（契约类型冻结于 sync-bundle.ts）：
//
//   GET /internal/v1/init/confirm/check（按需计算，无后台常驻轮询）：
//   - L1 注册同一性：project-registry activeProjectKey/repoUrl/worktrees[] ↔
//     bundle.project ↔ TriMC status.project 三面比对；路径用短指纹呈现
//     （SHA-256(worktreePath).slice(0,8)，§7.2 防截断）；不匹配 = ERROR
//     （错误仓/错误分支）。
//   - L2 版本一致：本地 dev HEAD == bundle.project.devHead ==
//     status.fleetHead.commit；三值相等 PASS，不等 = 落后/领先诊断（ff 收敛
//     提示，由渲染层根据三值推导）。
//   - L3 写读闭环：status.applied.bundleId == 本地 bundle 文件 bundleId
//     （sync commit 即探针）；未 applied = 「未就绪」+ 重试提示。
//   - L4 反向闭环：由首个协同工作承载（周平面平移，I5 树）——
//     { status: 'pending', note: '由首个协同工作承载' }。
//   - 降级口径（§7.2.3）：TriMC HTTP 不可达 → L2 服务器侧事实退化（本地
//     push 成功 + 裸仓 reflog 人工口径），MVP 接受——remote: null +
//     degraded: true；L2 双值比较（本地 == bundle）。
//
//   POST /internal/v1/init/confirm：用户一次确认（两入口同载荷 { entry }）
//   → 服务端重算 check → readyForConfirm 门禁（否则 409 附 check 结果）→
//   phaseDetail.confirm.status='confirmed' + l1/l2/l3 快照 →
//   transitionTo('ready') → init:step-event 发布。
//
// 协同开启成功 = 三元素一致 + 一次确认（§2.8 验收口径）。

import type { InitSyncDeps } from './init-sync.js';
import {
  bundleTargetPath,
  fetchRemoteSyncStatus,
  readExistingBundle,
} from './init-sync.js';
import {
  computePathFingerprint,
  isDimUnavailable,
  type BundleProject,
  type ConfirmCheckL1,
  type ConfirmCheckPayload,
  type ConfirmCheckStatus,
  type ConfirmResult,
} from './sync-bundle.js';
import type { SyncEntry } from './init-sync.js';
import type { GitRunner } from '../project/project-link.js';

// ── 本地三面数据收集 ──

interface LocalConfirmFacts {
  activeProjectKey: string | null;
  repoUrl: string | null;
  worktreePaths: string[];
  mainCheckoutPath: string | null;
  localHead: string | null;
  bundle: ReturnType<typeof readExistingBundle> extends Promise<infer T> ? T : never;
}

async function collectLocalFacts(deps: InitSyncDeps): Promise<LocalConfirmFacts> {
  const frame = await deps.registry.load();
  const activeProjectKey = frame.activeProjectKey;
  const projectEntry = activeProjectKey ? frame.projects[activeProjectKey] : null;
  const mainCheckoutPath = projectEntry?.mainCheckoutPath ?? null;
  const git: GitRunner = deps.git ?? (await import('../project/project-link.js')).createGitRunner();

  let localHead: string | null = null;
  if (mainCheckoutPath) {
    const headRes = await git(['-C', mainCheckoutPath, 'rev-parse', 'HEAD']);
    if (headRes.code === 0 && headRes.stdout.trim()) localHead = headRes.stdout.trim();
  }
  const bundle = mainCheckoutPath ? await readExistingBundle(bundleTargetPath(mainCheckoutPath)) : null;
  return {
    activeProjectKey,
    repoUrl: projectEntry?.repoUrl ?? null,
    worktreePaths: (projectEntry?.worktrees ?? []).map((wt) => wt.path),
    mainCheckoutPath,
    localHead,
    bundle,
  };
}

// ── L1 三面比对 ──

/** 路径集合短指纹（排序拼接，§7.2 防截断呈现）。 */
function fingerprintPaths(paths: string[]): string {
  return [...paths].sort().map((p) => computePathFingerprint(p)).join(',');
}

function compareL1Value(
  element: 'repoUrl' | 'projectKey' | 'worktreePath',
  local: string | null,
  bundle: string | null,
  server: string | null,
): ConfirmCheckL1['items'][number] {
  const localStr = local ?? '';
  const bundleStr = bundle ?? '';
  const serverStr = server ?? '';
  const ok = !!localStr && localStr === bundleStr && bundleStr === serverStr;
  return {
    element,
    status: ok ? 'ok' : 'error',
    local: localStr,
    bundle: bundleStr,
    server: serverStr,
  };
}

function computeL1(
  facts: LocalConfirmFacts,
  bundleProject: BundleProject | null,
  serverProject: BundleProject | null,
): ConfirmCheckL1 {
  const items: ConfirmCheckL1['items'] = [
    compareL1Value('repoUrl', facts.repoUrl, bundleProject?.repoUrl ?? null, serverProject?.repoUrl ?? null),
    compareL1Value('projectKey', facts.activeProjectKey, bundleProject?.projectKey ?? null, serverProject?.projectKey ?? null),
    compareL1Value(
      'worktreePath',
      fingerprintPaths(facts.worktreePaths),
      bundleProject ? fingerprintPaths(bundleProject.worktrees.map((wt) => wt.path)) : null,
      serverProject ? fingerprintPaths(serverProject.worktrees.map((wt) => wt.path)) : null,
    ),
  ];
  return { ok: items.every((i) => i.status === 'ok'), items };
}

// ── L2/L3/L4 ──

function computeL2(
  facts: LocalConfirmFacts,
  bundleProject: BundleProject | null,
  fleetHeadCommit: string | null,
  degraded: boolean,
): ConfirmCheckPayload['l2'] {
  const localHead = facts.localHead ?? '';
  const bundleHead = bundleProject?.devHead ?? '';
  const fleetHead = fleetHeadCommit ?? '';
  if (degraded) {
    // 降级口径：服务器侧事实退化 → 双值比较（本地 == bundle），MVP 接受
    return { ok: !!localHead && localHead === bundleHead, localHead, bundleHead, fleetHead };
  }
  return {
    ok: !!localHead && localHead === bundleHead && bundleHead === fleetHead,
    localHead,
    bundleHead,
    fleetHead,
  };
}

// ── check 计算（GET confirm/check 数据源；POST confirm 服务端重算同源）──

export async function runConfirmCheck(deps: InitSyncDeps): Promise<ConfirmCheckPayload> {
  const chainFrame = await deps.chain.load();
  const facts = await collectLocalFacts(deps);
  const remote = await fetchRemoteSyncStatus(deps);
  const degraded = remote === null;

  const bundleProject =
    facts.bundle && !isDimUnavailable(facts.bundle.project) ? facts.bundle.project : null;
  const serverProject = remote?.project ?? null;
  const appliedBundleId = remote?.appliedBundleId ?? null;

  const l1 = computeL1(facts, bundleProject, serverProject);
  const l2 = computeL2(facts, bundleProject, remote?.fleetHead?.commit ?? null, degraded);
  const l3 = {
    ok: !!appliedBundleId && !!facts.bundle && appliedBundleId === facts.bundle.bundleId,
    appliedBundleId,
    localBundleId: facts.bundle?.bundleId ?? null,
  };
  const l4 = { status: 'pending' as const, note: '由首个协同工作承载' as const };

  return {
    chainState: chainFrame.chainState,
    l1,
    l2,
    l3,
    l4,
    readyForConfirm: l1.ok && l2.ok && l3.ok,
    remote: degraded ? null : 'ok',
    degraded,
  };
}

// ── POST confirm 执行体 ──

let _confirming = false;

/** 测试复位。 */
export function resetConfirmForTest(): void {
  _confirming = false;
}

export async function runConfirm(deps: InitSyncDeps, entry: SyncEntry): Promise<ConfirmResult> {
  if (_confirming) return { status: 409, busy: true, runId: 'confirm' };
  _confirming = true;
  try {
    // 链态门：仅 confirm 生效
    const chainFrame = await deps.chain.load();
    if (chainFrame.chainState !== 'confirm') {
      return { status: 409, chainState: chainFrame.chainState };
    }
    // 服务端重算 check（与 GET check 同源）
    const check = await runConfirmCheck(deps);
    if (!check.readyForConfirm) {
      return { status: 409, notReady: true, check };
    }
    // 快照 + ready 转移 + 事件（协同开启成功 = 三元素一致 + 一次确认）
    const confirmedFrame = await deps.chain.updateConfirm({
      status: 'confirmed',
      l1: check.l1.ok ? 'ok' : `error:${check.l1.items.filter((i) => i.status !== 'ok').map((i) => i.element).join(',')}`,
      l2: check.l2.ok ? 'ok' : check.degraded ? 'degraded' : 'mismatch',
      l3: check.l3.ok ? 'applied' : 'pending',
    });
    await deps.chain.transitionTo('ready', entry);
    deps.publish({
      type: 'init:step-event',
      phase: 'confirm',
      step: 'confirmed',
      entry,
      payload: { check, phaseDetail: confirmedFrame.phaseDetail.confirm },
    });
    return { status: 200, chainState: 'ready', confirmed: true, check };
  } finally {
    _confirming = false;
  }
}
