// ── FADE-ASSESS-005 分身门禁：AgentTool 合同员工 spawn 前置校验 ──
// 覆盖 enforceRosterGate 正反用例：active 放行 / pending-cho / candidate 拒绝
// （role_not_active）/ 未注入 gate 放行（向后兼容）/
// setRosterGate 多实例注入（重复设置/清理，模块级单例 last-write-wins）。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { enforceRosterGate, setRosterGate, setOnSpawnGateDenied } from '../src/tools/agent-tool.js';

afterEach(() => {
  setRosterGate(null);
  setOnSpawnGateDenied(null);
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

// ── FADE-005 观察项收口：setRosterGate 多实例注入 ──
// 模块级单例注入点：daemon 每次启动只注入一次，但热重载/多宿主编排可能重复
// 注入——语义必须是 last-write-wins（可重复设置），且 set null 清理后回退
// 未注入放行语义（不影响后续注入）。
describe('FADE-005 setRosterGate 多实例注入（重复设置/清理）', () => {
  it('重复设置覆盖：后注入者生效（last-write-wins），可再切回', async () => {
    const gateA = async () => ({ status: 'active' });
    const gateB = async () => ({ status: 'candidate' });

    setRosterGate(gateA);
    assert.deepEqual(await enforceRosterGate('full-stack-developer'), { ok: true, status: 'active' });

    setRosterGate(gateB); // 第二次注入覆盖
    const denied = await enforceRosterGate('full-stack-developer');
    assert.equal(denied.ok, false);
    assert.equal(denied.error, 'role_not_active');
    assert.equal(denied.status, 'candidate');

    setRosterGate(gateA); // 第三次注入切回
    assert.deepEqual(await enforceRosterGate('full-stack-developer'), { ok: true, status: 'active' });
  });

  it('注入点可清理：set null 后回退未注入放行语义，且旧 gate 不再被调用', async () => {
    let calls = 0;
    setRosterGate(async () => { calls++; return { status: 'candidate' }; });
    await enforceRosterGate('cto');
    assert.equal(calls, 1);

    setRosterGate(null); // 清理（多实例生命周期结束）
    const gate = await enforceRosterGate('cto');
    assert.deepEqual(gate, { ok: true }, '清理后必须回退放行');
    assert.equal(calls, 1, '清理后旧 gate 不得再被调用');
  });

  it('setOnSpawnGateDenied 重复设置/清理：拒绝回调同样 last-write-wins', async () => {
    setRosterGate(async () => ({ status: 'candidate' }));

    const deniedA: string[] = [];
    setOnSpawnGateDenied((roleId, status) => { deniedA.push(`${roleId}:${status}`); });
    await enforceRosterGate('cto');
    assert.deepEqual(deniedA, ['cto:candidate']);

    // 第二次注入回调：旧回调不再触发，只有新回调收集
    const deniedB: string[] = [];
    setOnSpawnGateDenied((roleId, status) => { deniedB.push(`${roleId}:${status}`); });
    await enforceRosterGate('test-engineer');
    assert.deepEqual(deniedA, ['cto:candidate'], '旧回调不得再触发');
    assert.deepEqual(deniedB, ['test-engineer:candidate']);

    // 清理回调 → 拒绝静默（不抛、无收集）
    setOnSpawnGateDenied(null);
    await enforceRosterGate('ceo');
    assert.deepEqual(deniedB, ['test-engineer:candidate'], '清理后拒绝不得触发任何回调');
  });
});
