// ── InitAssemble tests（i2-2 任务包 §八.10）──
// 覆盖：校验矩阵（400 族）/ 白名单逃逸拒绝 / 阶段门禁 422 / 防重入 409 /
// 回滚（注入失败点）/ 幂等重试（state 成功 transition 失败路径）/
// 事件序与状态帧一致 / preserved 语义 / <5 岗 warning。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InitChain } from "../src/company/init-chain.js";
import { CompanyInitState } from "../src/company/init-state.js";
import {
  runAssemble,
  validateAssemblePayload,
  resetAssembleForTest,
  buildInitModeSystemPrompt,
  INIT_MODE_CHAIN_STATES,
  validateProgressUpsert,
  upsertOnboardingProgress,
  getOnboardingStateProjection,
  type AssembleDeps,
  type AssembleRequest,
} from "../src/company/init-assemble.js";
import type { LocalBusEvent } from "../src/localbus/bus.js";

const CATALOG = {
  roles: [
    { roleId: 'ceo-chief-of-staff', roleName: 'CEOChiefOfStaff', oneLinePositioning: '总助，负责公司运作协调。', isGovernance: true, defaultSelected: true },
    { roleId: 'full-stack-developer', roleName: 'FullStackDeveloper', oneLinePositioning: '全栈开发工程师。', isGovernance: false, defaultSelected: true },
  ],
};

const REQ: AssembleRequest = {
  ceoName: '磨人',
  selections: [
    { roleId: 'ceo-chief-of-staff', name: '小贾' },
    { roleId: 'full-stack-developer', name: '小全' },
  ],
  entry: 'trilc-chat',
};

interface Harness {
  dir: string;
  ws: string;
  deps: AssembleDeps;
  events: LocalBusEvent[];
  cleanup: () => Promise<void>;
}

type ChainStartAt = 'uninitialized' | 'selfcheck' | 'selfcheck-pass' | 'onboarding';

async function newHarness(opts?: { failOnTarget?: number; failOnTransition?: boolean; chainState?: ChainStartAt }): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "init-assemble-test-"));
  const ws = await mkdtemp(join(tmpdir(), "init-assemble-ws-"));
  const events: LocalBusEvent[] = [];
  const chain = new InitChain(dir, { onEvent: (e) => events.push(e) });
  await chain.load();
  const target: ChainStartAt = opts?.chainState ?? 'onboarding';
  if (target === 'selfcheck' || target === 'selfcheck-pass' || target === 'onboarding') {
    await chain.transitionTo('selfcheck', 'daemon');
  }
  if (target === 'selfcheck-pass') {
    await chain.updateSelfcheck({ summary: 'pass', finishedAt: new Date().toISOString(), retryCount: 1 });
  }
  if (target === 'onboarding') {
    await chain.transitionTo('onboarding', 'daemon');
  }
  const deps: AssembleDeps = {
    dataDir: dir,
    workspaceRoot: ws,
    chain,
    companyState: new CompanyInitState(dir),
    publish: (e) => events.push(e),
    getRoleCatalog: () => CATALOG,
    failOnTarget: opts?.failOnTarget,
    failOnTransition: opts?.failOnTransition,
  };
  return {
    dir,
    ws,
    deps,
    events,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    },
  };
}

function stepEvents(events: LocalBusEvent[], step: string): Array<Extract<LocalBusEvent, { type: 'init:step-event' }>> {
  return events.filter((e) => e.type === 'init:step-event' && e.step === step) as Array<Extract<LocalBusEvent, { type: 'init:step-event' }>>;
}

// ── 1. 校验矩阵（纯函数）──

test("validate matrix: ceoName / selections / entry 400 族", () => {
  const bad = (body: unknown) => validateAssemblePayload(body, CATALOG);
  assert.equal(bad(null).ok, false, 'null body → 400');
  assert.equal((bad(null) as { error: string }).error, 'bad_request');
  assert.equal(bad({ ceoName: '  ', selections: [{ roleId: 'a', name: 'n' }], entry: 'tripilot' }).ok, false, 'ceoName 空白 → 400');
  assert.equal(bad({ ceoName: 'x'.repeat(65), selections: [{ roleId: 'a', name: 'n' }], entry: 'tripilot' }).ok, false, 'ceoName 超长 → 400');
  assert.equal(bad({ ceoName: '磨人', selections: [], entry: 'tripilot' }).ok, false, '0 人拦截（A4）→ 400');
  assert.equal(bad({ ceoName: '磨人', selections: 'nope', entry: 'tripilot' }).ok, false, 'selections 非数组 → 400');
  assert.equal(bad({ ceoName: '磨人', selections: [{ roleId: 'a', name: 'n' }], entry: 'web' }).ok, false, 'entry 非法 → 400');
  assert.equal(bad({ ceoName: '磨人', selections: [{ roleId: 'a', name: 'n' }], entry: 'tripilot' }).ok, false, 'roleId 不在目录 → 400');
  assert.equal(bad({ ceoName: '磨人', selections: [{ roleId: 'ceo-chief-of-staff', name: '' }], entry: 'tripilot' }).ok, false, 'name 空白 → 400');
  assert.equal(
    bad({ ceoName: '磨人', selections: [{ roleId: 'ceo-chief-of-staff', name: '小贾' }, { roleId: 'ceo-chief-of-staff', name: '贾二' }], entry: 'tripilot' }).ok,
    false,
    'roleId 去重 → 400',
  );
  const ok = bad({ ceoName: '  磨人  ', selections: [{ roleId: 'full-stack-developer', name: ' 小全 ' }], entry: 'trilc-chat' });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.ceoName, '磨人', 'ceoName trim');
    assert.equal(ok.selections[0].name, '小全', 'name trim');
  }
});

test("validate matrix: 白名单逃逸拒绝（路径注入 → 400，不落盘）", () => {
  for (const evil of ['../../etc/passwd', 'a/b', '..', 'a\\b', 'ceo-chief-of-staff.md', ' role']) {
    const v = validateAssemblePayload(
      { ceoName: '磨人', selections: [{ roleId: evil, name: 'x' }], entry: 'tripilot' },
      CATALOG,
    );
    assert.equal(v.ok, false, `roleId=${JSON.stringify(evil)} 必须拒绝`);
  }
});

test("validate: catalog null → role_catalog_unavailable（不开天窗）", () => {
  const v = validateAssemblePayload({ ceoName: '磨人', selections: [{ roleId: 'ceo-chief-of-staff', name: '小贾' }], entry: 'tripilot' }, null);
  assert.equal(v.ok, false);
  assert.equal((v as { error: string }).error, 'role_catalog_unavailable');
});

// ── 2. 阶段门禁 422 ──

test("phase gate: 非 onboarding → 422 { chainState }（A' 字面门禁）", async () => {
  // uninitialized：链未转移
  const h1 = await newHarness({ chainState: 'uninitialized' });
  try {
    const r = await runAssemble(h1.deps, REQ);
    assert.equal(r.status, 422);
    assert.equal((r as { chainState: string }).chainState, 'uninitialized');
  } finally {
    await h1.cleanup();
  }
  // selfcheck 未完成（summary null）
  const h2 = await newHarness({ chainState: 'selfcheck' });
  try {
    const r = await runAssemble(h2.deps, REQ);
    assert.equal(r.status, 422, 'selfcheck 未完结 → 422');
    assert.equal((r as { chainState: string }).chainState, 'selfcheck');
  } finally {
    await h2.cleanup();
  }
  // A' 裁决：assemble 只受理 onboarding——selfcheck 已完结（pass）也 422
  // （推进点 = init-selfcheck 完成路径，不在本端点）
  const h3 = await newHarness({ chainState: 'selfcheck-pass' });
  try {
    const r = await runAssemble(h3.deps, REQ);
    assert.equal(r.status, 422, 'selfcheck 已完结仍 422（门禁字面 onboarding-only）');
    assert.equal((r as { chainState: string }).chainState, 'selfcheck');
  } finally {
    await h3.cleanup();
  }
  // project-link：已装配 → 422（防错阶段写）
  const h4 = await newHarness();
  try {
    const r = await runAssemble(h4.deps, REQ);
    assert.equal(r.status, 200);
    const again = await runAssemble(h4.deps, REQ);
    assert.equal(again.status, 422, 'project-link 重入 → 422');
    assert.equal((again as { chainState: string }).chainState, 'project-link');
  } finally {
    await h4.cleanup();
  }
});

// ── 3. 回滚（注入失败点）──

test("prewrite failure → .bak 恢复 + 删新增文件 + 500 { rollback: completed }", async () => {
  const h = await newHarness({ failOnTarget: 1 });
  try {
    // 预置既有文件（写入后被覆盖 → 回滚应恢复原内容）
    const agentPath = join(h.ws, '.claude', 'agents', 'ceo-chief-of-staff.md');
    await mkdir(join(h.ws, '.claude', 'agents'), { recursive: true });
    await writeFile(agentPath, 'OLD CONTENT', 'utf-8');

    const r = await runAssemble(h.deps, REQ);
    assert.equal(r.status, 500, '预写段注入失败 → 500');
    assert.equal((r as { rollback: string }).rollback, 'completed');
    assert.ok((r as { error: string }).error.includes('injected prewrite failure'));

    // 已 rename 的 target #0 从 .bak 恢复
    const restored = await readFile(agentPath, 'utf-8');
    assert.equal(restored, 'OLD CONTENT', '既有文件回滚恢复原内容');
    // 未触达的 target 不落盘
    const secondAgent = join(h.ws, '.claude', 'agents', 'full-stack-developer.md');
    await assert.rejects(readFile(secondAgent, 'utf-8'), 'target #1 未 rename 不落盘');
    // 无 tmp 残留
    const agentsDir = await readdir(join(h.ws, '.claude', 'agents'));
    assert.equal(agentsDir.some((f) => f.endsWith('.tmp')), false, '无 tmp 残留');
    // assemble-failed 事件
    assert.equal(stepEvents(h.events, 'assemble-failed').length, 1, 'assemble-failed 事件');
    assert.equal(stepEvents(h.events, 'assembled').length, 0, '无 assembled 事件');
  } finally {
    await h.cleanup();
  }
});

test("prewrite failure 回滚删新增文件（无 bak 的新文件）", async () => {
  const h = await newHarness({ failOnTarget: 1 });
  try {
    const r = await runAssemble(h.deps, REQ);
    assert.equal(r.status, 500);
    // target #0 是全新文件（无 .bak）→ 回滚 = 删除
    const firstAgent = join(h.ws, '.claude', 'agents', 'ceo-chief-of-staff.md');
    await assert.rejects(readFile(firstAgent, 'utf-8'), '新增文件回滚即删');
    // 白名单外零写入
    const wsFiles = await readdir(h.ws);
    const unexpected = wsFiles.filter((f) => !['.claude'].includes(f));
    assert.deepEqual(unexpected, [], '工作区无白名单外写入');
  } finally {
    await h.cleanup();
  }
});

// ── 4. 幂等重试（state 成功 transition 失败路径）──

test("idempotent retry: state saved + transition failed → 重入跳过文件段补 transition", async () => {
  const h = await newHarness({ failOnTransition: true });
  try {
    const first = await runAssemble(h.deps, REQ);
    assert.equal(first.status, 500, '注入 transition 失败 → 500');
    assert.equal((first as { retryable: boolean }).retryable, true, 'retryable 标记');
    assert.equal(h.deps.chain.getState(), 'onboarding', '链路态仍在 onboarding（不回滚）');
    const stateFile = await readFile(join(h.dir, 'company', 'state.json'), 'utf-8');
    assert.equal(JSON.parse(stateFile).state, 'initialized', '公司态已 initialized（save 成功不回滚）');

    // 外部改动文件模拟「重入前文件被触碰」→ 重入必须跳过文件段（不覆盖）
    const agentPath = join(h.ws, '.claude', 'agents', 'ceo-chief-of-staff.md');
    await writeFile(agentPath, 'EXTERNAL CHANGE', 'utf-8');

    const retryDeps: AssembleDeps = { ...h.deps, failOnTransition: false };
    const second = await runAssemble(retryDeps, REQ);
    assert.equal(second.status, 200, '重入 → 200 补 transition');
    assert.equal(retryDeps.chain.getState(), 'project-link');
    const agentAfter = await readFile(agentPath, 'utf-8');
    assert.equal(agentAfter, 'EXTERNAL CHANGE', '文件段跳过（不重写）');
    assert.equal(stepEvents(h.events, 'assembling').length, 1, '第一次的 assembling 只发一次');
    assert.equal(stepEvents(h.events, 'assembled').length, 1, 'assembled 一次');
  } finally {
    await h.cleanup();
  }
});

test("idempotent retry: employees 不一致 → 409 conflict", async () => {
  const h = await newHarness({ failOnTransition: true });
  try {
    await runAssemble(h.deps, REQ);
    const retryDeps: AssembleDeps = { ...h.deps, failOnTransition: false };
    const mismatched = await runAssemble(retryDeps, {
      ...REQ,
      selections: [{ roleId: 'ceo-chief-of-staff', name: '别人' }],
    });
    assert.equal(mismatched.status, 409);
    assert.equal((mismatched as { conflict: string }).conflict, 'employees_mismatch');
  } finally {
    await h.cleanup();
  }
});

// ── 5. 防重入 409（单执行体互斥）──

test("reentrancy: 运行中再触发 → 409 { busy: true }", async () => {
  const h = await newHarness();
  try {
    resetAssembleForTest();
    // 同一同步轮内先后发起：第二次在第一次完成前看到互斥标志
    const p1 = runAssemble(h.deps, REQ);
    const p2 = runAssemble(h.deps, REQ);
    const r2 = await p2;
    assert.equal(r2.status, 409, '运行中 → 409');
    assert.equal((r2 as { busy: boolean }).busy, true);
    const r1 = await p1;
    assert.equal(r1.status, 200, '首次运行正常完成');
  } finally {
    resetAssembleForTest();
    await h.cleanup();
  }
});

// ── 6. 事件序与状态帧一致 ──

test("event order: assembling → assembled；chain-changed 与状态帧一致", async () => {
  const h = await newHarness();
  try {
    const r = await runAssemble(h.deps, REQ);
    assert.equal(r.status, 200);

    const assemblingIdx = h.events.findIndex((e) => e.type === 'init:step-event' && e.step === 'assembling');
    const assembledIdx = h.events.findIndex((e) => e.type === 'init:step-event' && e.step === 'assembled');
    assert.ok(assemblingIdx >= 0 && assembledIdx > assemblingIdx, 'assembling 先于 assembled');

    const assembled = h.events[assembledIdx] as Extract<LocalBusEvent, { type: 'init:step-event' }>;
    assert.equal(assembled.phase, 'onboarding');
    assert.equal(assembled.entry, 'trilc-chat');
    const payload = assembled.payload as { ceoName: string; employees: Array<{ role: string; name: string }> };
    assert.equal(payload.ceoName, '磨人');
    assert.deepEqual(payload.employees, [
      { role: 'ceo-chief-of-staff', name: '小贾' },
      { role: 'full-stack-developer', name: '小全' },
    ]);

    // chain-changed 最后帧 = status 端点帧（eventSeq/chainState 同帧）
    const chainChanged = h.events.filter((e) => e.type === 'init:chain-changed');
    const last = chainChanged[chainChanged.length - 1] as Extract<LocalBusEvent, { type: 'init:chain-changed' }>;
    assert.equal(last.to, 'project-link');
    const status = h.deps.chain.toStatusPayload();
    assert.equal(status.chainState, last.chainState, 'status 帧 = 事件最后帧');
    assert.equal(status.eventSeq, last.eventSeq, 'eventSeq 同帧');
    assert.equal(status.chainState, 'project-link');

    // 公司态帧
    const stateFile = await readFile(join(h.dir, 'company', 'state.json'), 'utf-8');
    const stateJson = JSON.parse(stateFile);
    assert.equal(stateJson.state, 'initialized');
    assert.equal(stateJson.ceoName, '磨人');
    assert.equal(stateJson.employees.length, 2);
  } finally {
    await h.cleanup();
  }
});

// ── 7. 落点白名单产物 + preserved 语义 + <5 岗 warning ──

test("whitelist artifacts written; existing business-state/AGENTS preserved; <5 warning", async () => {
  const h = await newHarness();
  try {
    // 预置真实内容（模拟现状真源）：装配不得覆盖
    await mkdir(join(h.ws, 'docs', 'registry'), { recursive: true });
    await writeFile(join(h.ws, 'docs', 'registry', 'business-state.md'), 'REAL BUSINESS STATE', 'utf-8');
    await writeFile(join(h.ws, 'AGENTS.md'), 'REAL AGENTS', 'utf-8');

    const r = await runAssemble(h.deps, { ceoName: '磨人', selections: [REQ.selections[0]], entry: 'tripilot' });
    assert.equal(r.status, 200);
    const body = r as Extract<Awaited<ReturnType<typeof runAssemble>>, { status: 200 }>;
    assert.deepEqual(body.preserved, ['docs/registry/business-state.md', 'AGENTS.md'], 'preserved 报告');
    assert.equal(body.warning?.recommendedMin, 7, '<7 岗 warning（D1 修订）');
    assert.equal(body.warning?.current, 1);

    const agentMd = await readFile(join(h.ws, '.claude', 'agents', 'ceo-chief-of-staff.md'), 'utf-8');
    assert.ok(agentMd.includes('name: 小贾'), '员工名写入 agent md');
    assert.ok(agentMd.includes('roleId: ceo-chief-of-staff'), 'roleId 写入 agent md');
    const companyJson = JSON.parse(await readFile(join(h.ws, 'docs', 'registry', 'company-state.json'), 'utf-8'));
    assert.equal(companyJson.ceoName, '磨人');
    assert.deepEqual(companyJson.employees, [{ role: 'ceo-chief-of-staff', name: '小贾' }]);
    assert.equal(await readFile(join(h.ws, 'docs', 'registry', 'business-state.md'), 'utf-8'), 'REAL BUSINESS STATE', '既有内容不覆盖');
    assert.equal(await readFile(join(h.ws, 'AGENTS.md'), 'utf-8'), 'REAL AGENTS', '既有内容不覆盖');
  } finally {
    await h.cleanup();
  }
});

// ── 8. onboarding progress upsert 校验 ──

test("progress upsert + projection roundtrip（REQ-016 断点续跑真源）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "init-assemble-progress-"));
  try {
    const cs = new CompanyInitState(dir);
    await upsertOnboardingProgress(cs, { step: 'name', ceoName: '磨人' });
    await upsertOnboardingProgress(cs, { step: 'roles', selectedRoles: ['ceo-chief-of-staff'], employeeNames: { 'ceo-chief-of-staff': '小贾' } });
    const p = await getOnboardingStateProjection(cs);
    assert.equal(p.state, 'uninitialized', 'progress upsert 不改变公司态');
    assert.equal(p.step, 'roles', 'upsert 合并保留字段');
    assert.equal(p.ceoName, '磨人', '进行中答案（progress.ceoName）透出');
    assert.deepEqual(p.selectedRoles, ['ceo-chief-of-staff']);
    assert.deepEqual(p.employeeNames, { 'ceo-chief-of-staff': '小贾' });
    assert.ok(p.updatedAt, 'updatedAt 刷新');
    const s = await cs.load();
    assert.equal(s.progress?.ceoName, '磨人', 'progress.ceoName 已持久');
    assert.equal(s.progress?.step, 'roles');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validateProgressUpsert: step 枚举 / 字段形状 / 空补丁", () => {
  assert.equal(validateProgressUpsert({ step: 'name', ceoName: '磨人' }).ok, true);
  assert.equal(validateProgressUpsert({ step: 'banana' }).ok, false, 'step 非枚举 → 400');
  assert.equal(validateProgressUpsert({}).ok, false, '空补丁 → 400');
  assert.equal(validateProgressUpsert({ ceoName: '  ' }).ok, false, 'ceoName 空白 → 400');
  assert.equal(validateProgressUpsert({ selectedRoles: [1] }).ok, false, 'selectedRoles 非字符串数组 → 400');
  assert.equal(validateProgressUpsert({ employeeNames: { a: '' } }).ok, false, '员工名空白 → 400');
  const v = validateProgressUpsert({ step: 'roles', selectedRoles: ['a', 'a'], employeeNames: { a: ' 小全 ' } });
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.deepEqual(v.patch.selectedRoles, ['a'], '去重');
    assert.deepEqual(v.patch.employeeNames, { a: '小全' }, 'trim');
  }
});

// ── 9. init 模式路由（buildInitModeSystemPrompt）──

test("init mode: 链态矩阵 + 端点引用 + 零本地执行措辞", () => {
  for (const s of INIT_MODE_CHAIN_STATES) {
    const prompt = buildInitModeSystemPrompt(s);
    assert.ok(prompt, `${s} 应返回 init 模式 prompt`);
    assert.ok(prompt!.includes('初始化阶段'), 'init 模式措辞');
    assert.ok(prompt!.includes(`当前阶段：${s}`), '含当前链态');
    assert.ok(prompt!.includes('/internal/v1/init/chain/status'), '状态真源引用');
    assert.ok(prompt!.includes('/internal/v1/init/role-catalog'), '岗位目录引用');
    assert.ok(prompt!.includes('/internal/v1/init/onboarding/state'), '断点续跑真源引用');
    assert.ok(prompt!.includes('不得调用该端点'), '零本地执行措辞');
  }
  assert.equal(buildInitModeSystemPrompt('ready'), null, 'ready → 普通聊天路径');
  assert.equal(buildInitModeSystemPrompt('uninitialized'), null, 'uninitialized → 普通聊天路径');
});
