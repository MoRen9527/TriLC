// ── FADE-ASSESS-005 上岗 gating：roster 运行态门禁单元测试 ──
// 覆盖：getRoleRosterStatus / isRoleActive / enforceRoleActive 四态判定
// （active 放行 / pending-cho / candidate / unknown 拒绝）+ 边界（无 state 文件、
// 无 requests 文件、门禁错误语义 owner_not_active）。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getRoleRosterStatus,
  isRoleActive,
  enforceRoleActive,
  type StaffingDeps,
} from '../src/company/staffing.js';

const CATALOG = {
  roles: [
    { roleId: 'full-stack-developer', roleName: '全栈开发工程师' },
    { roleId: 'test-engineer', roleName: '测试工程师' },
    { roleId: 'cto', roleName: '首席技术官' },
  ],
};

interface Harness {
  dir: string;
  employees: Array<{ role: string; name: string }>;
  deps: StaffingDeps;
  cleanup(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'roster-gating-'));
  const employees: Array<{ role: string; name: string }> = [];
  const deps: StaffingDeps = {
    dataDir: dir,
    companyState: {
      load: async () => ({ state: 'initialized', companyName: 'T', ceoName: 'C', employees, onboardedAt: null }),
      save: async (next: any) => next,
    },
    chain: { getState: () => 'ready' },
    getRoleCatalog: () => CATALOG,
    publish: () => {},
  };
  return {
    dir,
    employees,
    deps,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe('FADE-ASSESS-005 roster gating', () => {
  let h: Harness;

  before(async () => {
    h = await makeHarness();
  });

  after(async () => {
    await h.cleanup();
  });

  it('active: employees 含该 role → 放行', async () => {
    h.employees.push({ role: 'full-stack-developer', name: '小全' });
    assert.equal(await getRoleRosterStatus(h.deps, 'full-stack-developer'), 'active');
    assert.equal(await isRoleActive(h.deps, 'full-stack-developer'), true);
    const gate = await enforceRoleActive(h.deps, 'full-stack-developer');
    assert.deepEqual(gate, { allowed: true, status: 'active' });
    assert.equal(gate.error, undefined);
  });

  it('pending-cho: 有待审请求（未上岗）→ 拒绝 owner_not_active', async () => {
    await mkdir(join(h.dir, 'staffing'), { recursive: true });
    await writeFile(
      join(h.dir, 'staffing', 'requests.json'),
      JSON.stringify([
        { requestId: 'r1', roleId: 'test-engineer', status: 'pending-cho', requestedAt: '2026-08-20T00:00:00Z' },
      ]),
      'utf-8',
    );
    assert.equal(await getRoleRosterStatus(h.deps, 'test-engineer'), 'pending-cho');
    assert.equal(await isRoleActive(h.deps, 'test-engineer'), false);
    const gate = await enforceRoleActive(h.deps, 'test-engineer');
    assert.equal(gate.allowed, false);
    assert.equal(gate.error, 'owner_not_active');
    assert.equal(gate.status, 'pending-cho');
  });

  it('candidate: 目录存在但从未上岗 → 拒绝 owner_not_active', async () => {
    assert.equal(await getRoleRosterStatus(h.deps, 'cto'), 'candidate');
    assert.equal(await isRoleActive(h.deps, 'cto'), false);
    const gate = await enforceRoleActive(h.deps, 'cto');
    assert.equal(gate.allowed, false);
    assert.equal(gate.error, 'owner_not_active');
    assert.equal(gate.status, 'candidate');
  });

  it('unknown: 目录不存在 → 拒绝 owner_not_active（unknown 态）', async () => {
    assert.equal(await getRoleRosterStatus(h.deps, 'not-a-role'), 'unknown');
    const gate = await enforceRoleActive(h.deps, 'not-a-role');
    assert.equal(gate.allowed, false);
    assert.equal(gate.error, 'owner_not_active');
    assert.equal(gate.status, 'unknown');
  });

  it('边界: requests.json 缺失（无 staffing 目录）不抛错', async () => {
    const h2 = await makeHarness();
    try {
      // active 判定在 requests 读取之前短路，candidate 判定也依赖 requests——
      // 均需在无文件时正常返回。
      assert.equal(await getRoleRosterStatus(h2.deps, 'cto'), 'candidate');
      assert.equal(await getRoleRosterStatus(h2.deps, 'full-stack-developer'), 'candidate');
    } finally {
      await h2.cleanup();
    }
  });

  it('边界: rejected 请求不构成 pending-cho（终态记录非待审）', async () => {
    const h2 = await makeHarness();
    try {
      await mkdir(join(h2.dir, 'staffing'), { recursive: true });
      await writeFile(
        join(h2.dir, 'staffing', 'requests.json'),
        JSON.stringify([
          { requestId: 'r2', roleId: 'test-engineer', status: 'rejected', decidedAt: '2026-08-20T00:00:00Z' },
          { requestId: 'r3', roleId: 'cto', status: 'approved', decidedAt: '2026-08-20T00:00:00Z' },
        ]),
        'utf-8',
      );
      // rejected 后该岗回落 candidate；approved 请求不写名册时也回落 candidate
      // （名册写入 = decide 侧职责，请求记录只是过程态）。
      assert.equal(await getRoleRosterStatus(h2.deps, 'test-engineer'), 'candidate');
      assert.equal(await getRoleRosterStatus(h2.deps, 'cto'), 'candidate');
    } finally {
      await h2.cleanup();
    }
  });
});
