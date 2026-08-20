// ── Knowledge Behavior Metrics ──
// FADE-ASSESS-003 小乔验证指标（2026-08-20 补充定案）：
//   三条可观测改善（越权升级下降 / 角色首轮响应符合口径 / 协作审批按契约对齐）
//   的量化分子面。分母 = knowledge_consumption 记录面（注入成功次数/会话覆盖率）。
//
// 指标事件（TriLC 事件层轻量埋点，全部一行式接入）：
//   escalation_blocked — 越权类行为被拦（tool_blocked 中权限/合同拒绝类 reason；
//                        执行异常/用户交互拒绝/重复失败不计——非越权语义）
//   routing_error      — 任务/调度路由到未在岗岗（tasks/submit 409、分身 spawn 409、
//                        cron roleId skipped）
//
// 轻量原则：不引入独立存储，knowledge_metrics 表随 knowledge.db user_version v2
// 迁移（sessions.db 同模式）；记录失败降级 warn，不阻断业务路径。
// 注入面（daemon 组装处注入回调）与直接调用（app.ts 端点）均可；无 projectRoot 时
// 缺省 cwd（与 multi-project-router 口径一致）。

import { existsSync } from 'node:fs';
import { createKnowledgeStore, type KnowledgeMetricEvent } from './knowledge-db.js';
import { getKnowledgeDbPath } from '../project/multi-project-router.js';

export interface KnowledgeMetricInput {
  projectRoot?: string;
  event: KnowledgeMetricEvent;
  agentId: string;
  sessionId?: string | null;
  detail?: string | null;
}

/**
 * 记录一条行为观测计数（轻量：开库→写→关库；失败降级 warn 不抛）。
 */
export function recordKnowledgeMetric(input: KnowledgeMetricInput): void {
  try {
    const store = createKnowledgeStore(getKnowledgeDbPath(input.projectRoot), {
      projectRoot: input.projectRoot,
    });
    try {
      store.recordMetric({
        event: input.event,
        agentId: input.agentId,
        sessionId: input.sessionId ?? null,
        detail: input.detail ?? null,
        createdAt: new Date().toISOString(),
      });
    } finally {
      store.close();
    }
  } catch (err) {
    console.warn(
      `[knowledge-metrics] record failed (${input.event}/${input.agentId}):`,
      (err as Error).message,
    );
  }
}

export interface KnowledgeMetricSnapshot {
  /** 分子：行为观测计数（按 event 分组）。 */
  counts: Array<{ event: KnowledgeMetricEvent; count: number }>;
  /** 分母：注入消费记录数（knowledge_consumption 行数）。 */
  consumptionTotal: number;
  /** 分母：知识文档数（knowledge_documents 行数）。 */
  documentsTotal: number;
  /**
   * 会话覆盖素材（knowledge.db 面口径）：
   * withSession = 带 session_id 的消费行数；distinctSessions = 去重会话数；
   * total = 消费行总数。全局会话覆盖率的分母（sessions.db 总会话数）
   * 由验证层跨库聚合（本快照不跨库，保持轻量）。
   */
  sessionStats: { total: number; withSession: number; distinctSessions: number };
}

/**
 * 聚合指标快照（验证端点 / 小柯独立验证数据源）。
 * 库不存在 → 全零快照（指标面未启用）。
 */
export function getKnowledgeMetricSnapshot(projectRoot?: string): KnowledgeMetricSnapshot {
  const empty: KnowledgeMetricSnapshot = {
    counts: [],
    consumptionTotal: 0,
    documentsTotal: 0,
    sessionStats: { total: 0, withSession: 0, distinctSessions: 0 },
  };
  const dbPath = getKnowledgeDbPath(projectRoot);
  if (!existsSync(dbPath)) return empty;

  try {
    const store = createKnowledgeStore(dbPath, { projectRoot });
    try {
      return {
        counts: store.getMetricCounts(),
        consumptionTotal: store.countConsumptions(),
        documentsTotal: store.countDocuments(),
        sessionStats: store.getConsumptionSessionStats(),
      };
    } finally {
      store.close();
    }
  } catch (err) {
    console.warn('[knowledge-metrics] snapshot failed:', (err as Error).message);
    return empty;
  }
}

/**
 * tool_blocked reason 是否属于越权类（escalation_blocked 计入条件）。
 * 权限引擎/合同边界拒绝计入；执行异常、用户交互拒绝（ask→deny）、
 * 重复失败等非越权语义不计。
 */
export function isEscalationBlockReason(reason: string): boolean {
  const lower = reason.toLowerCase();
  if (/permission engine|not allowed|denied|forbidden|not in allowlist|not permitted/.test(lower)) {
    // 排除用户交互拒绝（"User denied permission"）——非越权，是用户决策
    if (lower.startsWith('user denied')) return false;
    return true;
  }
  return false;
}
