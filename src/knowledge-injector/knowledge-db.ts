// ── TriLC Knowledge Store (SQLite) ──
// FADE-ASSESS-003 知识注入消费链路：五件套三层契约（memory/colleagues/social）
// → {projectRoot}/.tricompany-cognition/knowledge.db（multi-project-router 隔离天然
// 覆盖；指定 projectRoot 时 enforceProjectIsolation 生效，跨项目访问抛错）。
//
// sessions.db 同模式：node:sqlite + PRAGMA journal_mode=WAL +
// PRAGMA user_version 迁移（v1 起）。
//
// Schema v1:
//   knowledge_documents    — 知识文档（源只读同步落库；content_hash=SHA-256 幂等键）
//   knowledge_consumption  — 消费记录（每次注入写一行，审计面）
// Schema v2（FADE-ASSESS-003 小乔验证指标，2026-08-20）:
//   knowledge_metrics      — 行为观测计数（分子面；分母=knowledge_consumption 聚合）
//
// 语义边界（CEO 2026-08-19 双部署模型定调）：五件套 = 契约（静态知识资产），
// 不是消费记录；消费记录单独落在 knowledge_consumption。

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { enforceProjectIsolation } from '../project/multi-project-router.js';

// ── Types ──

export type KnowledgeLayer = 'memory' | 'colleagues' | 'social';

export const KNOWLEDGE_LAYERS: readonly KnowledgeLayer[] = ['memory', 'colleagues', 'social'];

/** 命名空间：employee/<id>（注入面）| org/shared（预留）| org/audit（不注入）。 */
export type KnowledgeNamespace = `employee/${string}` | 'org/shared' | 'org/audit';

/** 注入模式：boot=会话启动注入（MVP 全部消费路径）；reload=watch 热重载后补注入（预留）。 */
export type InjectionMode = 'boot' | 'reload';

export interface KnowledgeDocument {
  /** 命名空间，employee/<id> 由 sync 按 source-agents/<id> 映射。 */
  namespace: string;
  layer: KnowledgeLayer;
  /** source-agents 子目录名（agent 合同 id）。 */
  agentId: string;
  /** 源文件绝对路径（只读引用，不落内容副本之外的状态）。 */
  sourcePath: string;
  content: string;
  /** SHA-256 幂等键。 */
  contentHash: string;
  /** 源文件 mtime（ISO），供 hash 不变时的变更面观察。 */
  sourceMtime: string;
  /** 本次落库时间（ISO）。 */
  syncedAt: string;
}

export interface ConsumptionRecord {
  namespace: string;
  agentId: string;
  contentHash: string;
  /** 会话 id；prompt 组装先于会话创建时（主路径/端点）为 null。 */
  sessionId: string | null;
  injectionMode: InjectionMode;
  consumedAt: string;
}

/** 行为观测事件（小乔验证指标，分子面）。 */
export type KnowledgeMetricEvent = 'escalation_blocked' | 'routing_error';

export interface KnowledgeMetricRecord {
  event: KnowledgeMetricEvent;
  agentId: string;
  sessionId?: string | null;
  /** 事件来源/原因摘要（≤500 字符）。 */
  detail?: string | null;
  createdAt: string;
}

// ── Schema ──

const CURRENT_SCHEMA_VERSION = 2;

const DDL = `
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL CHECK (
    namespace LIKE 'employee/%' OR namespace IN ('org/shared', 'org/audit')
  ),
  layer TEXT NOT NULL CHECK (layer IN ('memory', 'colleagues', 'social')),
  agent_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_mtime TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT NOT NULL,
  UNIQUE(namespace, layer, agent_id, content_hash)
);

CREATE TABLE IF NOT EXISTS knowledge_consumption (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  session_id TEXT,
  injection_mode TEXT NOT NULL CHECK (injection_mode IN ('boot', 'reload')),
  consumed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kd_agent ON knowledge_documents(namespace, agent_id, layer);
CREATE INDEX IF NOT EXISTS idx_kc_agent ON knowledge_consumption(agent_id, consumed_at);
`;

// v2（小乔验证指标）：行为观测计数表。event ∈ escalation_blocked | routing_error。
// 分母 = knowledge_consumption 聚合（注入成功次数/会话数），分子 = 本表计数。
const MIGRATIONS: Record<number, string> = {
  2: `
    CREATE TABLE IF NOT EXISTS knowledge_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL CHECK (event IN ('escalation_blocked', 'routing_error')),
      agent_id TEXT NOT NULL,
      session_id TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_km_event ON knowledge_metrics(event, created_at);
  `,
};

// ── Store ──

export interface KnowledgeStore {
  /**
   * 幂等 upsert：content_hash 唯一键命中 → {status:'skipped'}；
   * hash 变更 → 按 (namespace, layer, agent_id, source_path) 重写旧版本再插入。
   */
  upsertDocument(doc: KnowledgeDocument): { status: 'inserted' | 'skipped'; id?: number };
  /**
   * 源文件清空/删除 → 按 source_path 移除既有行（防陈旧知识注入；幂等，无行可删无害）。
   * 返回删除行数。
   */
  removeDocumentBySource(namespace: string, layer: KnowledgeLayer, agentId: string, sourcePath: string): number;
  /** 该员工每个 layer 的最新文档（memory → colleagues → social 顺序）。 */
  listLatestDocuments(namespace: string, agentId: string): Array<KnowledgeDocument & { id: number }>;
  /** 注入消费记录（每次注入每文档一行）。 */
  recordConsumption(record: ConsumptionRecord): void;
  /** 行为观测计数（v2；越权升级/路由错误分子面）。 */
  recordMetric(record: KnowledgeMetricRecord): void;
  /** 指标计数聚合（按 event 分组，含总量）。 */
  getMetricCounts(): Array<{ event: KnowledgeMetricEvent; count: number }>;
  /** 消费记录会话统计（覆盖率分母素材）。 */
  getConsumptionSessionStats(): { total: number; withSession: number; distinctSessions: number };
  countDocuments(): number;
  countConsumptions(): number;
  close(): void;
}

/**
 * 打开（必要时创建）知识库。
 *
 * @param dbPath      知识库路径（应经 getKnowledgeDbPath(projectRoot) 取得）。
 * @param opts.projectRoot 指定时先跑 enforceProjectIsolation（跨项目访问抛错）。
 */
export function createKnowledgeStore(
  dbPath: string,
  opts?: { projectRoot?: string },
): KnowledgeStore {
  if (opts?.projectRoot) {
    enforceProjectIsolation(opts.projectRoot, dbPath);
  }

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec(DDL);

  // ── Schema migration（sessions.db 同模式）──
  const currentVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (currentVersion < CURRENT_SCHEMA_VERSION) {
    for (let v = currentVersion + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
      if (MIGRATIONS[v]) {
        db.exec(MIGRATIONS[v]);
      }
    }
    db.prepare(`PRAGMA user_version=${CURRENT_SCHEMA_VERSION}`).run();
    console.log(`[knowledge-db] migrated schema v${currentVersion} → v${CURRENT_SCHEMA_VERSION}`);
  }

  // ── Prepared statements ──

  const findByHashStmt = db.prepare(
    `SELECT id FROM knowledge_documents
     WHERE namespace = ? AND layer = ? AND agent_id = ? AND content_hash = ?`,
  );
  const deleteBySourceStmt = db.prepare(
    `DELETE FROM knowledge_documents
     WHERE namespace = ? AND layer = ? AND agent_id = ? AND source_path = ?`,
  );
  const insertDocStmt = db.prepare(
    `INSERT INTO knowledge_documents
       (namespace, layer, agent_id, source_path, content, content_hash, source_mtime, schema_version, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const listDocsStmt = db.prepare(
    `SELECT * FROM knowledge_documents
     WHERE namespace = ? AND agent_id = ?
     ORDER BY
       CASE layer WHEN 'memory' THEN 1 WHEN 'colleagues' THEN 2 ELSE 3 END,
       synced_at DESC`,
  );
  const insertConsumptionStmt = db.prepare(
    `INSERT INTO knowledge_consumption
       (namespace, agent_id, content_hash, session_id, injection_mode, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMetricStmt = db.prepare(
    `INSERT INTO knowledge_metrics (event, agent_id, session_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const metricCountsStmt = db.prepare(
    `SELECT event, COUNT(*) AS count FROM knowledge_metrics GROUP BY event`,
  );
  const consumptionSessionStatsStmt = db.prepare(
    `SELECT
       COUNT(*) AS total,
       COUNT(session_id) AS with_session,
       COUNT(DISTINCT session_id) AS distinct_sessions
     FROM knowledge_consumption`,
  );

  function upsertDocument(doc: KnowledgeDocument): { status: 'inserted' | 'skipped'; id?: number } {
    const existing = findByHashStmt.get(doc.namespace, doc.layer, doc.agentId, doc.contentHash) as
      | { id: number }
      | undefined;
    if (existing) {
      return { status: 'skipped', id: existing.id };
    }
    // hash 变更 → 按源文件重写（保留每 source_path 仅最新版本）
    deleteBySourceStmt.run(doc.namespace, doc.layer, doc.agentId, doc.sourcePath);
    const result = insertDocStmt.run(
      doc.namespace,
      doc.layer,
      doc.agentId,
      doc.sourcePath,
      doc.content,
      doc.contentHash,
      doc.sourceMtime,
      CURRENT_SCHEMA_VERSION,
      doc.syncedAt,
    );
    return { status: 'inserted', id: Number(result.lastInsertRowid) };
  }

  function listLatestDocuments(namespace: string, agentId: string): Array<KnowledgeDocument & { id: number }> {
    const rows = listDocsStmt.all(namespace, agentId) as unknown as Array<
      Record<string, unknown> & { id: number }
    >;
    const byLayer = new Map<KnowledgeLayer, (KnowledgeDocument & { id: number })>();
    for (const row of rows) {
      const layer = row.layer as KnowledgeLayer;
      if (byLayer.has(layer)) continue; // 按 synced_at DESC 已排序，首个即最新
      byLayer.set(layer, rowToDocument(row));
    }
    // memory → colleagues → social 固定顺序（与 KNOWLEDGE_LAYERS 一致）
    return KNOWLEDGE_LAYERS
      .map((layer) => byLayer.get(layer))
      .filter((doc): doc is KnowledgeDocument & { id: number } => !!doc);
  }

  function removeDocumentBySource(
    namespace: string,
    layer: KnowledgeLayer,
    agentId: string,
    sourcePath: string,
  ): number {
    const result = deleteBySourceStmt.run(namespace, layer, agentId, sourcePath);
    return Number(result.changes);
  }

  function recordConsumption(record: ConsumptionRecord): void {
    insertConsumptionStmt.run(
      record.namespace,
      record.agentId,
      record.contentHash,
      record.sessionId,
      record.injectionMode,
      record.consumedAt,
    );
  }

  function recordMetric(record: KnowledgeMetricRecord): void {
    insertMetricStmt.run(
      record.event,
      record.agentId,
      record.sessionId ?? null,
      (record.detail ?? '').slice(0, 500) || null,
      record.createdAt,
    );
  }

  function getMetricCounts(): Array<{ event: KnowledgeMetricEvent; count: number }> {
    const rows = metricCountsStmt.all() as unknown as Array<{ event: string; count: number }>;
    return rows.map((row) => ({ event: row.event as KnowledgeMetricEvent, count: row.count }));
  }

  function getConsumptionSessionStats(): { total: number; withSession: number; distinctSessions: number } {
    const row = consumptionSessionStatsStmt.get() as {
      total: number;
      with_session: number;
      distinct_sessions: number;
    };
    return {
      total: row.total,
      withSession: row.with_session,
      distinctSessions: row.distinct_sessions,
    };
  }

  function countDocuments(): number {
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM knowledge_documents').get() as { cnt: number };
    return row.cnt;
  }

  function countConsumptions(): number {
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM knowledge_consumption').get() as { cnt: number };
    return row.cnt;
  }

  function close(): void {
    db.close();
  }

  return {
    upsertDocument,
    removeDocumentBySource,
    listLatestDocuments,
    recordConsumption,
    recordMetric,
    getMetricCounts,
    getConsumptionSessionStats,
    countDocuments,
    countConsumptions,
    close,
  };
}

// ── Row mapper ──

function rowToDocument(row: Record<string, unknown> & { id: number }): KnowledgeDocument & { id: number } {
  return {
    id: row.id,
    namespace: row.namespace as string,
    layer: row.layer as KnowledgeLayer,
    agentId: row.agent_id as string,
    sourcePath: row.source_path as string,
    content: row.content as string,
    contentHash: row.content_hash as string,
    sourceMtime: row.source_mtime as string,
    syncedAt: row.synced_at as string,
  };
}
