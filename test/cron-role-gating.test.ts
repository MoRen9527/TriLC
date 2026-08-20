// ── FADE-ASSESS-005 调度门禁：cron 触发链只拉起在岗岗 ──
// 覆盖 shouldRunJob 正反用例：active 放行 / 非在岗拒绝（owner_not_active）/
// 未绑定 roleId 放行 / 未注入 isRoleActive 放行（向后兼容）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRunJob } from '../src/cron/timer.js';
import type { CronJob } from '../src/cron/types.js';

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'cron_test',
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

describe('FADE-ASSESS-005 cron dispatch gate (shouldRunJob)', () => {
  it('job 绑定 roleId 且岗位在岗 → 放行', async () => {
    const gate = await shouldRunJob(
      { isRoleActive: async () => true },
      makeJob({ roleId: 'full-stack-developer' }),
    );
    assert.deepEqual(gate, { run: true });
  });

  it('job 绑定 roleId 且岗位非在岗 → 拒绝 owner_not_active（不静默）', async () => {
    const gate = await shouldRunJob(
      { isRoleActive: async () => false },
      makeJob({ roleId: 'test-engineer' }),
    );
    assert.equal(gate.run, false);
    assert.ok(gate.reason?.includes('owner_not_active'));
    assert.ok(gate.reason?.includes('test-engineer'));
  });

  it('job 未绑定 roleId（系统 job）→ 不校验、放行', async () => {
    let called = false;
    const gate = await shouldRunJob(
      { isRoleActive: async () => { called = true; return true; } },
      makeJob({}),
    );
    assert.deepEqual(gate, { run: true });
    assert.equal(called, false, '未绑定 roleId 时不得调用 isRoleActive');
  });

  it('job 绑定 roleId 但未注入 isRoleActive（旧部署）→ 放行（向后兼容）', async () => {
    const gate = await shouldRunJob({}, makeJob({ roleId: 'cto' }));
    assert.deepEqual(gate, { run: true });
  });

  it('终审收口 ④: command job 绑 roleId 且岗位非在岗 → 拒绝（门禁先于 command 分支）', async () => {
    const gate = await shouldRunJob(
      { isRoleActive: async () => false },
      makeJob({ roleId: 'test-engineer', command: 'echo hi' }),
    );
    assert.equal(gate.run, false);
    assert.ok(gate.reason?.includes('owner_not_active'));
  });

  it('终审收口 ④: command job 绑 roleId 且岗位在岗 → 放行', async () => {
    const gate = await shouldRunJob(
      { isRoleActive: async () => true },
      makeJob({ roleId: 'full-stack-developer', command: 'echo hi' }),
    );
    assert.deepEqual(gate, { run: true });
  });
});
