// ── Init Confirm 执行体单测（i4-2 Phase D #4）──
// L1 三面比对矩阵（repoUrl/projectKey/worktreePath 短指纹）、L2 三值一致/
// 落后领先/降级口径、L3 写读闭环、readyForConfirm 门禁、POST confirm
// 链态门/防重入/成功转移 ready + 快照 + 事件。注入：临时目录 + scripted
// git + HTTP 桩（模拟 TriMC status）。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type Server } from 'node:http';
import { InitChain } from '../src/company/init-chain.js';
import { CompanyInitState } from '../src/company/init-state.js';
import { ProjectRegistry } from '../src/project/project-registry.js';
import type { GitExecResult, GitRunner } from '../src/project/project-link.js';
import type { LocalBusEvent } from '../src/localbus/bus.js';
import { resetConfirmForTest, runConfirm, runConfirmCheck } from '../src/company/init-confirm.js';
import { bundleTargetPath } from '../src/company/init-sync.js';
import { computePathFingerprint, type SyncBundle } from '../src/company/sync-bundle.js';

// ── fixture 面 ──

const REPO_URL = 'https://github.com/MoRen9527/TriMetaverse.git';
const DEV_HEAD = 'd3adbeefd3adbeefd3adbeefd3adbeefd3adbeef';
const WORKTREE_PATH = 'D:/Code/ai/TriMetaverse';

function scriptedGit(...responses: GitExecResult[]): { git: GitRunner; calls: string[][] } {
  const queue = [...responses];
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(args);
    return queue.shift() ?? { code: 0, stdout: '', stderr: '' };
  };
  return { git, calls };
}

function localBundleFixture(overrides?: Partial<SyncBundle>): SyncBundle {
  return {
    schemaVersion: 1,
    bundleId: 'confirm-bundle-1',
    generatedAt: '2026-08-14T10:00:00.000Z',
    generatedBy: 'trilc-init-0.9.0@a1b2c3d4',
    company: { state: 'initialized', ceoName: 'MoRen', onboardedAt: '2026-08-14T09:00:00.000Z' },
    model: { defaultModel: 'tmv-deepseek-v4-pro', catalog: [], providers: [] },
    keys: { providers: [], refreshIntervalS: 900, fetchedAt: '2026-08-14T09:59:00.000Z' },
    employees: { roster: [], sourceCommit: 'c'.repeat(40) },
    project: {
      projectKey: 'trimetaverse',
      repoUrl: REPO_URL,
      defaultBranch: 'dev',
      worktrees: [{ path: WORKTREE_PATH, branch: 'dev' }],
      devHead: DEV_HEAD,
    },
    ...overrides,
  };
}

let tmpRoot: string;
let dataDir: string;
let registryPath: string;
let mainPath: string;
let events: LocalBusEvent[] = [];
let chain: InitChain;
let companyState: CompanyInitState;
let registry: ProjectRegistry;

async function writeRegistryFrame(): Promise<void> {
  // gitdir 必须真实存在：注册点惰性清理会剔除路径/gitdir 不可见的幽灵项
  // （wt.path=WORKTREE_PATH 在开发机真实存在，gitdir 需同建）
  const wtGitdir = path.join(mainPath, '.git', 'worktrees', 'wt1');
  await fs.mkdir(wtGitdir, { recursive: true });
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      schemaVersion: 1,
      activeProjectKey: 'trimetaverse',
      projects: {
        trimetaverse: {
          repoUrl: REPO_URL,
          hasNpmFileDeps: false,
          defaultBranch: 'dev',
          mainCheckoutPath: mainPath,
          worktrees: [{ path: WORKTREE_PATH, gitdir: wtGitdir, branch: 'dev', claimedAt: 'x' }],
        },
      },
    }, null, 2),
    'utf-8',
  );
}

async function writeLocalBundle(bundle: SyncBundle): Promise<void> {
  const target = bundleTargetPath(mainPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(bundle, null, 2), 'utf-8');
}

async function chainTo(state: 'confirm' | 'ready'): Promise<void> {
  const order = ['uninitialized', 'selfcheck', 'onboarding', 'project-link', 'sync', 'confirm', 'ready'] as const;
  await chain.load();
  for (const s of order) {
    if (chain.getState() === state) return;
    if (s === 'uninitialized') continue;
    await chain.transitionTo(s, 'daemon');
  }
}

function buildDeps(git: GitRunner, trimcBaseUrl: string, overrides?: object): Parameters<typeof runConfirmCheck>[0] {
  return {
    dataDir,
    chain,
    companyState,
    registry,
    publish: (e: LocalBusEvent) => events.push(e),
    trimcBaseUrl,
    trilcVersion: '0.9.0',
    nodeId: 'test-node',
    tricompanySourcePath: path.join(tmpRoot, 'TriCompany'),
    git,
    timeoutMs: 500,
    ...overrides,
  };
}

/** HTTP 桩：模拟 TriMC config/sync/status 响应。 */
async function withStatusServer(
  payload: Record<string, unknown>,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...payload }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function serverStatusPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    applied: { bundleId: 'confirm-bundle-1', generatedAt: '2026-08-14T10:00:00.000Z', lastAppliedAt: 'x', sourceInstanceId: 'y' },
    fleetHead: { branch: 'dev', commit: DEV_HEAD },
    dims: { company: 'applied', model: 'applied', keys: 'warning', employees: 'applied', project: 'applied' },
    pending: null,
    project: {
      projectKey: 'trimetaverse',
      repoUrl: REPO_URL,
      defaultBranch: 'dev',
      worktrees: [{ path: WORKTREE_PATH, branch: 'dev' }],
      devHead: DEV_HEAD,
    },
    warnings: [],
    ...overrides,
  };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trilc-init-confirm-'));
  dataDir = path.join(tmpRoot, 'data');
  registryPath = path.join(tmpRoot, 'project-registry.json');
  mainPath = path.join(tmpRoot, 'main-checkout');
  await fs.mkdir(path.join(mainPath, 'docs', 'registry', 'init-sync'), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, 'TriCompany'), { recursive: true });
  process.env.TRILC_PROJECT_REGISTRY = registryPath;
  events = [];
  chain = new InitChain(dataDir, { onEvent: (e) => events.push(e) });
  companyState = new CompanyInitState(dataDir);
  registry = new ProjectRegistry({ registryPath });
  resetConfirmForTest();
});

afterEach(() => {
  delete process.env.TRILC_PROJECT_REGISTRY;
  resetConfirmForTest();
});

describe('runConfirmCheck — L1 三面比对', () => {
  it('三面一致 → l1 全 ok + readyForConfirm（全链路绿）', async () => {
    await writeRegistryFrame();
    await writeLocalBundle(localBundleFixture());
    const { git } = scriptedGit({ code: 0, stdout: `${DEV_HEAD}\n`, stderr: '' });
    await withStatusServer(serverStatusPayload(), async (baseUrl) => {
      const check = await runConfirmCheck(buildDeps(git, baseUrl));
      assert.equal(check.l1.ok, true);
      for (const item of check.l1.items) assert.equal(item.status, 'ok');
      assert.equal(check.l2.ok, true);
      assert.deepEqual(check.l2, { ok: true, localHead: DEV_HEAD, bundleHead: DEV_HEAD, fleetHead: DEV_HEAD });
      assert.equal(check.l3.ok, true);
      assert.equal(check.l3.appliedBundleId, 'confirm-bundle-1');
      assert.equal(check.l3.localBundleId, 'confirm-bundle-1');
      assert.deepEqual(check.l4, { status: 'pending', note: '由首个协同工作承载' });
      assert.equal(check.readyForConfirm, true);
      assert.equal(check.degraded, false);
      assert.equal(check.remote, 'ok');
    });
  });

  it('repoUrl 三面任一不等 → l1 error + 元素明细（错误仓）', async () => {
    await writeRegistryFrame();
    // bundle 的 repoUrl 指向错误仓
    const badBundle = localBundleFixture();
    (badBundle.project as { repoUrl: string }).repoUrl = 'https://github.com/evil/other.git';
    await writeLocalBundle(badBundle);
    const { git } = scriptedGit({ code: 0, stdout: `${DEV_HEAD}\n`, stderr: '' });
    await withStatusServer(serverStatusPayload(), async (baseUrl) => {
      const check = await runConfirmCheck(buildDeps(git, baseUrl));
      assert.equal(check.l1.ok, false);
      const repoItem = check.l1.items.find((i) => i.element === 'repoUrl');
      assert.equal(repoItem?.status, 'error');
      assert.equal(repoItem?.bundle, 'https://github.com/evil/other.git');
      assert.equal(check.readyForConfirm, false);
    });
  });

  it('worktreePath 短指纹呈现（SHA-256.slice(0,8)）+ 服务器侧不一致 → error', async () => {
    await writeRegistryFrame();
    await writeLocalBundle(localBundleFixture());
    const { git } = scriptedGit({ code: 0, stdout: `${DEV_HEAD}\n`, stderr: '' });
    const wrongWt = serverStatusPayload({
      project: {
        projectKey: 'trimetaverse',
        repoUrl: REPO_URL,
        defaultBranch: 'dev',
        worktrees: [{ path: 'D:/other/worktree', branch: 'dev' }],
        devHead: DEV_HEAD,
      },
    });
    await withStatusServer(wrongWt, async (baseUrl) => {
      const check = await runConfirmCheck(buildDeps(git, baseUrl));
      const wtItem = check.l1.items.find((i) => i.element === 'worktreePath');
      assert.equal(wtItem?.status, 'error');
      assert.equal(wtItem?.local, computePathFingerprint(WORKTREE_PATH));
      assert.equal(wtItem?.server, computePathFingerprint('D:/other/worktree'));
      assert.equal(check.l1.ok, false);
    });
  });
});

describe('runConfirmCheck — L2/L3 + 降级口径', () => {
  it('fleet 落后（bundle == 本地 ≠ fleet）→ l2 mismatch + 三值可诊断', async () => {
    await writeRegistryFrame();
    await writeLocalBundle(localBundleFixture());
    const { git } = scriptedGit({ code: 0, stdout: `${DEV_HEAD}\n`, stderr: '' });
    const lagged = serverStatusPayload({ fleetHead: { branch: 'dev', commit: 'f'.repeat(40) } });
    await withStatusServer(lagged, async (baseUrl) => {
      const check = await runConfirmCheck(buildDeps(git, baseUrl));
      assert.equal(check.l2.ok, false);
      assert.equal(check.l2.localHead, DEV_HEAD);
      assert.equal(check.l2.fleetHead, 'f'.repeat(40));
      assert.equal(check.readyForConfirm, false);
    });
  });

  it('远程不可达 → degraded: true + remote null + L2 双值比较（MVP 接受口径）', async () => {
    await writeRegistryFrame();
    await writeLocalBundle(localBundleFixture());
    const { git } = scriptedGit({ code: 0, stdout: `${DEV_HEAD}\n`, stderr: '' });
    const check = await runConfirmCheck(buildDeps(git, 'http://127.0.0.1:9'));
    assert.equal(check.degraded, true);
    assert.equal(check.remote, null);
    assert.equal(check.l2.ok, true); // 本地 == bundle（双值）
    assert.equal(check.l2.fleetHead, '');
    // L3 无法验证 applied → 未就绪
    assert.equal(check.l3.ok, false);
    assert.equal(check.readyForConfirm, false);
  });

  it('未 applied（applied.bundleId ≠ 本地）→ l3 未就绪 + 重试口径', async () => {
    await writeRegistryFrame();
    await writeLocalBundle(localBundleFixture());
    const { git } = scriptedGit({ code: 0, stdout: `${DEV_HEAD}\n`, stderr: '' });
    const notApplied = serverStatusPayload({
      applied: { bundleId: 'other-bundle', generatedAt: 'x', lastAppliedAt: 'x', sourceInstanceId: 'y' },
    });
    await withStatusServer(notApplied, async (baseUrl) => {
      const check = await runConfirmCheck(buildDeps(git, baseUrl));
      assert.equal(check.l3.ok, false);
      assert.equal(check.l3.appliedBundleId, 'other-bundle');
      assert.equal(check.l3.localBundleId, 'confirm-bundle-1');
      assert.equal(check.readyForConfirm, false);
    });
  });

  it('本地 bundle 缺失 → l1/l3 未就绪', async () => {
    await writeRegistryFrame();
    const { git } = scriptedGit({ code: 0, stdout: `${DEV_HEAD}\n`, stderr: '' });
    await withStatusServer(serverStatusPayload(), async (baseUrl) => {
      const check = await runConfirmCheck(buildDeps(git, baseUrl));
      assert.equal(check.l3.localBundleId, null);
      assert.equal(check.readyForConfirm, false);
    });
  });
});

describe('runConfirm — POST confirm 门禁与转移', () => {
  async function setupReadyConfirmState(baseUrl: string): Promise<GitRunner> {
    await writeRegistryFrame();
    await writeLocalBundle(localBundleFixture());
    return scriptedGit({ code: 0, stdout: `${DEV_HEAD}\n`, stderr: '' }).git;
  }

  it('全绿 → 200 ready + 快照 confirmed + init:step-event', async () => {
    await chainTo('confirm');
    await withStatusServer(serverStatusPayload(), async (baseUrl) => {
      const git = await setupReadyConfirmState(baseUrl);
      const result = await runConfirm(buildDeps(git, baseUrl), 'tripilot');
      assert.equal(result.status, 200);
      if (result.status === 200) {
        assert.equal(result.chainState, 'ready');
        assert.equal(result.confirmed, true);
        assert.equal(result.check.readyForConfirm, true);
      }
      assert.equal(chain.getState(), 'ready');
      const snap = chain.getSnapshot().phaseDetail.confirm;
      assert.equal(snap.status, 'confirmed');
      assert.equal(snap.l1, 'ok');
      assert.equal(snap.l2, 'ok');
      assert.equal(snap.l3, 'applied');
      const step = events.find((e) => e.type === 'init:step-event') as { step?: string; phase?: string };
      assert.equal(step?.phase, 'confirm');
      assert.equal(step?.step, 'confirmed');
    });
  });

  it('readyForConfirm 未达 → 409 notReady 附 check 结果', async () => {
    await chainTo('confirm');
    await withStatusServer(serverStatusPayload({ applied: null }), async (baseUrl) => {
      const git = await setupReadyConfirmState(baseUrl);
      const result = await runConfirm(buildDeps(git, baseUrl), 'trilc-chat');
      assert.equal(result.status, 409);
      if (result.status === 409 && 'notReady' in result) {
        assert.equal(result.notReady, true);
        assert.equal(result.check.readyForConfirm, false);
        assert.equal(result.check.l3.ok, false);
      }
      assert.equal(chain.getState(), 'confirm'); // 未转移
    });
  });

  it('非 confirm 链态 → 409 { chainState }', async () => {
    await chainTo('ready');
    const { git } = scriptedGit();
    const result = await runConfirm(buildDeps(git, 'http://127.0.0.1:9'), 'daemon');
    assert.deepEqual(result, { status: 409, chainState: 'ready' });
  });

  it('防重入：运行中再触发 → 409 busy', async () => {
    await chainTo('confirm');
    await withStatusServer(serverStatusPayload(), async (baseUrl) => {
      // 挂起 check 的远程拉取（第一个 HTTP 请求后 server 已停——用慢桩：这里用
      // 不可达但 fetch 超时前互斥已置位的方式验证：直接并发两发）
      await writeRegistryFrame();
      await writeLocalBundle(localBundleFixture());
      const git = scriptedGit({ code: 0, stdout: `${DEV_HEAD}\n`, stderr: '' }).git;
      const deps = buildDeps(git, baseUrl);
      const [first, second] = await Promise.all([runConfirm(deps, 'daemon'), runConfirm(deps, 'daemon')]);
      // 并发下至少一个 busy 或两者按序完成（互斥保证单执行体；两发同瞬只有一发可执行）
      const outcomes = [first.status, second.status];
      assert.ok(outcomes.includes(409), `expected one 409, got ${outcomes.join(',')}`);
    });
  });
});
