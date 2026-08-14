// ── InitSelfcheck tests（I1: init-collab-i1-statemachine）──
// 覆盖（i1-2 任务包 §五）：五探测 mock / summary 规则（401 唯一 blocked 级）/
// 防重入 / tripilot 存活计数 / 第五探测红行（r19 前置缺陷显式暴露）。

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initKeyCache, stopKeyCache } from "../src/config/key-cache.js";
import { localBus } from "../src/localbus/bus.js";
import { InitChain } from "../src/company/init-chain.js";
import {
  beginSelfcheck,
  isSelfcheckRunning,
  getActiveRunId,
  getRecentSubmissionCount,
  recordTaskSubmission,
  resetSelfcheckForTest,
  summarize,
  type SelfcheckDeps,
} from "../src/company/init-selfcheck.js";

// ── helpers ──

const PORT = 8711;

const SSE_OK =
  'event: delta\ndata: {"content":"2026-W33"}\n\nevent: task_done\ndata: {"status":"success"}\n\n';
const SSE_EMPTY = 'event: task_done\ndata: {"status":"success"}\n\n';
const SSE_ERROR = 'event: task_error\ndata: {"status":"failed","error":"401 Unauthorized"}\n\n';

type MockFetch = (url: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  body?: unknown;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

function jsonRes(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, body: {}, json: async () => body, text: async () => JSON.stringify(body) };
}

function sseRes(text: string) {
  return { ok: true, status: 200, body: {}, json: async () => ({}), text: async () => text };
}

const realFetch = globalThis.fetch;

function setMockFetch(handler: MockFetch): void {
  globalThis.fetch = handler as unknown as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function newDeps(): Promise<{ dir: string; deps: SelfcheckDeps; events: Array<{ type: string } & Record<string, unknown>> }> {
  const dir = await mkdtemp(join(tmpdir(), "init-selfcheck-test-"));
  const events: Array<{ type: string } & Record<string, unknown>> = [];
  const chain = new InitChain(dir, {
    onEvent: (e) => events.push(e as { type: string } & Record<string, unknown>),
  });
  await chain.load();
  const deps: SelfcheckDeps = {
    port: PORT,
    projectRoot: dir,
    chain,
    publish: (e) => events.push(e as { type: string } & Record<string, unknown>),
    probeSystemPrompt: 'TEST-PROMPT',
  };
  return { dir, deps, events };
}

/** 种子 key-cache（探测需读到存活缓存——stopKeyCache 会置空，只能在 finally 收尾调）。 */
async function seedKeyCache(dataDir: string): Promise<void> {
  await initKeyCache(`http://127.0.0.1:${PORT}`, dataDir, 'test-token');
}

// 五探测全 ok 的 fetch mock（key-cache 种子 fetch + 探测 fetch 同一 handler）
function allOkFetch(seedDataDir: string): MockFetch {
  return async (url, init) => {
    const u = String(url);
    if (u.includes('/v1/config/keys')) {
      return jsonRes(200, { keys: { deepseek: { api_key: 'test-key-123' } }, default_model: 'tmv-deepseek-v4-pro', refresh_interval_s: 900 });
    }
    if (u.includes('/healthz')) return jsonRes(200, { ok: true, service: 'trilc', uptime: 5 });
    if (u.includes('127.0.0.1:3333/health')) return jsonRes(200, { ok: true });
    if (u.includes('127.0.0.1:8008/v1/models')) return jsonRes(200, { data: [{ id: 'tmv-deepseek-v4-pro' }] });
    if (u.includes('/internal/v1/tasks/submit')) {
      localBus.emit('event', { type: 'task:queued', taskId: 'sess_test' });
      return jsonRes(201, { sessionId: 'sess_test' });
    }
    if (u.includes('/stream')) {
      localBus.emit('event', { type: 'task:running', taskId: 'sess_test' });
      localBus.emit('event', { type: 'task:succeeded', taskId: 'sess_test', result: { summary: 'ok' } });
      return sseRes(SSE_OK);
    }
    void init; void seedDataDir;
    return jsonRes(404, { error: 'unexpected url ' + u });
  };
}

// ── tests ──

beforeEach(() => {
  resetSelfcheckForTest();
});

test('summarize rules: fail→blocked / degraded-only→degraded / all-ok→pass', () => {
  const ok = { id: 'x', status: 'ok' as const, detail: '', hint: '' };
  const degraded = { id: 'x', status: 'degraded' as const, detail: '', hint: '' };
  const fail = { id: 'x', status: 'fail' as const, detail: '', hint: '' };
  assert.equal(summarize([ok, ok]), 'pass');
  assert.equal(summarize([ok, degraded]), 'degraded');
  assert.equal(summarize([ok, fail]), 'blocked');
  assert.equal(summarize([degraded, fail]), 'blocked');
});

test('tripilot counter: recent-window counting + expiry', () => {
  resetSelfcheckForTest();
  recordTaskSubmission();
  assert.equal(getRecentSubmissionCount(), 1);
  assert.equal(getRecentSubmissionCount(Date.now() + 11 * 60 * 1000), 0, '11 分钟前窗口外应剪枝');
});

test('five probes all-ok → summary pass, finished event + chain snapshot persisted', async () => {
  const { dir, deps, events } = await newDeps();
  try {
    setMockFetch(allOkFetch(dir));
    recordTaskSubmission(); // tripilot 被动观察面：近 10 分钟有提交 → ok
    await seedKeyCache(dir);

    const started = beginSelfcheck(deps);
    assert.equal(started.conflict, false);
    assert.ok(started.runId);
    await waitFor(() => !isSelfcheckRunning());

    const progress = events.filter((e) => e.type === 'init:selfcheck-progress');
    assert.equal(progress.length, 5, '五探测各发 progress');
    assert.deepEqual(progress.map((e) => e.checkId), ['healthz', 'tripilot', 'trimodel', 'tristaciss', 'plane-hint-probe']);

    const finished = events.find((e) => e.type === 'init:selfcheck-finished');
    assert.ok(finished, 'finished 事件');
    assert.equal(finished.summary, 'pass');

    const snap = deps.chain.getSnapshot();
    assert.equal(snap.phaseDetail.selfcheck.summary, 'pass');
    assert.equal(snap.phaseDetail.selfcheck.runId, started.runId);
    assert.equal(snap.phaseDetail.selfcheck.retryCount, 1);
    assert.equal(snap.phaseDetail.selfcheck.checks.length, 5);
    assert.ok(snap.phaseDetail.selfcheck.checks.every((c) => c.status === 'ok'));
  } finally {
    restoreFetch();
    stopKeyCache();
    await rm(dir, { recursive: true, force: true });
  }
});

test('key-cache 401 → trimodel fail → summary blocked（401 唯一认证阻塞类）', async () => {
  const { dir, deps, events } = await newDeps();
  try {
    setMockFetch(async (url) => {
      const u = String(url);
      if (u.includes('/v1/config/keys')) return jsonRes(401, { error: 'Unauthorized' });
      if (u.includes('/healthz')) return jsonRes(200, { ok: true, service: 'trilc', uptime: 5 });
      if (u.includes('127.0.0.1:3333/health')) return jsonRes(200, { ok: true });
      if (u.includes('127.0.0.1:8008/v1/models')) return jsonRes(200, { data: [{ id: 'm' }] });
      if (u.includes('/internal/v1/tasks/submit')) {
        localBus.emit('event', { type: 'task:queued', taskId: 'sess_test' });
        return jsonRes(201, { sessionId: 'sess_test' });
      }
      if (u.includes('/stream')) {
        localBus.emit('event', { type: 'task:running', taskId: 'sess_test' });
        localBus.emit('event', { type: 'task:succeeded', taskId: 'sess_test', result: { summary: 'ok' } });
        return sseRes(SSE_OK);
      }
      return jsonRes(404, { error: 'unexpected ' + u });
    });
    recordTaskSubmission();
    await seedKeyCache(dir);

    beginSelfcheck(deps);
    await waitFor(() => !isSelfcheckRunning());

    const finished = events.find((e) => e.type === 'init:selfcheck-finished');
    assert.equal(finished.summary, 'blocked');
    const checks = deps.chain.getSnapshot().phaseDetail.selfcheck.checks;
    const trimodel = checks.find((c) => c.id === 'trimodel');
    assert.equal(trimodel?.status, 'fail', '401 → trimodel fail（blocked 级）');
    assert.ok(/401/.test(trimodel?.detail ?? ''), 'detail 含 401 证据');
  } finally {
    restoreFetch();
    stopKeyCache();
    await rm(dir, { recursive: true, force: true });
  }
});

test('tristaciss unreachable → degraded-only → summary degraded（降级继续）', async () => {
  const { dir, deps, events } = await newDeps();
  try {
    setMockFetch(async (url) => {
      const u = String(url);
      if (u.includes('/v1/config/keys')) return jsonRes(200, { keys: { deepseek: { api_key: 'k' } }, default_model: 'tmv-deepseek-v4-pro', refresh_interval_s: 900 });
      if (u.includes('/healthz')) return jsonRes(200, { ok: true, service: 'trilc', uptime: 5 });
      if (u.includes('127.0.0.1:3333/health')) return jsonRes(200, { ok: true });
      if (u.includes('127.0.0.1:8008/v1/models')) throw new Error('ECONNREFUSED');
      if (u.includes('/internal/v1/tasks/submit')) {
        localBus.emit('event', { type: 'task:queued', taskId: 'sess_test' });
        return jsonRes(201, { sessionId: 'sess_test' });
      }
      if (u.includes('/stream')) {
        localBus.emit('event', { type: 'task:running', taskId: 'sess_test' });
        localBus.emit('event', { type: 'task:succeeded', taskId: 'sess_test', result: { summary: 'ok' } });
        return sseRes(SSE_OK);
      }
      return jsonRes(404, { error: 'unexpected ' + u });
    });
    recordTaskSubmission();
    await seedKeyCache(dir);

    beginSelfcheck(deps);
    await waitFor(() => !isSelfcheckRunning());

    const finished = events.find((e) => e.type === 'init:selfcheck-finished');
    assert.equal(finished.summary, 'degraded');
    const tristaciss = deps.chain.getSnapshot().phaseDetail.selfcheck.checks.find((c) => c.id === 'tristaciss');
    assert.equal(tristaciss?.status, 'degraded', 'tristaciss fail = degraded（直连 fallback 过渡）');
  } finally {
    restoreFetch();
    stopKeyCache();
    await rm(dir, { recursive: true, force: true });
  }
});

test('plane-hint probe: task:failed → 显式红行（分类=模型链族）', async () => {
  const { dir, deps } = await newDeps();
  try {
    setMockFetch(async (url) => {
      const u = String(url);
      if (u.includes('/v1/config/keys')) return jsonRes(200, { keys: { deepseek: { api_key: 'k' } }, default_model: 'tmv-deepseek-v4-pro', refresh_interval_s: 900 });
      if (u.includes('/healthz')) return jsonRes(200, { ok: true, service: 'trilc', uptime: 5 });
      if (u.includes('127.0.0.1:3333/health')) return jsonRes(200, { ok: true });
      if (u.includes('127.0.0.1:8008/v1/models')) return jsonRes(200, { data: [{ id: 'm' }] });
      if (u.includes('/internal/v1/tasks/submit')) {
        localBus.emit('event', { type: 'task:queued', taskId: 'sess_test' });
        return jsonRes(201, { sessionId: 'sess_test' });
      }
      if (u.includes('/stream')) {
        localBus.emit('event', { type: 'task:running', taskId: 'sess_test' });
        localBus.emit('event', { type: 'task:failed', taskId: 'sess_test', error: '401 Unauthorized: invalid key' });
        return sseRes(SSE_ERROR);
      }
      return jsonRes(404, { error: 'unexpected ' + u });
    });
    recordTaskSubmission();
    await seedKeyCache(dir);

    beginSelfcheck(deps);
    await waitFor(() => !isSelfcheckRunning());

    const probe = deps.chain.getSnapshot().phaseDetail.selfcheck.checks.find((c) => c.id === 'plane-hint-probe');
    assert.equal(probe?.status, 'fail', '第五探测红行不静默');
    assert.ok(/问周面路径/.test(probe?.detail ?? ''), '红行引用问周面路径');
    assert.ok(/模型链族（认证\/key 面）/.test(probe?.hint ?? ''), '分类面');
  } finally {
    restoreFetch();
    stopKeyCache();
    await rm(dir, { recursive: true, force: true });
  }
});

test('plane-hint probe: 零答复伪成功 → fail（A3 红行，不静默吞）', async () => {
  const { dir, deps } = await newDeps();
  try {
    setMockFetch(async (url) => {
      const u = String(url);
      if (u.includes('/v1/config/keys')) return jsonRes(200, { keys: { deepseek: { api_key: 'k' } }, default_model: 'tmv-deepseek-v4-pro', refresh_interval_s: 900 });
      if (u.includes('/healthz')) return jsonRes(200, { ok: true, service: 'trilc', uptime: 5 });
      if (u.includes('127.0.0.1:3333/health')) return jsonRes(200, { ok: true });
      if (u.includes('127.0.0.1:8008/v1/models')) return jsonRes(200, { data: [{ id: 'm' }] });
      if (u.includes('/internal/v1/tasks/submit')) {
        localBus.emit('event', { type: 'task:queued', taskId: 'sess_test' });
        return jsonRes(201, { sessionId: 'sess_test' });
      }
      if (u.includes('/stream')) {
        localBus.emit('event', { type: 'task:running', taskId: 'sess_test' });
        localBus.emit('event', { type: 'task:succeeded', taskId: 'sess_test', result: { summary: 'ok' } });
        return sseRes(SSE_EMPTY);
      }
      return jsonRes(404, { error: 'unexpected ' + u });
    });
    recordTaskSubmission();
    await seedKeyCache(dir);

    beginSelfcheck(deps);
    await waitFor(() => !isSelfcheckRunning());

    const probe = deps.chain.getSnapshot().phaseDetail.selfcheck.checks.find((c) => c.id === 'plane-hint-probe');
    assert.equal(probe?.status, 'fail');
    assert.ok(/零答复内容/.test(probe?.detail ?? ''), '伪成功显式红行');
  } finally {
    restoreFetch();
    stopKeyCache();
    await rm(dir, { recursive: true, force: true });
  }
});

test('anti-reentry: running 中再触发 → conflict + 同 runId；完成后复位', async () => {
  const { dir, deps, events } = await newDeps();
  try {
    const gate = deferred<unknown>();
    setMockFetch(async (url) => {
      const u = String(url);
      if (u.includes('/v1/config/keys')) return jsonRes(200, { keys: { deepseek: { api_key: 'k' } }, default_model: 'tmv-deepseek-v4-pro', refresh_interval_s: 900 });
      if (u.includes('/healthz')) return gate.promise.then(() => jsonRes(200, { ok: true, service: 'trilc', uptime: 5 }));
      if (u.includes('127.0.0.1:3333/health')) return jsonRes(200, { ok: true });
      if (u.includes('127.0.0.1:8008/v1/models')) return jsonRes(200, { data: [{ id: 'm' }] });
      if (u.includes('/internal/v1/tasks/submit')) {
        localBus.emit('event', { type: 'task:queued', taskId: 'sess_test' });
        return jsonRes(201, { sessionId: 'sess_test' });
      }
      if (u.includes('/stream')) {
        localBus.emit('event', { type: 'task:running', taskId: 'sess_test' });
        localBus.emit('event', { type: 'task:succeeded', taskId: 'sess_test', result: { summary: 'ok' } });
        return sseRes(SSE_OK);
      }
      return jsonRes(404, { error: 'unexpected ' + u });
    });
    recordTaskSubmission();
    await seedKeyCache(dir);

    const first = beginSelfcheck(deps);
    assert.equal(first.conflict, false);
    assert.ok(isSelfcheckRunning());
    assert.equal(getActiveRunId(), first.runId);

    // 运行中再触发 → 防重入
    const second = beginSelfcheck(deps);
    assert.equal(second.conflict, true);
    assert.equal(second.runId, first.runId, '409 返回同一 runId');

    gate.resolve(undefined);
    await waitFor(() => !isSelfcheckRunning());
    assert.equal(getActiveRunId(), null);
    const finished = events.filter((e) => e.type === 'init:selfcheck-finished');
    assert.equal(finished.length, 1, '只执行了一次');
  } finally {
    restoreFetch();
    stopKeyCache();
    await rm(dir, { recursive: true, force: true });
  }
});
