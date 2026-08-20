// ── FADE-005 §三 degraded 语义固化：skipped 三态（ok / skipped / error）──
// 终审收口 ⑤（fade-005-roster-gating-spec.md §三）：
//   1. skipped 计入非 ok 路径：连续 3 次 skipped 触发 cron:degraded（有意设计——连续非在岗应暴露）
//   2. 恢复仅以真实 ok 为凭：skipped 不解除 degraded、不广播 cron:recovered
//
// executeJobScheduled 非导出（timer.ts:146）——经导出路径 runMissedJobs
// （missed job 逐个走 executeJobScheduled）实测；skipped 由 job.roleId +
// isRoleActive=false 门禁拒绝产生，ok 由 command job（确定性 shell，无 LLM）产生。
// 状态转移经 state.consecutiveFailures / state.degraded 断言，事件经 localbus
// cron:degraded / cron:recovered 断言。
//
// 进程退出保障：cron 执行链的 setTimeout（executeJobCoreWithTimeout 超时 /
// executeCommand 超时）若在任何路径漏清，会拖住事件循环使 node:test 进程
// 永不退出（曾实测 exit=124 超时杀）。生产侧已修 executeJobCoreWithTimeout
// 的 race 后 clearTimeout；测试侧再以 mock.timers 接管全局 setTimeout 兜底
// ——after 时 reset() 清空全部 pending mock timer，确保进程必然退出。
// （mock 仅限 setTimeout：Date 未 mock，croner nextRun 纯计算不受影响；
//  cmd.exe spawn 为异步 I/O 不经 setTimeout，不受影响。）
//
// Run: npx tsx --test test/cron-skipped-degraded.test.ts

import { describe, it, beforeEach, afterEach, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createCronTimerState, runMissedJobs, type CronTimerDeps, type CronStoreLike, type CronTimerState } from '../src/cron/timer.js';
import type { CronJob } from '../src/cron/types.js';
import { localBus, type LocalBusEvent } from '../src/localbus/bus.js';

// ── 假件：内存 CronStoreLike（最小面，够 executeJobScheduled 消费）──

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'skipped-degraded-job',
    name: 'test-job',
    schedule: { kind: 'every', everyMs: 60_000 },
    systemPrompt: 'test',
    enabled: true,
    state: 'idle',
    createdAt: '2026-08-20T00:00:00Z',
    updatedAt: '2026-08-20T00:00:00Z',
    runCount: 0,
    errorCount: 0,
    ...overrides,
  };
}

function createFakeStore(job: CronJob) {
  const logs: Array<{ jobId: string; status: string; startedAt: string; durationMs: number; errorMessage?: string }> = [];
  const jobs = new Map<string, CronJob>([[job.id, job]]);
  return {
    logs,
    jobs,
    listJobs: () => [...jobs.values()],
    getJob: (id: string) => jobs.get(id),
    addJob: () => { throw new Error('not implemented in fake'); },
    removeJob: () => false,
    updateJob: () => null,
    updateJobRun: (id: string, updates: Record<string, unknown>) => {
      const j = jobs.get(id);
      if (!j) return;
      if (updates.incrementRun) j.runCount += 1;
      if (updates.incrementError) j.errorCount += 1;
      for (const [key, value] of Object.entries(updates)) {
        if (key === 'incrementRun' || key === 'incrementError') continue;
        (j as Record<string, unknown>)[key] = value;
      }
    },
    addExecutionLog: (jobId: string, status: string, startedAt: string, durationMs: number, errorMessage?: string) => {
      logs.push({ jobId, status, startedAt, durationMs, errorMessage });
    },
    getExecutionLogs: () => [],
    saveCronStore: () => {},
    db: null as unknown,
  };
}

function makeDeps(
  store: ReturnType<typeof createFakeStore>,
  isRoleActive?: (roleId: string) => Promise<boolean>,
): CronTimerDeps {
  return {
    store: store as unknown as CronStoreLike,
    sessionStore: {
      createSession: () => {},
      saveMessages: () => {},
      updateSessionStatus: () => {},
    },
    cwd: process.cwd(),
    ...(isRoleActive ? { isRoleActive } : {}),
  };
}

/** 把 job 拨回"已到期"（executeJobScheduled 跑完后 nextRunAt 会被推到未来）。 */
function makeDue(job: CronJob): void {
  job.nextRunAt = new Date(Date.now() - 1000).toISOString();
}

// ── bus 事件收集（afterEach 卸载监听，防跨用例污染）──

function collectBusEvents(): LocalBusEvent[] {
  const events: LocalBusEvent[] = [];
  localBus.on('event', (ev) => events.push(ev));
  return events;
}

describe('FADE-005 §三 skipped→degraded 三态语义（executeJobScheduled 经 runMissedJobs 实测）', () => {
  let job: CronJob;
  let store: ReturnType<typeof createFakeStore>;
  let state: CronTimerState;
  let events: LocalBusEvent[];

  before(() => {
    // 接管全局 setTimeout：任何 cron 执行链漏清的定时器都会进 mock 队列，
    // after 的 reset() 一并清空 → 测试进程必然退出（防 124 超时挂起复发）。
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  after(() => {
    mock.timers.reset();
  });

  beforeEach(() => {
    job = makeJob();
    store = createFakeStore(job);
    state = createCronTimerState();
    events = collectBusEvents();
  });

  afterEach(() => {
    localBus.removeAllListeners('event');
  });

  function runOnce(): Promise<void> {
    makeDue(job);
    return runMissedJobs(state, makeDeps(store, async () => false));
  }

  it('连续 3 次 skipped → degraded=true + cron:degraded(3) 发布', async () => {
    job.roleId = 'test-engineer'; // 非在岗 → 门禁拒绝 → skipped

    await runOnce();
    await runOnce();
    await runOnce();

    assert.equal(state.degraded, true, '连续 3 次 skipped 必须触发 degraded');
    assert.equal(state.consecutiveFailures, 3);
    const degradedEvents = events.filter((e) => e.type === 'cron:degraded');
    assert.equal(degradedEvents.length, 1, '仅阈值跨越那一次发布');
    assert.equal((degradedEvents[0] as { type: 'cron:degraded'; consecutiveFailures: number }).consecutiveFailures, 3);
    assert.equal(events.some((e) => e.type === 'cron:recovered'), false);
  });

  it('2 次 skipped → 未达阈值，degraded=false（边界）', async () => {
    job.roleId = 'test-engineer';

    await runOnce();
    await runOnce();

    assert.equal(state.degraded, false, '2 次 skipped 不得触发 degraded');
    assert.equal(state.consecutiveFailures, 2);
    assert.equal(events.some((e) => e.type === 'cron:degraded'), false);
  });

  it('degraded 后继续 skipped → 保持 degraded、计数累计、不广播 cron:recovered', async () => {
    job.roleId = 'test-engineer';

    await runOnce();
    await runOnce();
    await runOnce(); // → degraded
    assert.equal(state.degraded, true);

    await runOnce();
    await runOnce(); // degraded 后 2 次 skipped

    assert.equal(state.degraded, true, 'skipped 不得解除 degraded');
    assert.equal(state.consecutiveFailures, 5, 'skipped 继续计入非 ok 路径');
    assert.equal(events.some((e) => e.type === 'cron:recovered'), false, 'skipped 不广播 cron:recovered');
    // 不重复广播 degraded（仅阈值跨越一次）
    assert.equal(events.filter((e) => e.type === 'cron:degraded').length, 1);
  });

  it('恢复仅以真实 ok 为凭：degraded 后一次 ok → recovered + 清零', async () => {
    job.roleId = 'test-engineer';
    await runOnce();
    await runOnce();
    await runOnce(); // → degraded

    // 换成在岗 + 确定性 command job → 真实 ok
    job.roleId = undefined;
    job.command = 'echo ok';
    job.schedule = { kind: 'every', everyMs: 60_000 };

    const okDeps = makeDeps(store, async () => true);
    makeDue(job);
    await runMissedJobs(state, okDeps);

    assert.equal(state.degraded, false, '真实 ok 必须解除 degraded');
    assert.equal(state.consecutiveFailures, 0, 'ok 清零连续失败计数');
    assert.equal(events.some((e) => e.type === 'cron:recovered'), true, 'ok 恢复必须广播 cron:recovered');
  });

  it('skipped 记 skipped 且不 incrementError（job 本身未失败），error 才 incrementError', async () => {
    job.roleId = 'test-engineer';
    await runOnce();

    assert.equal(job.lastRunStatus, 'skipped');
    assert.equal(job.state, 'idle');
    assert.equal(job.runCount, 1);
    assert.equal(job.errorCount, 0, 'skipped 不得 incrementError');
    assert.equal(store.logs[0].status, 'skipped');
    assert.ok(store.logs[0].errorMessage?.includes('owner_not_active'));
  });

  it('ok 恢复同时清零计数且记 ok（三态中 ok 的唯一恢复路径）', async () => {
    job.roleId = 'test-engineer';
    await runOnce();
    await runOnce(); // 2 次 skipped，consecutiveFailures=2

    job.roleId = undefined;
    job.command = 'echo ok';
    const okDeps = makeDeps(store, async () => true);
    makeDue(job);
    await runMissedJobs(state, okDeps);

    assert.equal(job.lastRunStatus, 'ok');
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(state.degraded, false);
    assert.equal(job.errorCount, 0);
  });
});
