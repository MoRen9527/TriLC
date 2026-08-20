// ── Knowledge Source Sync ──
// FADE-ASSESS-003：source-agents/<id> 五件套三层契约（memory/colleagues/social）
// → knowledge.db 全量/增量同步。
//
// 命名空间映射：employee/<id> ← source-agents/<id>（五件套三层契约）。
// org/shared MVP 无内容源（预留）；org/audit 不注入（不参与同步）。
//
// 安全门：
//   - 源只读 — 仅 readFileSync / statSync，永不写 source-agents。
//   - dry-run — 不创建/不写 knowledge.db，只报告扫描面。
//
// 幂等：content_hash（SHA-256）唯一键，hash 相同跳过；hash 变更按源文件重写。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import {
  createKnowledgeStore,
  KNOWLEDGE_LAYERS,
  type KnowledgeDocument,
  type KnowledgeLayer,
} from './knowledge-db.js';
import { getKnowledgeDbPath } from '../project/multi-project-router.js';

/** 三层源文件后缀（watch 增量监听同一组）。 */
export const KNOWLEDGE_LAYER_FILE_SUFFIXES: readonly string[] = KNOWLEDGE_LAYERS.map(
  (layer) => `.${layer}.md`,
);

export interface KnowledgeSyncReport {
  /** 扫描到的源文件数。 */
  scanned: number;
  /** 实际写入文档数（dry-run 恒 0）。 */
  inserted: number;
  /** hash 相同跳过数（幂等重入）。 */
  skipped: number;
  /** 源文件清空/删除而移除的既有行数（防陈旧知识注入）。 */
  removed: number;
  /** dry-run 模式下的预估写入数（= scanned，不查库的保守口径）。 */
  wouldInsert: number;
  dryRun: boolean;
  /** 单文件读取失败列表（不阻断整体同步）。 */
  errors: string[];
}

/**
 * 全量/增量同步 source-agents 三层知识文件到 knowledge.db。
 *
 * @param sourceRoot  TriCompany/source-agents 根（与 contract-resolver 同一输入）。
 * @param projectRoot knowledge.db 归属项目根（{projectRoot}/.tricompany-cognition/）。
 * @param dryRun      true 时不写库（不创建 DB 文件）。
 * @param agentFilter 增量模式：只同步指定 agent（watch 变更按目录名过滤）。
 */
export function syncKnowledgeFromSource(opts: {
  sourceRoot: string;
  projectRoot?: string;
  dryRun?: boolean;
  agentFilter?: string[];
}): KnowledgeSyncReport {
  const { sourceRoot, projectRoot, dryRun = false } = opts;
  const agentFilter = opts.agentFilter ? new Set(opts.agentFilter) : null;
  const report: KnowledgeSyncReport = {
    scanned: 0,
    inserted: 0,
    skipped: 0,
    removed: 0,
    wouldInsert: 0,
    dryRun,
    errors: [],
  };

  const root = resolve(sourceRoot);
  if (!existsSync(root)) {
    report.errors.push(`source root not found: ${root}`);
    return report;
  }

  let store: ReturnType<typeof createKnowledgeStore> | null = null;
  if (!dryRun) {
    store = createKnowledgeStore(getKnowledgeDbPath(projectRoot), { projectRoot });
  }
  const syncedAt = new Date().toISOString();

  try {
    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const agentId = entry.name;
      if (agentFilter && !agentFilter.has(agentId)) continue;

      for (const layer of KNOWLEDGE_LAYERS) {
        const filePath = join(root, agentId, `${agentId}.${layer}.md`);
        if (!existsSync(filePath)) continue;

        report.scanned++;
        let content: string;
        let sourceMtime: string;
        try {
          content = readFileSync(filePath, 'utf-8');
          sourceMtime = statSync(filePath).mtime.toISOString();
        } catch (err) {
          report.errors.push(`${filePath}: ${(err as Error).message}`);
          continue;
        }
        // 空文件：不落库；既有行按 source_path 移除（防陈旧知识注入；幂等，无行可删无害）
        if (!content.trim()) {
          if (!dryRun) {
            const removed = store!.removeDocumentBySource(
              `employee/${agentId}`,
              layer,
              agentId,
              filePath,
            );
            report.removed += removed;
          }
          continue;
        }

        const doc: KnowledgeDocument = {
          namespace: `employee/${agentId}`,
          layer,
          agentId,
          sourcePath: filePath,
          content,
          contentHash: createHash('sha256').update(content).digest('hex'),
          sourceMtime,
          syncedAt,
        };

        if (dryRun) {
          report.wouldInsert++;
          continue;
        }

        const result = store!.upsertDocument(doc);
        if (result.status === 'inserted') {
          report.inserted++;
        } else {
          report.skipped++;
        }
      }
    }
  } finally {
    store?.close();
  }

  return report;
}
