// ── InitChain tests（I1: init-collab-i1-statemachine）──
// 覆盖（i1-2 任务包 §五）：转移函数全对 / mid-phase 崩溃恢复（断点续跑）/
// 原子写（rename 生效 + 校验读回）/ status 端点 = 事件流最后一帧一致性。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InitChain,
  CHAIN_STATES,
  isValidTransition,
  type ChainState,
} from "../src/company/init-chain.js";

import type { LocalBusEvent as BusEvent } from "../src/localbus/bus.js";

function eventCollector() {
  const events: BusEvent[] = [];
  const onEvent = (e: BusEvent) => events.push(e);
  return { events, onEvent };
}

async function freshChain(): Promise<{ dir: string; chain: InitChain }> {
  const dir = await mkdtemp(join(tmpdir(), "init-chain-test-"));
  return { dir, chain: new InitChain(dir) };
}

// ── 1. 转移函数全对 ──

const VALID_PAIRS: Array<[ChainState, ChainState]> = [
  ['uninitialized', 'selfcheck'],
  ['selfcheck', 'onboarding'],
  ['onboarding', 'project-link'],
  ['project-link', 'sync'],
  ['sync', 'confirm'],
  ['confirm', 'ready'],
];

test("transition matrix: only linear forward single-steps are valid", () => {
  for (const from of CHAIN_STATES) {
    for (const to of CHAIN_STATES) {
      const expected = VALID_PAIRS.some(([f, t]) => f === from && t === to);
      assert.equal(
        isValidTransition(from, to),
        expected,
        `isValidTransition(${from}, ${to}) should be ${expected}`,
      );
    }
  }
});

test("invalid transitions throw and do not persist", async () => {
  const { dir, chain } = await freshChain();
  await chain.load();
  // 回退
  await assert.rejects(chain.transitionTo('uninitialized', 'daemon'), /invalid init-chain transition/);
  // 跳级
  await assert.rejects(chain.transitionTo('onboarding', 'daemon'), /invalid init-chain transition/);
  // 非法转移不落盘：文件还不存在
  const filesBefore = await readdir(join(dir, 'company')).catch(() => []);
  assert.equal(filesBefore.includes('init-chain.json'), false);
  // 合法单步后：自环 / 跳级 / 回退均非法，且不覆盖已落盘帧
  await chain.transitionTo('selfcheck', 'daemon');
  await assert.rejects(chain.transitionTo('selfcheck', 'daemon'), /invalid init-chain transition/);
  await assert.rejects(chain.transitionTo('sync', 'daemon'), /invalid init-chain transition/);
  await assert.rejects(chain.transitionTo('uninitialized', 'daemon'), /invalid init-chain transition/);
  assert.equal(chain.getState(), 'selfcheck');
  const raw = await readFile(join(dir, 'company', 'init-chain.json'), 'utf-8');
  assert.equal(JSON.parse(raw).chainState, 'selfcheck', '非法转移不覆盖落盘帧');
  await rm(dir, { recursive: true, force: true });
});

test("full forward walk: eventSeq 1..6, transitions published with correct frames", async () => {
  const { dir, chain } = await freshChain();
  const { events, onEvent } = eventCollector();
  const wired = new InitChain(dir, { onEvent });
  await wired.load();

  let expectSeq = 0;
  for (const [from, to] of VALID_PAIRS) {
    const before = wired.getState();
    assert.equal(before, from);
    const frame = await wired.transitionTo(to, 'daemon');
    expectSeq += 1;
    assert.equal(frame.eventSeq, expectSeq);
    assert.equal(frame.chainState, to);
    assert.ok(frame.lastTransitionAt, 'lastTransitionAt set');
    assert.ok(frame.lastUpdatedAt, 'lastUpdatedAt set');
    assert.equal(frame.sourceEntry, 'daemon');
  }

  // 发布事件 = 转移序列投影，eventSeq 与状态文件一致
  const published = events.filter((e) => e.type === 'init:chain-changed');
  assert.equal(published.length, 6);
  for (let i = 0; i < 6; i++) {
    const e = published[i] as Extract<BusEvent, { type: 'init:chain-changed' }>;
    assert.equal(e.from, VALID_PAIRS[i][0]);
    assert.equal(e.to, VALID_PAIRS[i][1]);
    assert.equal(e.eventSeq, i + 1);
    assert.equal(e.chainState, e.to);
  }

  // ready 为终态：无出边
  assert.equal(isValidTransition('ready', 'selfcheck'), false);
  await assert.rejects(wired.transitionTo('selfcheck', 'daemon'), /invalid/);
  await rm(dir, { recursive: true, force: true });
});

// ── 2. mid-phase 崩溃恢复（断点续跑）──

test("mid-phase crash recovery: resume from persisted frame", async () => {
  const { dir } = await freshChain();
  // 实例 A：走到 onboarding 并写入 selfcheck 快照后「崩溃」
  const chainA = new InitChain(dir);
  await chainA.load();
  await chainA.transitionTo('selfcheck', 'daemon');
  await chainA.updateSelfcheck({
    runId: 'sc_crash_test',
    summary: 'degraded',
    checks: [{ id: 'healthz', status: 'ok', detail: 'ok', hint: '' }],
    finishedAt: '2026-08-14T10:00:00.000Z',
    retryCount: 1,
  });
  await chainA.transitionTo('onboarding', 'tripilot');
  const seqBeforeCrash = chainA.getSnapshot().eventSeq;
  assert.equal(seqBeforeCrash, 3);

  // 实例 B（新进程模拟）：load 恢复同一帧
  const chainB = new InitChain(dir);
  const frame = await chainB.load();
  assert.equal(frame.chainState, 'onboarding');
  assert.equal(frame.eventSeq, 3);
  assert.equal(frame.phaseDetail.selfcheck.runId, 'sc_crash_test');
  assert.equal(frame.phaseDetail.selfcheck.checks[0].id, 'healthz');
  assert.equal(frame.phaseDetail.onboarding.ref, 'company/state.json#progress');
  assert.equal(frame.sourceEntry, 'tripilot');

  // 续跑：从 onboarding 继续
  await chainB.transitionTo('project-link', 'daemon');
  assert.equal(chainB.getSnapshot().eventSeq, 4);
  await rm(dir, { recursive: true, force: true });
});

test("missing file loads default uninitialized frame (idempotent)", async () => {
  const { dir, chain } = await freshChain();
  const f1 = await chain.load();
  assert.equal(f1.chainState, 'uninitialized');
  assert.equal(f1.eventSeq, 0);
  assert.equal(f1.phaseDetail.onboarding.ref, 'company/state.json#progress');
  const f2 = await chain.load();
  assert.equal(f2, f1, 'load 幂等（缓存同帧）');
  await rm(dir, { recursive: true, force: true });
});

// ── 5. load() ENOENT vs 解析错（I1 前置强制项③，i2-1 拆解 §六）──

test("load() 三件套①：文件缺失 → 默认帧且无 .corrupt 生成（静默）", async () => {
  const { dir, chain } = await freshChain();
  const errorLogs: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { errorLogs.push(args.map(String).join(' ')); };
  try {
    const f = await chain.load();
    assert.equal(f.chainState, 'uninitialized', 'ENOENT → 默认帧');
    assert.equal(errorLogs.length, 0, 'ENOENT 不产噪音日志');
    const files = await readdir(join(dir, 'company')).catch(() => []);
    assert.equal(files.some((x) => x.endsWith('.corrupt')), false, '无 .corrupt 生成');
  } finally {
    console.error = origError;
    await rm(dir, { recursive: true, force: true });
  }
});

test("load() 三件套②：非法 JSON → .corrupt 备份 + 默认帧 + console.error", async () => {
  const { dir, chain } = await freshChain();
  const companyDir = join(dir, 'company');
  await mkdir(companyDir, { recursive: true });
  const corruptContent = '{ "chainState": "onboarding", broken';
  await writeFile(join(companyDir, 'init-chain.json'), corruptContent, 'utf-8');

  const errorLogs: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { errorLogs.push(args.map(String).join(' ')); };
  try {
    const f = await chain.load();
    assert.equal(f.chainState, 'uninitialized', '解析错 → 默认帧（daemon 不崩溃启动）');
    const files = await readdir(companyDir);
    assert.equal(files.includes('init-chain.json.corrupt'), true, '.corrupt 保留损坏现场');
    const backup = await readFile(join(companyDir, 'init-chain.json.corrupt'), 'utf-8');
    assert.equal(backup, corruptContent, '.corrupt 内容 = 原始损坏字节');
    assert.ok(
      errorLogs.some((l) => l.includes('parse failed') && l.includes('.corrupt')),
      `console.error 含 parse failed + .corrupt 路径（got: ${errorLogs.join(' | ')}）`,
    );
  } finally {
    console.error = origError;
    await rm(dir, { recursive: true, force: true });
  }
});

test("load() 三件套③：合法 JSON 正常加载（回归，且不覆盖既有 .corrupt）", async () => {
  const { dir, chain } = await freshChain();
  const companyDir = join(dir, 'company');
  await mkdir(companyDir, { recursive: true });
  const frame = {
    schemaVersion: 1,
    chainState: 'onboarding',
    phaseDetail: {
      selfcheck: { runId: 'sc_reg', summary: 'pass', checks: [], finishedAt: '2026-08-14T10:00:00.000Z', retryCount: 1 },
      onboarding: { step: null, ref: 'company/state.json#progress' },
      'project-link': { status: 'pending', source: null, projectKey: null, worktreePath: null },
      sync: { status: 'pending', bundleId: null },
      confirm: { status: 'pending', l1: null, l2: null, l3: null },
      ready: { firstCollab: 'pending' },
    },
    lastTransitionAt: '2026-08-14T10:00:00.000Z',
    lastUpdatedAt: '2026-08-14T10:00:00.000Z',
    eventSeq: 3,
    sourceEntry: 'tripilot',
  };
  await writeFile(join(companyDir, 'init-chain.json'), JSON.stringify(frame), 'utf-8');

  const f = await chain.load();
  assert.equal(f.chainState, 'onboarding', '合法 JSON 正常加载');
  assert.equal(f.eventSeq, 3);
  assert.equal(f.phaseDetail.selfcheck.runId, 'sc_reg');
  assert.equal(f.sourceEntry, 'tripilot');
  const files = await readdir(companyDir);
  assert.equal(files.some((x) => x.endsWith('.corrupt')), false, '合法加载不产 .corrupt');
  await rm(dir, { recursive: true, force: true });
});

// ── 3. 原子写（rename 生效 + 校验读回）──

test("atomic write: no tmp residue, content read-back verified, eventSeq monotonic", async () => {
  const { dir, chain } = await freshChain();
  await chain.load();
  await chain.transitionTo('selfcheck', 'daemon');
  await chain.updateSelfcheck({ runId: 'sc_atomic', summary: 'pass', retryCount: 1 });
  await chain.updateSelfcheck({ runId: 'sc_atomic', summary: 'pass', retryCount: 2 });

  const companyDir = join(dir, 'company');
  const files = await readdir(companyDir);
  assert.equal(files.includes('init-chain.json'), true, '状态文件存在');
  assert.equal(files.some((f) => f.endsWith('.tmp')), false, '无 tmp 残留（真 rename）');

  const raw = await readFile(join(companyDir, 'init-chain.json'), 'utf-8');
  const disk = JSON.parse(raw);
  const snap = chain.getSnapshot();
  assert.equal(disk.eventSeq, snap.eventSeq, '读回 eventSeq 一致');
  assert.equal(disk.chainState, snap.chainState, '读回 chainState 一致');
  assert.equal(disk.phaseDetail.selfcheck.retryCount, 2, '读回 phaseDetail 一致');
  assert.equal(snap.eventSeq, 3, 'eventSeq 单调（1 转移 + 2 快照回写）');
  await rm(dir, { recursive: true, force: true });
});

// ── 4. status 端点 = 事件流最后一帧一致性 ──

test("status payload matches last published event frame", async () => {
  const { dir } = await freshChain();
  const { events, onEvent } = eventCollector();
  const chain = new InitChain(dir, { onEvent });
  await chain.load();
  await chain.transitionTo('selfcheck', 'tripilot');
  await chain.transitionTo('onboarding', 'trilc-chat');

  const payload = chain.toStatusPayload();
  const published = events.filter((e) => e.type === 'init:chain-changed');
  const lastEvent = published[published.length - 1] as Extract<BusEvent, { type: 'init:chain-changed' }>;

  assert.equal(payload.chainState, lastEvent.chainState, 'chainState 同帧');
  assert.equal(payload.eventSeq, lastEvent.eventSeq, 'eventSeq 同帧');
  assert.equal(payload.sourceEntry, lastEvent.sourceEntry, 'sourceEntry 同帧');
  assert.equal(payload.chainState, 'onboarding');
  assert.equal(payload.eventSeq, chain.getSnapshot().eventSeq);
  assert.equal(payload.schemaVersion, 1);
  await rm(dir, { recursive: true, force: true });
});
