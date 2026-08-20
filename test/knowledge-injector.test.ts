// ── Knowledge Injector Tests ──
// FADE-ASSESS-003 知识注入消费链路：
//   1. 幂等重入（hash 相同跳过）
//   2. hash 变更重写（按 source_path 替换）
//   3. 项目隔离（multi-project-router + enforceProjectIsolation）
//   4. 注入块正确性（<knowledge-context> 三层顺序）
//   5. 消费记录（knowledge_consumption 行）
//   6. dry-run（不写库）
//   7. 增量同步（agentFilter）+ 主路径挂接（session-initializer）
//
// Run: npx tsx --test test/knowledge-injector.test.ts

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getKnowledgeDbPath, enforceProjectIsolation } from '../src/project/multi-project-router.js';
import { createKnowledgeStore } from '../src/knowledge-injector/knowledge-db.js';
import { syncKnowledgeFromSource } from '../src/knowledge-injector/sync.js';
import {
  buildKnowledgeContextBlock,
  injectKnowledgeContext,
} from '../src/knowledge-injector/inject.js';
import { injectHeartbeatKnowledge } from '../src/heartbeat/agent-runner.js';
import {
  recordKnowledgeMetric,
  getKnowledgeMetricSnapshot,
  isEscalationBlockReason,
} from '../src/knowledge-injector/metrics.js';
import { shouldRunJob } from '../src/cron/timer.js';
import { setRosterGate, setOnSpawnGateDenied, enforceRosterGate } from '../src/tools/agent-tool.js';
import { getContractResolver } from '../src/config/contract-resolver.js';
import { initializeSession } from '../src/company/session-initializer.js';

// ── Helpers ──

async function makeSourceRoot(agents: Array<{ id: string; layers?: Partial<Record<'memory' | 'colleagues' | 'social', string>> }>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'trilc-knowledge-src-'));
  for (const agent of agents) {
    const dir = join(root, agent.id);
    await mkdir(dir, { recursive: true });
    const layers = agent.layers ?? {};
    const defaults: Record<string, string> = {
      memory: `# ${agent.id} memory\n阶段记忆内容`,
      colleagues: `# ${agent.id} colleagues\n协作关系内容`,
      social: `# ${agent.id} social\n社交内容`,
    };
    for (const layer of ['memory', 'colleagues', 'social'] as const) {
      await writeFile(join(dir, `${agent.id}.${layer}.md`), layers[layer] ?? defaults[layer], 'utf-8');
    }
  }
  return root;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// ═══════════════════════════════════════════════════════════════════
// 0. Router：knowledge.db 路径归属隔离目录
// ═══════════════════════════════════════════════════════════════════

describe('knowledge-injector — router path', () => {
  let projectRoot: string;
  before(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'trilc-kn-proj0-'));
  });
  after(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('knowledgeDbPath 落在 {projectRoot}/.tricompany-cognition/ 下', () => {
    const dbPath = getKnowledgeDbPath(projectRoot);
    assert.ok(dbPath.startsWith(join(projectRoot, '.tricompany-cognition')));
    assert.ok(dbPath.endsWith('knowledge.db'));
  });

  it('getKnowledgeDbPath 与 resolveProjectPaths 同源', () => {
    const dbPath = getKnowledgeDbPath(projectRoot);
    // enforceProjectIsolation 对自己的项目路径不抛错（隔离天然覆盖）
    assert.doesNotThrow(() => enforceProjectIsolation(projectRoot, dbPath));
  });
});

// ═══════════════════════════════════════════════════════════════════
// 1-3. 同步：幂等重入 / hash 变更重写 / dry-run / 增量
// ═══════════════════════════════════════════════════════════════════

describe('knowledge-injector — sync', () => {
  let sourceRoot: string;
  let projectRoot: string;
  let dbPath: string;

  before(async () => {
    sourceRoot = await makeSourceRoot([
      { id: 'alpha', layers: { memory: '# alpha memory\nv1 内容' } },
      { id: 'beta' },
    ]);
    projectRoot = await mkdtemp(join(tmpdir(), 'trilc-kn-proj1-'));
    dbPath = getKnowledgeDbPath(projectRoot);
  });
  after(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('全量同步：三层落库 + 命名空间映射 + SHA-256 幂等键', () => {
    const report = syncKnowledgeFromSource({ sourceRoot, projectRoot });

    assert.equal(report.scanned, 6); // 2 agents × 3 layers
    assert.equal(report.inserted, 6);
    assert.equal(report.skipped, 0);
    assert.equal(report.errors.length, 0);

    const store = createKnowledgeStore(dbPath, { projectRoot });
    try {
      assert.equal(store.countDocuments(), 6);

      const docs = store.listLatestDocuments('employee/alpha', 'alpha');
      assert.equal(docs.length, 3);
      assert.deepEqual(docs.map((d) => d.layer), ['memory', 'colleagues', 'social']);
      for (const doc of docs) {
        assert.equal(doc.namespace, 'employee/alpha');
        assert.equal(doc.agentId, 'alpha');
        assert.equal(doc.contentHash, sha256(doc.content));
        assert.equal(doc.sourcePath, join(sourceRoot, 'alpha', `alpha.${doc.layer}.md`));
      }
      const memoryDoc = docs[0];
      assert.ok(memoryDoc.content.includes('v1 内容'));
    } finally {
      store.close();
    }
  });

  it('幂等重入：hash 相同全部跳过，不产生重复行', () => {
    const report = syncKnowledgeFromSource({ sourceRoot, projectRoot });

    assert.equal(report.inserted, 0);
    assert.equal(report.skipped, 6);

    const store = createKnowledgeStore(dbPath, { projectRoot });
    try {
      assert.equal(store.countDocuments(), 6); // 无重复
    } finally {
      store.close();
    }
  });

  it('hash 变更重写：同 source_path 旧版本被替换，数量不变', async () => {
    const memoryPath = join(sourceRoot, 'alpha', 'alpha.memory.md');
    await writeFile(memoryPath, '# alpha memory\nv2 内容（变更）', 'utf-8');

    const report = syncKnowledgeFromSource({ sourceRoot, projectRoot });
    assert.equal(report.inserted, 1);
    assert.equal(report.skipped, 5);

    const store = createKnowledgeStore(dbPath, { projectRoot });
    try {
      assert.equal(store.countDocuments(), 6); // 替换而非追加
      const docs = store.listLatestDocuments('employee/alpha', 'alpha');
      const memoryDoc = docs.find((d) => d.layer === 'memory')!;
      assert.ok(memoryDoc.content.includes('v2 内容'));
      assert.equal(memoryDoc.contentHash, sha256(memoryDoc.content));
      // 旧 hash 已无对应行
      const oldHash = sha256('# alpha memory\nv1 内容');
      assert.notEqual(memoryDoc.contentHash, oldHash);
    } finally {
      store.close();
    }
  });

  it('增量同步（agentFilter）：只同步指定 agent', () => {
    const report = syncKnowledgeFromSource({
      sourceRoot,
      projectRoot,
      agentFilter: ['beta'],
    });
    // beta 三层已落库 → 全部跳过；alpha 不扫描
    assert.equal(report.scanned, 3);
    assert.equal(report.inserted, 0);
    assert.equal(report.skipped, 3);
  });

  it('dry-run：不创建/不写 knowledge.db', () => {
    const isolatedRoot = join(tmpdir(), `trilc-kn-dryrun-${Date.now()}`);
    const report = syncKnowledgeFromSource({ sourceRoot, projectRoot: isolatedRoot, dryRun: true });

    assert.equal(report.dryRun, true);
    assert.equal(report.inserted, 0);
    assert.equal(report.wouldInsert, 6); // 6 个源文件
    assert.ok(!existsSync(getKnowledgeDbPath(isolatedRoot)), 'dry-run 不得创建 DB 文件');
  });

  it('空文件：不落库且移除既有行（防陈旧知识注入）', async () => {
    const emptyPath = join(sourceRoot, 'beta', 'beta.social.md');
    const original = await readFileSync(emptyPath, 'utf-8');
    await writeFile(emptyPath, '   \n', 'utf-8');

    const report = syncKnowledgeFromSource({ sourceRoot, projectRoot });
    // beta.social 为空 → 既有行移除（removed=1）；其余 5 个 hash 未变 → skipped
    assert.equal(report.inserted, 0);
    assert.equal(report.skipped, 5);
    assert.equal(report.removed, 1);

    const store = createKnowledgeStore(dbPath, { projectRoot });
    try {
      assert.equal(store.countDocuments(), 5);
      const docs = store.listLatestDocuments('employee/beta', 'beta');
      assert.deepEqual(docs.map((d) => d.layer), ['memory', 'colleagues']); // social 未落库
    } finally {
      store.close();
    }

    await writeFile(emptyPath, original, 'utf-8'); // 还原，避免影响后续用例
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. 项目隔离
// ═══════════════════════════════════════════════════════════════════

describe('knowledge-injector — project isolation', () => {
  let sourceRoot: string;
  let projectA: string;
  let projectB: string;

  before(async () => {
    sourceRoot = await makeSourceRoot([{ id: 'alpha' }]);
    projectA = await mkdtemp(join(tmpdir(), 'trilc-kn-projA-'));
    projectB = await mkdtemp(join(tmpdir(), 'trilc-kn-projB-'));
    syncKnowledgeFromSource({ sourceRoot, projectRoot: projectA });
  });
  after(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(projectA, { recursive: true, force: true });
    await rm(projectB, { recursive: true, force: true });
  });

  it('跨项目访问被 enforceProjectIsolation 拒绝', () => {
    const bDbPath = getKnowledgeDbPath(projectB);
    assert.throws(
      () => createKnowledgeStore(bDbPath, { projectRoot: projectA }),
      /Cross-project access denied/,
    );
  });

  it('两个项目各自独立知识库，互不可见', () => {
    // A 已同步（3 文档）；B 未同步
    const storeA = createKnowledgeStore(getKnowledgeDbPath(projectA), { projectRoot: projectA });
    try {
      assert.equal(storeA.countDocuments(), 3);
    } finally {
      storeA.close();
    }

    const storeB = createKnowledgeStore(getKnowledgeDbPath(projectB), { projectRoot: projectB });
    try {
      assert.equal(storeB.countDocuments(), 0);
    } finally {
      storeB.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5-6. 注入：注入块正确性 / 消费记录 / 降级
// ═══════════════════════════════════════════════════════════════════

describe('knowledge-injector — injection', () => {
  let sourceRoot: string;
  let projectRoot: string;

  before(async () => {
    sourceRoot = await makeSourceRoot([
      { id: 'alpha', layers: { memory: 'M1 内容', colleagues: 'C1 内容', social: 'S1 内容' } },
    ]);
    projectRoot = await mkdtemp(join(tmpdir(), 'trilc-kn-proj2-'));
    syncKnowledgeFromSource({ sourceRoot, projectRoot });
  });
  after(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('注入块组装：<knowledge-context> 内 Memory → Colleagues → Social 顺序', () => {
    const block = buildKnowledgeContextBlock('employee/alpha', [
      { layer: 'memory', content: 'M1 内容' },
      { layer: 'colleagues', content: 'C1 内容' },
      { layer: 'social', content: 'S1 内容' },
    ]);

    assert.ok(block.startsWith('<knowledge-context namespace="employee/alpha">'));
    assert.ok(block.endsWith('</knowledge-context>'));
    const memIdx = block.indexOf('## Memory');
    const colIdx = block.indexOf('## Colleagues');
    const socIdx = block.indexOf('## Social');
    assert.ok(memIdx > -1 && colIdx > memIdx && socIdx > colIdx, '三层顺序固定');
    assert.ok(block.includes('M1 内容') && block.includes('C1 内容') && block.includes('S1 内容'));
  });

  it('注入：追加知识块到 prompt 并按层写消费记录', () => {
    const result = injectKnowledgeContext({
      projectRoot,
      agentId: 'alpha',
      systemPrompt: 'SOUL+BODY',
      sessionId: 'sess_knowledge_test',
    });

    assert.equal(result.injected, true);
    assert.ok(result.prompt.startsWith('SOUL+BODY'));
    assert.ok(result.prompt.includes('<knowledge-context namespace="employee/alpha">'));
    assert.deepEqual(result.layers, ['memory', 'colleagues', 'social']);
    assert.equal(result.consumed, 3);

    const store = createKnowledgeStore(getKnowledgeDbPath(projectRoot), { projectRoot });
    try {
      assert.equal(store.countConsumptions(), 3);
    } finally {
      store.close();
    }
  });

  it('注入：重复注入同 hash 也留痕（审计面逐次记录）', () => {
    const first = injectKnowledgeContext({
      projectRoot,
      agentId: 'alpha',
      systemPrompt: 'P',
      sessionId: 's1',
    });
    const second = injectKnowledgeContext({
      projectRoot,
      agentId: 'alpha',
      systemPrompt: 'P',
      sessionId: 's2',
    });
    assert.equal(first.consumed, 3);
    assert.equal(second.consumed, 3);
    const store = createKnowledgeStore(getKnowledgeDbPath(projectRoot), { projectRoot });
    try {
      assert.equal(store.countConsumptions(), 9);
    } finally {
      store.close();
    }
  });

  it('注入：无知识库/无该员工知识 → 原 prompt 降级返回', () => {
    const freshRoot = join(tmpdir(), `trilc-kn-noknow-${Date.now()}`);
    const result = injectKnowledgeContext({
      projectRoot: freshRoot,
      agentId: 'ghost',
      systemPrompt: 'SOUL',
    });
    assert.equal(result.injected, false);
    assert.equal(result.prompt, 'SOUL');
    assert.equal(result.consumed, 0);

    // 有知识库但该员工无知识 → 同样降级
    const result2 = injectKnowledgeContext({
      projectRoot,
      agentId: 'ghost',
      systemPrompt: 'SOUL',
    });
    assert.equal(result2.injected, false);
    assert.equal(result2.prompt, 'SOUL');
  });

  it('注入：systemPrompt 为空时注入块独立成文', () => {
    const result = injectKnowledgeContext({
      projectRoot,
      agentId: 'alpha',
      systemPrompt: '',
    });
    assert.equal(result.injected, true);
    assert.ok(result.prompt.startsWith('<knowledge-context'));
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7.5 小乔验证指标：v2 迁移 / 计数聚合 / 快照 / reason 分类 / 回调触发
// ═══════════════════════════════════════════════════════════════════

describe('knowledge-injector — behavior metrics (小乔验证指标)', () => {
  let projectRoot: string;
  let dbPath: string;

  before(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'trilc-kn-metrics-'));
    dbPath = getKnowledgeDbPath(projectRoot);
  });
  after(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('v1 旧库打开自动迁移 v2：knowledge_metrics 表可用', () => {
    // 手工建 v1 库（user_version=1，无 metrics 表）→ 打开 → v2 表出现
    mkdirSync(dirname(dbPath), { recursive: true });
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE knowledge_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        namespace TEXT NOT NULL, layer TEXT NOT NULL, agent_id TEXT NOT NULL,
        source_path TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL,
        source_mtime TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1,
        synced_at TEXT NOT NULL,
        UNIQUE(namespace, layer, agent_id, content_hash)
      );
      PRAGMA user_version=1;
    `);
    raw.close();

    const store = createKnowledgeStore(dbPath, { projectRoot });
    try {
      // v2 显式断言：user_version 已升到 2（schema 同步）
      const probe = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const v = probe.prepare('PRAGMA user_version').get() as { user_version: number };
        assert.equal(v.user_version, 2, '迁移后 user_version 应为 2');
      } finally {
        probe.close();
      }
      store.recordMetric({
        event: 'routing_error',
        agentId: 'chief-financial-officer',
        detail: 'migration_test',
        createdAt: new Date().toISOString(),
      });
      assert.equal(store.getMetricCounts()[0]?.count, 1);
      assert.equal(store.getMetricCounts()[0]?.event, 'routing_error');
    } finally {
      store.close();
    }
  });

  it('指标计数聚合 + 会话统计（分母素材）', () => {
    recordKnowledgeMetric({ projectRoot, event: 'escalation_blocked', agentId: 'alpha', sessionId: 's1', detail: 'tool:bash' });
    recordKnowledgeMetric({ projectRoot, event: 'escalation_blocked', agentId: 'alpha', sessionId: 's2', detail: 'tool:write' });
    recordKnowledgeMetric({ projectRoot, event: 'routing_error', agentId: 'chief-financial-officer', detail: 'tasks_submit_gate:candidate' });

    const store = createKnowledgeStore(dbPath, { projectRoot });
    try {
      const counts = store.getMetricCounts();
      assert.deepEqual(
        counts.sort((a, b) => a.event.localeCompare(b.event)),
        [
          { event: 'escalation_blocked', count: 2 },
          { event: 'routing_error', count: 2 },
        ],
      );
      const stats = store.getConsumptionSessionStats();
      assert.equal(stats.total, 0); // 本 describe 未注入消费
      assert.equal(stats.withSession, 0);
    } finally {
      store.close();
    }
  });

  it('快照：库不存在 → 全零；库存在 → 分子分母齐备', () => {
    const freshRoot = join(tmpdir(), `trilc-kn-nodb-${Date.now()}`);
    const empty = getKnowledgeMetricSnapshot(freshRoot);
    assert.equal(empty.consumptionTotal, 0);
    assert.deepEqual(empty.counts, []);
    assert.equal(empty.documentsTotal, 0);

    const snap = getKnowledgeMetricSnapshot(projectRoot);
    assert.equal(snap.consumptionTotal, 0);
    assert.equal(snap.counts.length, 2);
  });

  it('isEscalationBlockReason：越权语义计入，用户拒绝/执行异常不计', () => {
    assert.equal(isEscalationBlockReason('Blocked by permission engine (default)'), true);
    assert.equal(isEscalationBlockReason('Tool "rm" is not allowed for tier subagent'), true);
    assert.equal(isEscalationBlockReason('Tool is forbidden by contract decision rights'), true);
    assert.equal(isEscalationBlockReason('User denied permission for tool "bash"'), false);
    assert.equal(isEscalationBlockReason('exec failed: ENOENT'), false);
    assert.equal(isEscalationBlockReason('Repeated identical failure for tool "read" — possible loop'), false);
  });

  it('cron shouldRunJob：非在岗 → onRoleGateDenied 回调触发', async () => {
    let denied: string[] = [];
    const run = await shouldRunJob(
      {
        isRoleActive: async () => false,
        onRoleGateDenied: (roleId) => { denied.push(roleId); },
      },
      { id: 'j1', roleId: 'chief-financial-officer', enabled: true } as any,
    );
    assert.equal(run.run, false);
    assert.deepEqual(denied, ['chief-financial-officer']);

    // 在岗 → 回调不触发
    const run2 = await shouldRunJob(
      {
        isRoleActive: async () => true,
        onRoleGateDenied: (roleId) => { denied.push(roleId); },
      },
      { id: 'j2', roleId: 'full-stack-developer', enabled: true } as any,
    );
    assert.equal(run2.run, true);
    assert.deepEqual(denied, ['chief-financial-officer']);
  });

  it('agent-tool spawn 门禁：非在岗 → onSpawnGateDenied 回调触发', async () => {
    setRosterGate(async () => ({ status: 'candidate' }));
    const denied: string[] = [];
    setOnSpawnGateDenied((roleId, status) => { denied.push(`${roleId}:${status}`); });

    const gate = await enforceRosterGate('chief-financial-officer');
    assert.equal(gate.ok, false);
    assert.equal(gate.error, 'role_not_active');
    assert.deepEqual(denied, ['chief-financial-officer:candidate']);

    // 在岗 → 回调不触发
    setRosterGate(async () => ({ status: 'active' }));
    const gate2 = await enforceRosterGate('full-stack-developer');
    assert.equal(gate2.ok, true);
    assert.deepEqual(denied, ['chief-financial-officer:candidate']);

    // 清理注入（防污染其他测试）
    setRosterGate(null);
    setOnSpawnGateDenied(null);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. 主路径挂接：session-initializer SessionConfig 组装后追加
// ═══════════════════════════════════════════════════════════════════

describe('knowledge-injector — session-initializer main path', () => {
  let sourceRoot: string;
  let projectRoot: string;
  const prevEnv = process.env.TRILC_PROJECT_ROOT;

  before(async () => {
    sourceRoot = await mkdtemp(join(tmpdir(), 'trilc-kn-main-'));
    const agentDir = join(sourceRoot, 'sample-agent');
    await mkdir(agentDir, { recursive: true });

    await Promise.all([
      writeFile(join(agentDir, 'sample-agent.soul.md'), 'Sample soul', 'utf-8'),
      writeFile(join(agentDir, 'sample-agent.memory.md'), '知识记忆层', 'utf-8'),
      writeFile(join(agentDir, 'sample-agent.colleagues.md'), '知识协作层', 'utf-8'),
      writeFile(join(agentDir, 'sample-agent.social.md'), '知识社交层', 'utf-8'),
      writeFile(
        join(agentDir, 'sample-agent.contract.yaml'),
        [
          'contract:',
          '  version: "3.0"',
          '  type: agent-contract',
          '  agent_id: sample-agent',
          '  family: Role',
          'identity:',
          '  display_name: sample',
          '  role: SampleAgent',
          '  description: test agent',
          'paths:',
          '  soul: sample-agent/sample-agent.soul.md',
          '  agent_body: sample-agent/sample-agent.soul.md',
          '  agent_frontmatter: sample-agent/sample-agent.soul.md',
          '  memory: sample-agent/sample-agent.memory.md',
          '  colleagues: sample-agent/sample-agent.colleagues.md',
          '  social: sample-agent/sample-agent.social.md',
          'responsibilities:',
          '  - test duty',
          'decision_rights:',
          '  approve:',
          '    - release',
          '  forbidden:',
          '    - skip tests',
          'collaborators:',
          '  reports_to: ceo',
          'io_contract:',
          '  inputs:',
          '    - type: msg',
          '      description: test input',
          '  outputs:',
          '    - type: res',
          '      description: test output',
        ].join('\n'),
        'utf-8',
      ),
    ]);

    projectRoot = await mkdtemp(join(tmpdir(), 'trilc-kn-mainproj-'));
    process.env.TRILC_PROJECT_ROOT = projectRoot;

    // 装配 resolver 单例 + 全量知识同步（daemon 启动同序：loadAll → sync）
    getContractResolver(sourceRoot);
    await getContractResolver().loadAll();
    syncKnowledgeFromSource({ sourceRoot, projectRoot });
  });
  after(async () => {
    if (prevEnv === undefined) delete process.env.TRILC_PROJECT_ROOT;
    else process.env.TRILC_PROJECT_ROOT = prevEnv;
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('initializeSession 返回的 systemPrompt 含知识注入块（三层顺序）', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'trilc-kn-ws-'));
    const config = await initializeSession('sample-agent', workspaceRoot);

    assert.ok(config.systemPrompt.startsWith('Sample soul\n\nSample soul'));
    assert.ok(config.systemPrompt.includes('<knowledge-context namespace="employee/sample-agent">'));
    const memIdx = config.systemPrompt.indexOf('## Memory');
    const colIdx = config.systemPrompt.indexOf('## Colleagues');
    const socIdx = config.systemPrompt.indexOf('## Social');
    assert.ok(memIdx > -1 && colIdx > memIdx && socIdx > colIdx);
    assert.ok(config.systemPrompt.includes('知识记忆层'));

    // 主路径注入：会话尚未创建 → 消费记录 session_id 为 null
    const store = createKnowledgeStore(getKnowledgeDbPath(projectRoot), { projectRoot });
    try {
      assert.equal(store.countConsumptions(), 3);
    } finally {
      store.close();
    }
    await rm(workspaceRoot, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7.6 heartbeat 会话注入挂接点（agent-runner.ts 可测注入缝）
// ═══════════════════════════════════════════════════════════════════
// FADE-ASSESS-003 消费路径挂接点③：runHeartbeatAgent 在会话创建前经
// injectHeartbeatKnowledge 注入，session_id 只有此处可知（消费记录需要）。
// 覆盖缺口固化：env 注入口径 / 显式 projectRoot 优先 / 无知识降级不阻断。

describe('knowledge-injector — heartbeat 会话注入挂接点 (agent-runner seam)', () => {
  let sourceRoot: string;
  let projectRootA: string;      // 已同步知识（env 指向）
  let projectRootEmpty: string;  // 无知识库
  const prevEnv = process.env.TRILC_PROJECT_ROOT;

  before(async () => {
    sourceRoot = await makeSourceRoot([{ id: 'alpha' }]);
    projectRootA = await mkdtemp(join(tmpdir(), 'trilc-kn-hb-a-'));
    projectRootEmpty = await mkdtemp(join(tmpdir(), 'trilc-kn-hb-e-'));
    syncKnowledgeFromSource({ sourceRoot, projectRoot: projectRootA });
    process.env.TRILC_PROJECT_ROOT = projectRootA;
  });
  after(async () => {
    if (prevEnv === undefined) delete process.env.TRILC_PROJECT_ROOT;
    else process.env.TRILC_PROJECT_ROOT = prevEnv;
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(projectRootA, { recursive: true, force: true });
    await rm(projectRootEmpty, { recursive: true, force: true });
  });

  it('env 注入口径：heartbeat 默认 prompt 追加知识块 + 消费记录携带 session_id', () => {
    const sessionId = 'hb_alpha_test_001';
    const defaultPrompt = 'You are heartbeat agent "alpha". Execute your periodic task concisely.';
    const result = injectHeartbeatKnowledge({
      agentId: 'alpha',
      systemPrompt: defaultPrompt,
      sessionId,
    });

    assert.equal(result.injected, true);
    assert.ok(result.prompt.startsWith(defaultPrompt), '注入只追加不替换原 prompt');
    assert.ok(result.prompt.includes('<knowledge-context namespace="employee/alpha">'));
    assert.deepEqual(result.layers, ['memory', 'colleagues', 'social']);
    assert.equal(result.consumed, 3);

    // 挂接点语义：session_id 只有 heartbeat 会话创建处可知 → 消费记录必须携带
    const store = createKnowledgeStore(getKnowledgeDbPath(projectRootA), { projectRoot: projectRootA });
    try {
      const stats = store.getConsumptionSessionStats();
      assert.equal(stats.total, 3);
      assert.equal(stats.withSession, 3, 'heartbeat 注入的消费记录必须带 session_id');
      assert.equal(stats.distinctSessions, 1);
    } finally {
      store.close();
    }
  });

  it('显式 projectRoot 优先于 env：传无知识根 → 降级（env 有知识也不注入）', () => {
    const result = injectHeartbeatKnowledge({
      projectRoot: projectRootEmpty, // 显式指向无知识库
      agentId: 'alpha',
      systemPrompt: 'SOUL',
      sessionId: 'hb_explicit_empty',
    });

    assert.equal(result.injected, false, '显式 projectRoot 必须优先于 env（不得注入 env 知识）');
    assert.equal(result.prompt, 'SOUL');
    assert.equal(result.consumed, 0);
  });

  it('env 指向无知识库 → 降级返回原 prompt，不阻断 heartbeat', () => {
    const prev = process.env.TRILC_PROJECT_ROOT;
    process.env.TRILC_PROJECT_ROOT = projectRootEmpty;
    try {
      const result = injectHeartbeatKnowledge({
        agentId: 'alpha',
        systemPrompt: 'HB-SOUL',
        sessionId: 'hb_env_empty',
      });
      assert.equal(result.injected, false);
      assert.equal(result.prompt, 'HB-SOUL');
      assert.equal(result.consumed, 0);
    } finally {
      if (prev === undefined) delete process.env.TRILC_PROJECT_ROOT;
      else process.env.TRILC_PROJECT_ROOT = prev;
    }
  });
});
