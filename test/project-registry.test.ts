// ── ProjectRegistry tests（I3: init-collab-i3-project-registry）──
// 覆盖（i3-2 任务包 §五）：预置表默认帧 / 原子写（tmp→rename + 校验读回 + 无
// tmp 残留）/ 主键去重（同键幂等、键冲突拒绝）/ 惰性清理（幽灵项登记移除、
// 不删磁盘）/ activeProjectKey 焦点语义 / 固定路径与测试隔离 env 覆盖 /
// 文件显式值覆盖 hasNpmFileDeps 门禁标记（现场纠偏安全阀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProjectRegistry,
  BUILTIN_PROJECTS,
  defaultRegistryFile,
  defaultRegistryPath,
} from '../src/project/project-registry.js';

async function freshRegistry(): Promise<{ dir: string; registry: ProjectRegistry }> {
  const dir = await mkdtemp(join(tmpdir(), 'project-registry-test-'));
  return { dir, registry: new ProjectRegistry({ registryPath: join(dir, 'project-registry.json') }) };
}

test('default frame: preset table merged with empty runtime state (no file written on bare load)', async () => {
  const { dir, registry } = await freshRegistry();
  const frame = await registry.load();
  assert.equal(frame.schemaVersion, 1);
  assert.equal(frame.activeProjectKey, null);
  assert.ok(frame.projects.trimetaverse, 'preset project present');
  assert.equal(frame.projects.trimetaverse.repoUrl, BUILTIN_PROJECTS.trimetaverse.repoUrl);
  assert.equal(frame.projects.trimetaverse.hasNpmFileDeps, false);
  assert.equal(frame.projects.trimetaverse.defaultBranch, 'dev');
  assert.equal(frame.projects.trimetaverse.mainCheckoutPath, null);
  assert.deepEqual(frame.projects.trimetaverse.worktrees, []);
  // 裸 load（无清理无写）不落盘
  await assert.rejects(stat(join(dir, 'project-registry.json')));
  await rm(dir, { recursive: true, force: true });
});

test('atomic write: register persists via tmp→rename, content read-back correct, no tmp residue', async () => {
  const { dir, registry } = await freshRegistry();
  await registry.registerWorktree('trimetaverse', {
    path: join(dir, 'wt1'),
    gitdir: join(dir, 'main', '.git', 'worktrees', 'wt1'),
    branch: 'project/trimetaverse',
  });
  const files = await readdir(dir);
  assert.ok(files.includes('project-registry.json'), 'registry file exists');
  assert.ok(!files.some((f) => f.endsWith('.tmp')), 'no tmp residue');
  const raw = JSON.parse(await readFile(join(dir, 'project-registry.json'), 'utf-8'));
  assert.equal(raw.schemaVersion, 1);
  assert.equal(raw.activeProjectKey, 'trimetaverse', 'register sets focus project');
  assert.equal(raw.projects.trimetaverse.worktrees.length, 1);
  assert.equal(raw.projects.trimetaverse.worktrees[0].branch, 'project/trimetaverse');
  assert.ok(raw.projects.trimetaverse.worktrees[0].claimedAt, 'claimedAt recorded');
  await rm(dir, { recursive: true, force: true });
});

test('primary-key dedup: same path+gitdir idempotent refresh; key conflicts rejected', async () => {
  const { dir, registry } = await freshRegistry();
  const path1 = join(dir, 'wt1');
  const gitdir1 = join(dir, 'main', '.git', 'worktrees', 'wt1');
  await registry.registerWorktree('trimetaverse', { path: path1, gitdir: gitdir1, branch: 'project/trimetaverse' });

  // 同键重复 = 幂等刷新（认领绝不重复 add 的登记面）
  const again = await registry.registerWorktree('trimetaverse', { path: path1, gitdir: gitdir1, branch: 'project/trimetaverse' });
  assert.equal(again.projects.trimetaverse.worktrees.length, 1);

  // 同路径异 gitdir → 拒绝
  await assert.rejects(
    registry.registerWorktree('trimetaverse', { path: path1, gitdir: join(dir, 'other', '.git', 'worktrees', 'x'), branch: 'x' }),
    /primary-key conflict/,
  );
  // 异路径同 gitdir → 拒绝
  await assert.rejects(
    registry.registerWorktree('trimetaverse', { path: join(dir, 'wt2'), gitdir: gitdir1, branch: 'x' }),
    /primary-key conflict/,
  );
  // 冲突拒绝后帧不变
  const frame = await registry.load();
  assert.equal(frame.projects.trimetaverse.worktrees.length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('lazy cleanup: ghost entries dropped from registration, disk assets preserved', async () => {
  const { dir, registry } = await freshRegistry();
  const livePath = join(dir, 'live-wt');
  const ghostPath = join(dir, 'gone-wt');
  const noGitdirPath = join(dir, 'nogitdir-wt');
  await mkdir(livePath, { recursive: true });
  await mkdir(noGitdirPath, { recursive: true }); // 目录在、gitdir 不在
  await mkdir(join(livePath, '.git', 'worktrees', 'x'), { recursive: true });
  await mkdir(join(dir, 'main', '.git', 'worktrees'), { recursive: true });
  await writeFile(
    join(dir, 'project-registry.json'),
    JSON.stringify({
      schemaVersion: 1,
      activeProjectKey: 'trimetaverse',
      projects: {
        trimetaverse: {
          repoUrl: 'https://github.com/MoRen9527/TriMetaverse.git',
          hasNpmFileDeps: false,
          defaultBranch: 'dev',
          mainCheckoutPath: null,
          worktrees: [
            { path: livePath, gitdir: join(livePath, '.git', 'worktrees', 'x'), branch: 'project/trimetaverse', claimedAt: '2026-08-14T00:00:00Z' },
            { path: ghostPath, gitdir: join(dir, 'gone', '.git', 'worktrees', 'y'), branch: 'project/trimetaverse', claimedAt: '2026-08-14T00:00:00Z' },
            { path: noGitdirPath, gitdir: join(dir, 'missing', '.git', 'worktrees', 'z'), branch: 'project/trimetaverse', claimedAt: '2026-08-14T00:00:00Z' },
          ],
        },
      },
    }, null, 2),
    'utf-8',
  );

  const frame = await registry.load();
  assert.equal(frame.projects.trimetaverse.worktrees.length, 1, 'ghost entries dropped');
  assert.equal(frame.projects.trimetaverse.worktrees[0].path, livePath, 'live entry kept');
  // 清理持久化：文件读回同帧
  const raw = JSON.parse(await readFile(join(dir, 'project-registry.json'), 'utf-8'));
  assert.equal(raw.projects.trimetaverse.worktrees.length, 1);
  // 磁盘资产保留（幽灵路径只登记移除，不删磁盘）
  const st = await stat(noGitdirPath);
  assert.ok(st.isDirectory(), 'disk dir preserved (registration-only removal)');
  await rm(dir, { recursive: true, force: true });
});

test('file explicit hasNpmFileDeps=true overrides preset default (gate safety valve)', async () => {
  const { dir, registry } = await freshRegistry();
  await writeFile(
    join(dir, 'project-registry.json'),
    JSON.stringify({
      schemaVersion: 1,
      activeProjectKey: null,
      projects: {
        trimetaverse: {
          repoUrl: 'https://github.com/MoRen9527/TriMetaverse.git',
          hasNpmFileDeps: true,
          defaultBranch: 'dev',
          mainCheckoutPath: null,
          worktrees: [],
        },
      },
    }, null, 2),
    'utf-8',
  );
  const frame = await registry.load();
  assert.equal(frame.projects.trimetaverse.hasNpmFileDeps, true, 'file override honored');
  // repoUrl 恒以预置为准（白名单完整性）
  assert.equal(frame.projects.trimetaverse.repoUrl, BUILTIN_PROJECTS.trimetaverse.repoUrl);
  await rm(dir, { recursive: true, force: true });
});

test('fixed path: default resolves to %LOCALAPPDATA%/trilc/project-registry.json; TRILC_PROJECT_REGISTRY overrides (test isolation)', async () => {
  const def = defaultRegistryPath();
  assert.ok(def.endsWith(join('trilc', 'project-registry.json')), `fixed path shape: ${def}`);
  // 默认帧函数纯内存
  const frame = defaultRegistryFile();
  assert.ok(frame.projects.trimetaverse);
  // env 覆盖：构造时生效（生产无此 env → 恒固定路径）
  const prev = process.env.TRILC_PROJECT_REGISTRY;
  process.env.TRILC_PROJECT_REGISTRY = join(tmpdir(), 'isolated-reg.json');
  try {
    const isolated = new ProjectRegistry();
    assert.equal(isolated.path, join(tmpdir(), 'isolated-reg.json'));
  } finally {
    if (prev === undefined) delete process.env.TRILC_PROJECT_REGISTRY;
    else process.env.TRILC_PROJECT_REGISTRY = prev;
  }
});

test('unknown project key rejected on register', async () => {
  const { dir, registry } = await freshRegistry();
  await assert.rejects(
    registry.registerWorktree('nope', { path: join(dir, 'wt'), gitdir: join(dir, 'gd'), branch: 'x' }),
    /unknown project key/,
  );
  await rm(dir, { recursive: true, force: true });
});

test('unregister removes registration only (no disk mutation)', async () => {
  const { dir, registry } = await freshRegistry();
  const path1 = join(dir, 'wt1');
  await mkdir(path1, { recursive: true });
  await registry.registerWorktree('trimetaverse', { path: path1, gitdir: join(dir, 'gd1'), branch: 'project/trimetaverse' });
  await registry.unregisterWorktree('trimetaverse', path1);
  const frame = await registry.load();
  assert.equal(frame.projects.trimetaverse.worktrees.length, 0);
  const st = await stat(path1);
  assert.ok(st.isDirectory(), 'disk dir preserved');
  await rm(dir, { recursive: true, force: true });
});
