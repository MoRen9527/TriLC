// ── FADE-ASSESS-005 分身门禁：AgentTool 合同员工 spawn 前置校验 ──
// 覆盖 enforceRosterGate 正反用例：active 放行 / pending-cho / candidate 拒绝
// （role_not_active）/ 未注入 gate 放行（向后兼容）。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { enforceRosterGate, setRosterGate } from '../src/tools/agent-tool.js';

afterEach(() => {
  setRosterGate(null);
});

describe('FADE-ASSESS-005 agent-tool roster gate (enforceRosterGate)', () => {
  it('岗位在岗（active）→ 放行', async () => {
    setRosterGate(async () => ({ status: 'active' }));
    const gate = await enforceRosterGate('full-stack-developer');
    assert.deepEqual(gate, { ok: true, status: 'active' });
  });

  it('待审（pending-cho）→ 拒绝 role_not_active', async () => {
    setRosterGate(async () => ({ status: 'pending-cho' }));
    const gate = await enforceRosterGate('test-engineer');
    assert.equal(gate.ok, false);
    assert.equal(gate.error, 'role_not_active');
    assert.equal(gate.status, 'pending-cho');
  });

  it('候选未上岗（candidate）→ 拒绝 role_not_active', async () => {
    setRosterGate(async () => ({ status: 'candidate' }));
    const gate = await enforceRosterGate('cto');
    assert.equal(gate.ok, false);
    assert.equal(gate.error, 'role_not_active');
    assert.equal(gate.status, 'candidate');
  });

  it('未知岗位（unknown）→ 拒绝 role_not_active', async () => {
    setRosterGate(async () => ({ status: 'unknown' }));
    const gate = await enforceRosterGate('not-a-role');
    assert.equal(gate.ok, false);
    assert.equal(gate.error, 'role_not_active');
  });

  it('未注入 gate（独立使用）→ 放行（向后兼容）', async () => {
    const gate = await enforceRosterGate('full-stack-developer');
    assert.deepEqual(gate, { ok: true });
  });

  it('gate 返回 undefined（门禁不可用）→ 放行', async () => {
    setRosterGate(async () => undefined);
    const gate = await enforceRosterGate('full-stack-developer');
    assert.deepEqual(gate, { ok: true });
  });
});
