// ── ProjectLink / Claim / Inspect tests（I3: init-collab-i3-project-registry）──
// 覆盖（i3-2 任务包 §五）：URL 规范化白名单比对 / 链态门 409 / 本地源六步
// 全流程（事件族与 status 投影一致）/ 认领绝不重复 add（mock git）/ 门禁
// 拒绝 / 非白名单拒绝 / 回滚路径（登记失败 → worktree remove 非 --force；
// 链态失败 → 注册点回滚 + worktree remove 非 --force）/ 防重入 busy /
// GitHub 源克隆链（白名单 + 克隆失败分类）/ claim 端点矩阵 / inspect
// 识别分流 / `worktree remove --force` 全仓禁用（mock git 调用日志断言）。

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { InitChain } from '../src/company/init-chain.js';
import { ProjectRegistry } from '../src/project/project-registry.js';
import {
  normalizeGitUrl,
  validateLinkPayload,
  validateClaimPayload,
  runLink,
  runClaim,
  inspectPath,
  resetLinkForTest,
  type GitRunner,
  type GitExecResult,
  type ProjectLinkDeps,
} from '../src/project/project-link.js';
import type { LocalBusEvent } from '../src/localbus/bus.js';

const PRESET_URL = 'https://github.com/MoRen9527/TriMetaverse.git';

// ── Mock git（daemon 单执行体替身；调用日志 = 断言面）──

class MockGit {
  calls: Array<{ args: string[]; cwd?: string; timeoutMs?: number }> = [];
  private handlers: Array<{ key: string; result: GitExecResult; delayMs?: number }> = [];

  run: GitRunner = async (args, opts) => {
    this.calls.push({ args: [...args], cwd: opts?.cwd, timeoutMs: opts?.timeoutMs });
    // 后登记覆盖先登记（同 args 允许重写，如 busy 测试的延迟 add）
    for (let i = this.handlers.length - 1; i >= 0; i--) {
      const handler = this.handlers[i];
      if (handler.key === JSON.stringify(args)) {
        if (handler.delayMs) await new Promise((r) => setTimeout(r, handler.delayMs));
        return { ...handler.result };
      }
    }
    return { code: 128, stdout: '', stderr: `unhandled git args: ${args.join(' ')}` };
  };

  /** 精确 args 匹配（-C path 形式逐项登记；后登记覆盖先登记）。 */
  on(args: string[], result: Partial<GitExecResult> = {}, delayMs?: number): void {
    this.handlers.push({
      key: JSON.stringify(args),
      result: { code: 0, stdout: '', stderr: '', ...result },
      delayMs,
    });
  }

  /** 按多词片段匹配（args 空格拼接后 includes）。 */
  callsWith(fragment: string): Array<string[]> {
    return this.calls.map((c) => c.args).filter((a) => a.join(' ').includes(fragment));
  }

  /** 护栏断言：任何 git 调用不得出现 remove 带 --force（INCIDENT-20260814-001）。 */
  assertNoForceRemove(): void {
    for (const c of this.calls) {
      if (c.args.includes('remove')) {
        assert.equal(
          c.args.includes('--force'),
          false,
          `worktree remove must never use --force: ${c.args.join(' ')}`,
        );
      }
    }
  }
}

afterEach(() => {
  resetLinkForTest();
});

// ── 环境构造 ──

async function makeEnv(opts: { chainAtProjectLink?: boolean; hasNpmFileDeps?: boolean } = {}) {
  const chainAtProjectLink = opts.chainAtProjectLink ?? true;
  const dir = await mkdtemp(join(tmpdir(), 'project-link-test-'));
  const main = join(dir, 'main');
  const wt = join(dir, 'wt');
  await mkdir(join(main, '.git'), { recursive: true });
  const registry = new ProjectRegistry({ registryPath: join(dir, 'project-registry.json') });
  const chain = new InitChain(dir);
  const events: LocalBusEvent[] = [];
  const mock = new MockGit();
  const deps: ProjectLinkDeps = {
    registry,
    chain,
    publish: (e) => events.push(e),
    git: mock.run,
    cloneRoot: join(dir, 'clones'),
  };
  await chain.load();
  // 链态预备：uninitialized → selfcheck → onboarding（gate 测试停此）；
  // 默认再推进 project-link（六步链态门内）。
  await chain.transitionTo('selfcheck', 'daemon');
  await chain.transitionTo('onboarding', 'daemon');
  if (chainAtProjectLink) await chain.transitionTo('project-link', 'daemon');
  if (opts.hasNpmFileDeps) {
    // 门禁安全阀：文件显式覆盖 hasNpmFileDeps=true（预置默认 false）
    await writeFile(
      registry.path,
      JSON.stringify({
        schemaVersion: 1,
        activeProjectKey: null,
        projects: {
          trimetaverse: {
            repoUrl: PRESET_URL,
            hasNpmFileDeps: true,
            defaultBranch: 'dev',
            mainCheckoutPath: null,
            worktrees: [],
          },
        },
      }, null, 2),
      'utf-8',
    );
  }
  return { dir, main, wt, registry, chain, events, mock, deps };
}

/** 落盘形态（真实 git worktree add 的磁盘结果）：worktree 目录 + gitdir 均存在。 */
async function touchWorktreeDirs(main: string, wt: string): Promise<void> {
  await mkdir(wt, { recursive: true });
  await mkdir(join(main, '.git', 'worktrees', 'wt1'), { recursive: true });
}

/** 标准本地源 mock：remote 白名单命中 + worktree add + gitdir/branch + worktree list。 */
function mockLocalFlow(mock: MockGit, main: string, wt: string): void {
  mock.on(['-C', main, 'remote', 'get-url', 'origin'], { stdout: `${PRESET_URL}\n` });
  mock.on(['-C', main, 'worktree', 'add', wt, '-b', 'project/trimetaverse'], {
    stdout: "Preparing worktree (new branch 'project/trimetaverse')\n",
  });
  mock.on(['-C', wt, 'rev-parse', '--absolute-git-dir'], {
    stdout: `${join(main, '.git', 'worktrees', 'wt1')}\n`,
  });
  mock.on(['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdout: 'project/trimetaverse\n' });
  mock.on(['-C', main, 'worktree', 'list', '--porcelain'], {
    stdout: `worktree ${main}\nbranch refs/heads/dev\n\nworktree ${wt}\nbranch refs/heads/project/trimetaverse\n`,
  });
  mock.on(['-C', main, 'worktree', 'remove', wt], {});
}

// ── 1. URL 规范化 ──

test('normalizeGitUrl: https/ssh/scp 同仓等价，去尾 .git，主机+路径小写', () => {
  const canonical = 'github.com/moren9527/trimetaverse';
  assert.equal(normalizeGitUrl('https://github.com/MoRen9527/TriMetaverse.git'), canonical);
  assert.equal(normalizeGitUrl('https://github.com/MoRen9527/TriMetaverse'), canonical);
  assert.equal(normalizeGitUrl('git@github.com:MoRen9527/TriMetaverse.git'), canonical);
  assert.equal(normalizeGitUrl('ssh://git@github.com/MoRen9527/TriMetaverse.git'), canonical);
  assert.equal(normalizeGitUrl('  https://github.com/MoRen9527/TriMetaverse.git  '), canonical);
  assert.notEqual(normalizeGitUrl('https://github.com/other/TriMetaverse.git'), canonical);
  assert.notEqual(normalizeGitUrl('https://github.com/MoRen9527/TriLC.git'), canonical);
});

// ── 2. 载荷校验 ──

test('validateLinkPayload: local 源需绝对 localPath+targetPath；github 源需 repoUrl', () => {
  assert.ok(validateLinkPayload({ source: 'local', localPath: 'D:/x/main', targetPath: 'D:/x/wt' }).ok);
  assert.ok(!validateLinkPayload({ source: 'local', localPath: 'relative', targetPath: 'D:/x/wt' }).ok);
  assert.ok(!validateLinkPayload({ source: 'local', localPath: 'D:/x/main' }).ok, 'targetPath required');
  assert.ok(!validateLinkPayload({ source: 'other' }).ok, 'source enum');
  assert.ok(validateLinkPayload({ source: 'github', repoUrl: PRESET_URL }).ok);
  assert.ok(!validateLinkPayload({ source: 'github' }).ok, 'repoUrl required');
  const v = validateClaimPayload({ path: 'D:/x/wt' });
  assert.ok(v.ok && v.path === normalize('D:/x/wt'), 'path normalized to platform form');
  assert.ok(!validateClaimPayload({ path: '' }).ok);
  assert.ok(!validateClaimPayload({}).ok);
});

// ── 3. 链态门 409 ──

test('chain gate: non project-link state returns 409 { chainState }, zero git calls', async () => {
  const env = await makeEnv({ chainAtProjectLink: false }); // 停在 onboarding
  mockLocalFlow(env.mock, env.main, env.wt);
  const result = await runLink(env.deps, {
    source: 'local',
    localPath: env.main,
    targetPath: env.wt,
    entry: 'daemon',
  });
  assert.equal(result.status, 409);
  assert.equal((result as { chainState: string }).chainState, 'onboarding');
  assert.equal(env.mock.calls.length, 0, 'no git calls before gate');
  await rm(env.dir, { recursive: true, force: true });
});

// ── 4. 本地源六步全流程 + 事件族与 status 投影一致 ──

test('local link full flow: 200 + registry entry + chain snapshot linked + ordered events', async () => {
  const env = await makeEnv();
  mockLocalFlow(env.mock, env.main, env.wt);
  await touchWorktreeDirs(env.main, env.wt); // 真实 add 的磁盘形态（登记不被惰性清理）
  const result = await runLink(env.deps, {
    source: 'local',
    localPath: env.main,
    targetPath: env.wt,
    entry: 'tripilot',
  });
  assert.equal(result.status, 200);
  const ok = result as { runId: string; projectKey: string; worktreePath: string; branch: string };
  assert.equal(ok.projectKey, 'trimetaverse');
  assert.equal(ok.worktreePath, env.wt);
  assert.equal(ok.branch, 'project/trimetaverse');
  assert.ok(ok.runId.startsWith('pl_'));

  // 注册点：登记去重 + 焦点项目 + 主检出登记
  const fresh = new ProjectRegistry({ registryPath: env.registry.path });
  const frame = await fresh.load();
  assert.equal(frame.activeProjectKey, 'trimetaverse');
  assert.equal(frame.projects.trimetaverse.mainCheckoutPath, env.main);
  assert.equal(frame.projects.trimetaverse.worktrees.length, 1);
  assert.equal(frame.projects.trimetaverse.worktrees[0].path, env.wt);
  assert.equal(frame.projects.trimetaverse.worktrees[0].gitdir, join(env.main, '.git', 'worktrees', 'wt1'));

  // 链态快照（内存态热更新同请求）
  const snapshot = env.chain.getSnapshot();
  assert.deepEqual(snapshot.phaseDetail['project-link'], {
    status: 'linked',
    source: 'local',
    projectKey: 'trimetaverse',
    worktreePath: env.wt,
  });
  assert.equal(snapshot.chainState, 'project-link', '本树不转出 project-link');

  // 事件族：started → detect/match/gate/worktree-add/register/chain-update → finished + step-event
  const types = env.events.map((e) => e.type);
  const startedIdx = types.indexOf('init:project-link-started');
  const finishedIdx = types.indexOf('init:project-link-finished');
  assert.ok(startedIdx >= 0 && finishedIdx > startedIdx, 'started before finished');
  const progressSteps = env.events
    .filter((e) => e.type === 'init:project-link-progress')
    .map((e) => (e as { step: string }).step);
  assert.deepEqual(
    progressSteps.filter((s, i, a) => a.indexOf(s) === i),
    ['detect', 'match', 'gate', 'worktree-add', 'register', 'chain-update'],
    'progress steps ordered per six-step contract',
  );
  for (const e of env.events.filter((e) => e.type === 'init:project-link-progress')) {
    assert.equal((e as { status: string }).status, 'ok');
    assert.equal((e as { runId: string }).runId, ok.runId, 'runId correlation');
  }
  const finished = env.events.find((e) => e.type === 'init:project-link-finished') as {
    projectKey: string; worktreePath: string; branch: string; chainState: string; phaseDetail: unknown;
  };
  assert.equal(finished.projectKey, 'trimetaverse');
  assert.equal(finished.worktreePath, env.wt);
  assert.equal(finished.chainState, 'project-link');
  // 事件族 = status 投影同帧（完成帧 phaseDetail 与链态快照一致）
  assert.deepEqual(finished.phaseDetail, snapshot.phaseDetail['project-link']);
  const stepEvent = env.events.find((e) => e.type === 'init:step-event');
  assert.equal((stepEvent as { phase: string }).phase, 'project-link');
  assert.equal((stepEvent as { step: string }).step, 'linked');
  env.mock.assertNoForceRemove();
  await rm(env.dir, { recursive: true, force: true });
});

// ── 5. 认领绝不重复 add ──

test('claim path: existing owned worktree registers without any worktree add', async () => {
  const env = await makeEnv();
  const wtDir = join(env.dir, 'wt');
  await mkdir(wtDir, { recursive: true });
  await writeFile(join(wtDir, '.git'), `gitdir: ${join(env.main, '.git', 'worktrees', 'wt1')}\n`, 'utf-8');
  env.mock.on(['-C', env.main, 'remote', 'get-url', 'origin'], { stdout: `${PRESET_URL}\n` });
  env.mock.on(['rev-parse', '--absolute-git-dir'], {
    stdout: `${join(env.main, '.git', 'worktrees', 'wt1')}\n`,
  });
  env.mock.on(['-C', wtDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdout: 'project/trimetaverse\n' });
  env.mock.on(['-C', env.main, 'worktree', 'list', '--porcelain'], {
    stdout: `worktree ${env.main}\nbranch refs/heads/dev\n\nworktree ${wtDir}\nbranch refs/heads/project/trimetaverse\n`,
  });

  const result = await runLink(env.deps, {
    source: 'local',
    localPath: env.main,
    targetPath: wtDir,
    entry: 'daemon',
  });
  assert.equal(result.status, 200);
  const addCalls = env.mock.callsWith('worktree add');
  assert.equal(addCalls.length, 0, '认领绝不重复 add');
  const removeCalls = env.mock.callsWith('remove');
  assert.equal(removeCalls.length, 0, 'claim path zero git writes');
  // 登记 + 链态
  const frame = await env.registry.load();
  assert.equal(frame.projects.trimetaverse.worktrees.length, 1);
  assert.equal(frame.projects.trimetaverse.worktrees[0].path, wtDir);
  assert.equal(env.chain.getSnapshot().phaseDetail['project-link'].status, 'linked');
  const claimEvent = env.events.find((e) => e.type === 'init:project-link-progress' && (e as { step: string }).step === 'claim');
  assert.ok(claimEvent, 'claim progress event published');
  await rm(env.dir, { recursive: true, force: true });
});

// ── 6. 门禁 / 白名单拒绝 ──

test('relink same target: second link takes claim path, worktree add called exactly once', async () => {
  const env = await makeEnv();
  mockLocalFlow(env.mock, env.main, env.wt);
  await touchWorktreeDirs(env.main, env.wt);
  const req = { source: 'local' as const, localPath: env.main, targetPath: env.wt, entry: 'daemon' as const };
  const first = await runLink(env.deps, req);
  assert.equal(first.status, 200);
  assert.equal(env.mock.callsWith('worktree add').length, 1);
  // 目标转 worktree 形态（.git 文件 + gitdir 属主仓）→ 二次 link 走认领
  await writeFile(join(env.wt, '.git'), `gitdir: ${join(env.main, '.git', 'worktrees', 'wt1')}\n`, 'utf-8');
  env.mock.on(['rev-parse', '--absolute-git-dir'], {
    stdout: `${join(env.main, '.git', 'worktrees', 'wt1')}\n`,
  });
  env.mock.on(['-C', env.wt, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdout: 'project/trimetaverse\n' });
  const second = await runLink(env.deps, req);
  assert.equal(second.status, 200);
  assert.equal(env.mock.callsWith('worktree add').length, 1, '认领绝不重复 add');
  const frame = await env.registry.load();
  assert.equal(frame.projects.trimetaverse.worktrees.length, 1, 'registration deduped');
  await rm(env.dir, { recursive: true, force: true });
});

test('gate-blocked: hasNpmFileDeps flagged repo refuses auto add (422)', async () => {
  const env = await makeEnv({ hasNpmFileDeps: true });
  env.mock.on(['-C', env.main, 'remote', 'get-url', 'origin'], { stdout: `${PRESET_URL}\n` });
  const result = await runLink(env.deps, {
    source: 'local',
    localPath: env.main,
    targetPath: env.wt,
    entry: 'daemon',
  });
  assert.equal(result.status, 422);
  assert.equal((result as { classification: string }).classification, 'gate-blocked');
  assert.equal(env.mock.callsWith('worktree add').length, 0, 'no auto add behind gate');
  await rm(env.dir, { recursive: true, force: true });
});

test('not-whitelisted: foreign remote refused (422), zero git writes', async () => {
  const env = await makeEnv();
  env.mock.on(['-C', env.main, 'remote', 'get-url', 'origin'], {
    stdout: 'https://github.com/evil/FakeRepo.git\n',
  });
  const result = await runLink(env.deps, {
    source: 'local',
    localPath: env.main,
    targetPath: env.wt,
    entry: 'daemon',
  });
  assert.equal(result.status, 422);
  assert.equal((result as { classification: string }).classification, 'not-whitelisted');
  assert.equal(env.mock.callsWith('worktree add').length, 0);
  await rm(env.dir, { recursive: true, force: true });
});

test('target-invalid: non-empty non-git target dir refused', async () => {
  const env = await makeEnv();
  mockLocalFlow(env.mock, env.main, env.wt);
  await mkdir(env.wt, { recursive: true });
  await writeFile(join(env.wt, 'file.txt'), 'x', 'utf-8');
  const result = await runLink(env.deps, {
    source: 'local',
    localPath: env.main,
    targetPath: env.wt,
    entry: 'daemon',
  });
  assert.equal(result.status, 422);
  assert.equal((result as { classification: string }).classification, 'target-invalid');
  assert.equal(env.mock.callsWith('worktree add').length, 0);
  await rm(env.dir, { recursive: true, force: true });
});

// ── 7. 回滚路径（worktree remove 非 --force）──

test('rollback: register failure → worktree remove without --force, no registry entry, chain pending', async () => {
  const env = await makeEnv();
  mockLocalFlow(env.mock, env.main, env.wt);
  const deps = { ...env.deps, failRegister: true };
  const result = await runLink(deps, {
    source: 'local',
    localPath: env.main,
    targetPath: env.wt,
    entry: 'daemon',
  });
  assert.equal(result.status, 500);
  assert.equal((result as { classification: string }).classification, 'register-failed');
  assert.equal((result as { rollback: string }).rollback, 'completed');
  const removeCalls = env.mock.callsWith('remove');
  assert.equal(removeCalls.length, 1, 'worktree remove executed');
  assert.deepEqual(removeCalls[0], ['-C', env.main, 'worktree', 'remove', env.wt], 'non --force remove');
  env.mock.assertNoForceRemove();
  // 注册点无登记（回滚干净）
  const frame = await env.registry.load();
  assert.equal(frame.projects.trimetaverse.worktrees.length, 0);
  // 链态仍 pending
  assert.equal(env.chain.getSnapshot().phaseDetail['project-link'].status, 'pending');
  // 失败进度事件已发布
  const failed = env.events.find((e) => e.type === 'init:project-link-progress' && (e as { status: string }).status === 'failed');
  assert.ok(failed, 'failed progress event published');
  await rm(env.dir, { recursive: true, force: true });
});

test('rollback: chain-update failure → registry unregistered + worktree remove non --force', async () => {
  const env = await makeEnv();
  mockLocalFlow(env.mock, env.main, env.wt);
  const deps = { ...env.deps, failChainUpdate: true };
  const result = await runLink(deps, {
    source: 'local',
    localPath: env.main,
    targetPath: env.wt,
    entry: 'daemon',
  });
  assert.equal(result.status, 500);
  assert.equal((result as { classification: string }).classification, 'chain-update-failed');
  assert.equal((result as { rollback: string }).rollback, 'completed');
  const removeCalls = env.mock.callsWith('remove');
  assert.equal(removeCalls.length, 1);
  assert.deepEqual(removeCalls[0], ['-C', env.main, 'worktree', 'remove', env.wt]);
  env.mock.assertNoForceRemove();
  // 注册点回滚：无残留登记
  const fresh = new ProjectRegistry({ registryPath: env.registry.path });
  const frame = await fresh.load();
  assert.equal(frame.projects.trimetaverse.worktrees.length, 0);
  // 链态未 linked（快照更新失败即未落盘）
  assert.equal(env.chain.getSnapshot().phaseDetail['project-link'].status, 'pending');
  await rm(env.dir, { recursive: true, force: true });
});

// ── 8. 防重入 busy ──

test('mutex: concurrent link requests → second returns 409 busy', async () => {
  const env = await makeEnv();
  mockLocalFlow(env.mock, env.main, env.wt);
  // 第一请求的 worktree add 加延迟（后登记覆盖先登记），保证第二请求在
  // 第一请求在途时到达 → busy
  mockLocalFlow(env.mock, env.main, env.wt);
  env.mock.on(['-C', env.main, 'worktree', 'add', env.wt, '-b', 'project/trimetaverse'], {
    stdout: "Preparing worktree\n",
  }, 120);
  const req = { source: 'local' as const, localPath: env.main, targetPath: env.wt, entry: 'daemon' as const };
  const [first, second] = await Promise.all([runLink(env.deps, req), runLink(env.deps, req)]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 409], 'one success + one busy');
  const busy = (first.status === 409 ? first : second) as { busy: true; runId: string };
  assert.equal(busy.busy, true);
  env.mock.assertNoForceRemove();
  await rm(env.dir, { recursive: true, force: true });
});

// ── 9. GitHub 源克隆链 ──

test('github source: ssh url whitelist match → clone → default branch → local chain → 200', async () => {
  const env = await makeEnv();
  const cloneTarget = join(env.deps.cloneRoot!, 'trimetaverse');
  const worktreeTarget = `${cloneTarget}-worktree`;
  env.mock.on(['clone', 'git@github.com:MoRen9527/TriMetaverse.git', cloneTarget], { stdout: 'Cloning...\n' });
  env.mock.on(['-C', cloneTarget, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdout: 'master\n' });
  env.mock.on(['-C', cloneTarget, 'checkout', 'dev'], { stdout: "Switched to branch 'dev'\n" });
  env.mock.on(['-C', cloneTarget, 'worktree', 'add', worktreeTarget, '-b', 'project/trimetaverse'], { stdout: 'Preparing worktree\n' });
  env.mock.on(['-C', worktreeTarget, 'rev-parse', '--absolute-git-dir'], {
    stdout: `${join(cloneTarget, '.git', 'worktrees', 'wt1')}\n`,
  });
  env.mock.on(['-C', worktreeTarget, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdout: 'project/trimetaverse\n' });
  env.mock.on(['-C', cloneTarget, 'worktree', 'list', '--porcelain'], {
    stdout: `worktree ${cloneTarget}\nbranch refs/heads/dev\n\nworktree ${worktreeTarget}\nbranch refs/heads/project/trimetaverse\n`,
  });
  env.mock.on(['-C', cloneTarget, 'worktree', 'remove', worktreeTarget], {});

  const result = await runLink(env.deps, {
    source: 'github',
    repoUrl: 'git@github.com:MoRen9527/TriMetaverse.git',
    entry: 'daemon',
  });
  assert.equal(result.status, 200);
  const ok = result as { projectKey: string; worktreePath: string };
  assert.equal(ok.projectKey, 'trimetaverse');
  assert.equal(ok.worktreePath, worktreeTarget);
  const frame = await env.registry.load();
  assert.equal(frame.projects.trimetaverse.mainCheckoutPath, cloneTarget, 'clone main registered');
  assert.equal(frame.projects.trimetaverse.worktrees[0].path, worktreeTarget);
  env.mock.assertNoForceRemove();
  await rm(env.dir, { recursive: true, force: true });
});

test('github source: non-whitelisted repoUrl refused before any clone', async () => {
  const env = await makeEnv();
  const result = await runLink(env.deps, {
    source: 'github',
    repoUrl: 'https://github.com/evil/FakeRepo.git',
    entry: 'daemon',
  });
  assert.equal(result.status, 422);
  assert.equal((result as { classification: string }).classification, 'not-whitelisted');
  assert.equal(env.mock.callsWith('clone').length, 0, 'no clone for non-whitelisted');
  await rm(env.dir, { recursive: true, force: true });
});

test('github source: clone failure classified 422 clone-failed (可改走 local 源)', async () => {
  const env = await makeEnv();
  const cloneTarget = join(env.deps.cloneRoot!, 'trimetaverse');
  env.mock.on(['clone', PRESET_URL, cloneTarget], {
    code: 128,
    stderr: "fatal: Authentication failed for 'https://github.com/MoRen9527/TriMetaverse.git/'",
  });
  const result = await runLink(env.deps, {
    source: 'github',
    repoUrl: PRESET_URL,
    entry: 'daemon',
  });
  assert.equal(result.status, 422);
  assert.equal((result as { classification: string }).classification, 'clone-failed');
  assert.ok((result as { message: string }).message.includes('凭据'));
  await rm(env.dir, { recursive: true, force: true });
});

// ── 10. claim 端点矩阵 ──

test('claim: gate 409 outside project-link', async () => {
  const env = await makeEnv({ chainAtProjectLink: false });
  const result = await runClaim(env.deps, env.wt);
  assert.equal(result.status, 409);
  assert.equal((result as { chainState: string }).chainState, 'onboarding');
  assert.equal(env.mock.calls.length, 0);
  await rm(env.dir, { recursive: true, force: true });
});

test('claim: managed worktree → 200 claimed + registration + chain linked (zero git writes)', async () => {
  const env = await makeEnv();
  const wtDir = join(env.dir, 'wt');
  await mkdir(wtDir, { recursive: true });
  await writeFile(join(wtDir, '.git'), `gitdir: ${join(env.main, '.git', 'worktrees', 'wt1')}\n`, 'utf-8');
  env.mock.on(['-C', env.main, 'remote', 'get-url', 'origin'], { stdout: `${PRESET_URL}\n` });
  env.mock.on(['rev-parse', '--absolute-git-dir'], {
    stdout: `${join(env.main, '.git', 'worktrees', 'wt1')}\n`,
  });
  env.mock.on(['-C', wtDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdout: 'project/trimetaverse\n' });

  const result = await runClaim(env.deps, wtDir);
  assert.equal(result.status, 200);
  assert.equal((result as { projectKey: string }).projectKey, 'trimetaverse');
  assert.equal((result as { claimed: boolean }).claimed, true);
  assert.equal(env.mock.callsWith('add').length, 0, 'claim never add');
  assert.equal(env.mock.callsWith('remove').length, 0, 'claim zero git writes');
  const frame = await env.registry.load();
  assert.equal(frame.projects.trimetaverse.worktrees.length, 1);
  assert.equal(env.chain.getSnapshot().phaseDetail['project-link'].status, 'linked');
  await rm(env.dir, { recursive: true, force: true });
});

test('claim: project clone (main checkout) → 422 kind=project-clone with upgrade hint', async () => {
  const env = await makeEnv();
  const cloneDir = join(env.dir, 'clone');
  await mkdir(join(cloneDir, '.git'), { recursive: true });
  env.mock.on(['-C', cloneDir, 'remote', 'get-url', 'origin'], { stdout: `${PRESET_URL}\n` });
  const result = await runClaim(env.deps, cloneDir);
  assert.equal(result.status, 422);
  assert.equal((result as { kind: string }).kind, 'project-clone');
  assert.ok((result as { message: string }).message.includes('升级引导'));
  await rm(env.dir, { recursive: true, force: true });
});

test('claim: unlinked / not-found → 422', async () => {
  const env = await makeEnv();
  const plain = join(env.dir, 'plain');
  await mkdir(plain, { recursive: true });
  const r1 = await runClaim(env.deps, plain);
  assert.equal(r1.status, 422);
  assert.equal((r1 as { kind: string }).kind, 'unlinked');
  const r2 = await runClaim(env.deps, join(env.dir, 'nope'));
  assert.equal(r2.status, 422);
  assert.equal((r2 as { kind: string }).kind, 'not-found');
  await rm(env.dir, { recursive: true, force: true });
});

// ── 11. inspect 识别分流 ──

test('inspect: managed-worktree / project-clone / unlinked classification', async () => {
  const env = await makeEnv();
  const wtDir = join(env.dir, 'wt');
  await mkdir(wtDir, { recursive: true });
  await writeFile(join(wtDir, '.git'), `gitdir: ${join(env.main, '.git', 'worktrees', 'wt1')}\n`, 'utf-8');
  const cloneDir = join(env.dir, 'clone');
  await mkdir(join(cloneDir, '.git'), { recursive: true });
  const plain = join(env.dir, 'plain');
  await mkdir(plain, { recursive: true });

  env.mock.on(['-C', env.main, 'remote', 'get-url', 'origin'], { stdout: `${PRESET_URL}\n` });
  env.mock.on(['-C', cloneDir, 'remote', 'get-url', 'origin'], { stdout: `${PRESET_URL}\n` });
  env.mock.on(['rev-parse', '--absolute-git-dir'], {
    stdout: `${join(env.main, '.git', 'worktrees', 'wt1')}\n`,
  });
  env.mock.on(['-C', wtDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdout: 'project/trimetaverse\n' });
  env.mock.on(['-C', cloneDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdout: 'dev\n' });

  const managed = await inspectPath(env.deps, wtDir);
  assert.equal(managed.kind, 'managed-worktree');
  assert.equal(managed.projectKey, 'trimetaverse');
  assert.equal(managed.branch, 'project/trimetaverse');
  assert.equal(managed.worktree, true);

  const clone = await inspectPath(env.deps, cloneDir);
  assert.equal(clone.kind, 'project-clone');
  assert.equal(clone.projectKey, 'trimetaverse');
  assert.equal(clone.branch, 'dev');
  assert.equal(clone.worktree, false);

  const unlinked = await inspectPath(env.deps, plain);
  assert.equal(unlinked.kind, 'unlinked');
  assert.equal(unlinked.worktree, false);
  assert.equal((await inspectPath(env.deps, join(env.dir, 'missing'))).kind, 'unlinked');
  await rm(env.dir, { recursive: true, force: true });
});

// ── 12. 幽灵项交叉验证：注册点有而 git 无 → 登记移除（不删磁盘）──

test('cross-validate: registry entry absent from git worktree list is unregistered', async () => {
  const env = await makeEnv();
  mockLocalFlow(env.mock, env.main, env.wt);
  await touchWorktreeDirs(env.main, env.wt); // 真实 add 的磁盘形态（登记不被惰性清理）
  // 预置一个幽灵登记（磁盘目录真实存在、git 已不认识）
  const stalePath = join(env.dir, 'stale-wt');
  await mkdir(stalePath, { recursive: true });
  await env.registry.registerWorktree('trimetaverse', {
    path: stalePath,
    gitdir: join(env.main, '.git', 'worktrees', 'stale'),
    branch: 'project/trimetaverse',
  });
  // worktree list 只含 main + 新 wt（stale 不在）
  const result = await runLink(env.deps, {
    source: 'local',
    localPath: env.main,
    targetPath: env.wt,
    entry: 'daemon',
  });
  assert.equal(result.status, 200);
  const frame = await env.registry.load();
  const paths = frame.projects.trimetaverse.worktrees.map((w) => w.path);
  assert.ok(!paths.includes(stalePath), 'stale registration dropped');
  assert.ok(paths.includes(env.wt), 'new registration kept');
  // 磁盘资产保留
  assert.ok((await stat(stalePath)).isDirectory());
  await rm(env.dir, { recursive: true, force: true });
});

test('cross-validate multi-main: entries owned by another main checkout are kept', async () => {
  const env = await makeEnv();
  mockLocalFlow(env.mock, env.main, env.wt);
  await touchWorktreeDirs(env.main, env.wt);
  // 预置一个他主检出的登记项（gitdir 属主 ≠ 本主 main）
  const otherMain = join(env.dir, 'other-main');
  const otherWt = join(env.dir, 'other-wt');
  await mkdir(join(otherMain, '.git', 'worktrees', 'ow'), { recursive: true });
  await mkdir(otherWt, { recursive: true });
  await env.registry.registerWorktree('trimetaverse', {
    path: otherWt,
    gitdir: join(otherMain, '.git', 'worktrees', 'ow'),
    branch: 'project/trimetaverse',
  });
  const result = await runLink(env.deps, {
    source: 'local',
    localPath: env.main,
    targetPath: env.wt,
    entry: 'daemon',
  });
  assert.equal(result.status, 200);
  const frame = await env.registry.load();
  const paths = frame.projects.trimetaverse.worktrees.map((w) => w.path);
  assert.ok(paths.includes(otherWt), 'other-main entry kept (not a ghost)');
  assert.ok(paths.includes(env.wt), 'new registration kept');
  await rm(env.dir, { recursive: true, force: true });
});
