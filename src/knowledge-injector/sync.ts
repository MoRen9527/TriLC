// ── Knowledge Source Sync ──
// FADE-ASSESS-003：source-agents/<id> 五件套三层契约（memory/colleagues/social）
// → knowledge.db 全量/增量同步。
// 批次 3-2（内容层接入，CPO 小乔定案 2026-08-20）：+ 内容层注入面——
//   wiki 消费记录（主）：TriCompany-copilot-host-assets/knowledge/employees/<id>/wiki/*.md
//   inbox（辅）       ：同根 inbox/*.json 单据（过滤 + 字段裁剪，见 parseInboxRecord）
//   audit 写回显式排除（kernel 写回面非注入面）；org/shared 只预留路径不接入。
//
// 命名空间映射：employee/<id> ← source-agents/<id>（契约层）/ 内容资产 employees/<id>（内容层）。
// org/shared MVP 无内容源（预留）；org/audit 不注入（不参与同步）。
//
// 安全门：
//   - 源只读 — 仅 readFileSync / statSync，永不写 source-agents / 内容资产目录。
//   - dry-run — 不创建/不写 knowledge.db，只报告扫描面。
//
// 幂等：content_hash（SHA-256）唯一键，hash 相同跳过；hash 变更按源文件重写。
//   wiki 页 md 形态复用 hash/upsert/幂等链路；inbox 单据按裁剪后序列化 hash。

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

/** 三层源文件后缀（watch 增量监听同一组；wiki/inbox 由内容层目录扫描承载）。 */
export const KNOWLEDGE_LAYER_FILE_SUFFIXES: readonly string[] = KNOWLEDGE_LAYERS.map(
  (layer) => `.${layer}.md`,
);

// ── 内容层资产（TriCompany-copilot-host-assets）──
// 与 TriCompany/runtime/cognition/chief_of_staff_wiki_paths.py support_root()
// 候选逻辑对齐：workspace 根下 TriCompany-copilot-host-assets（或
// TriMetaverse/TriCompany-copilot-host-assets），再下 knowledge/employees/<id>/。

/** 内容资产根目录名（ChiefOfStaff 运行资产支撑目录）。 */
export const CONTENT_SUPPORT_ROOT_NAME = 'TriCompany-copilot-host-assets';

/** 内容资产员工知识根下的子目录：wiki（注入）/ inbox（注入）/ audit（不注入）。 */
const CONTENT_LAYER_DIRS = ['wiki', 'inbox'] as const;

/**
 * 从契约源根推导内容资产根（sourceRoot 为 TriCompany/source-agents 或
 * TriCompany 仓根时均覆盖）。候选顺序：
 *   1. <sourceRoot>/TriCompany-copilot-host-assets          （sourceRoot 即 workspace 根）
 *   2. <sourceRoot>/../TriCompany-copilot-host-assets       （sourceRoot 同级）
 *   3. <sourceRoot>/../TriMetaverse/TriCompany-copilot-host-assets
 *                                                           （sourceRoot = TriCompany 仓根）
 *   4. <sourceRoot>/../../TriMetaverse/TriCompany-copilot-host-assets
 *                                                           （sourceRoot = TriCompany/source-agents，生产形态）
 * 全无 → null（内容层未部署 → 不扫描，不阻断契约层）。
 */
export function resolveContentRoot(sourceRoot: string): string | null {
  const root = resolve(sourceRoot);
  const candidates = [
    join(root, CONTENT_SUPPORT_ROOT_NAME),
    join(root, '..', CONTENT_SUPPORT_ROOT_NAME),
    join(root, '..', 'TriMetaverse', CONTENT_SUPPORT_ROOT_NAME),
    join(root, '..', '..', 'TriMetaverse', CONTENT_SUPPORT_ROOT_NAME),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  return null;
}

// ── inbox 单据契约（CPO 小乔定案：JSON 单据，过滤 + 字段裁剪）──

/** 裁剪白名单字段（注入内容只保留这些元数据字段）。 */
export const INBOX_RECORD_FIELDS = [
  'summary',
  'objectType',
  'sender',
  'priority',
  'createdAt',
  'routingPackagePath',
  'linkedNextAction',
] as const;

/** 运行态字段（一律剥离，不注入）：状态/关闭时间/读取态/解决态。 */
const INBOX_RUNTIME_FIELDS: ReadonlySet<string> = new Set([
  'status',
  'closedAt',
  'updatedAt',
  'unread',
  'resolution',
]);

/** 旧形态单据的源字段（已映射进裁剪字段，不注入；防冗余副本）。 */
const INBOX_MAPPED_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'sourceType',
  'capturedAt',
]);

/** inbox closed 单据近 N 天窗口（默认 7 天；超期 closed 不注入）。 */
export const INBOX_CLOSED_WINDOW_DAYS = 7;

export interface InboxRecord {
  /** 摘要（单据 title 兜底；仍无 → null）。 */
  summary: string | null;
  /** 对象类型（旧形态 sourceType 兜底）。 */
  objectType: string;
  sender: string | null;
  /** 优先级（缺省 'normal'）。 */
  priority: string;
  /** 创建时间（旧形态 capturedAt 兜底；仍无 → 源文件 mtime）。 */
  createdAt: string;
  routingPackagePath: string | null;
  linkedNextAction: string | null;
  /** 状态：显式 'closed' 才按 closed 处理，其余视为 open（含缺省/未知态，兼容现存单据）。 */
  status: 'open' | 'closed';
  /** closed 单据的关闭时间（近 N 天判定用；无 → 视为陈旧）。 */
  closedAt: string | null;
  /** 知识正文：剔除裁剪字段/运行态/已映射字段后的剩余字段（facts 等知识内容保留）。 */
  body: Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * 解析 inbox JSON 单据 → 产品字段归一化（兼容现存 facts.json 旧形态：
 * sourceId/title/sourceType/topicHints/trustLevel/capturedAt/facts）。
 * 不可解析的 JSON → 返回 null（不注入，report.errors 记一条）。
 */
export function parseInboxRecord(raw: string, fallbackCreatedAt: string): InboxRecord | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const record = obj as Record<string, unknown>;

  const status = record.status === 'closed' ? 'closed' : 'open';
  const createdAt = asString(record.createdAt) ?? asString(record.capturedAt) ?? fallbackCreatedAt;
  const closedAt = asString(record.closedAt) ?? asString(record.updatedAt);

  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if ((INBOX_RECORD_FIELDS as readonly string[]).includes(key)) continue;
    if (INBOX_RUNTIME_FIELDS.has(key)) continue;
    if (INBOX_MAPPED_FIELDS.has(key)) continue;
    body[key] = value;
  }

  return {
    summary: asString(record.summary) ?? asString(record.title),
    objectType: asString(record.objectType) ?? asString(record.sourceType) ?? 'record',
    sender: asString(record.sender),
    priority: asString(record.priority) ?? 'normal',
    createdAt,
    routingPackagePath: asString(record.routingPackagePath),
    linkedNextAction: asString(record.linkedNextAction),
    status,
    closedAt,
    body,
  };
}

/**
 * inbox 过滤判定（产品语义）：仅注入 open 或近 N 天 closed 的单据；
 * 陈旧 closed（超窗口/无关闭时间）过滤。窗口天数可配置（测试注入）。
 */
export function shouldInjectInboxRecord(
  record: InboxRecord,
  nowMs: number,
  closedWindowDays = INBOX_CLOSED_WINDOW_DAYS,
): boolean {
  if (record.status === 'open') return true;
  if (!record.closedAt) return false;
  const closedMs = Date.parse(record.closedAt);
  if (!Number.isFinite(closedMs)) return false;
  return nowMs - closedMs <= closedWindowDays * 24 * 60 * 60 * 1000;
}

/** 裁剪后注入内容（稳定字段序 → content_hash 幂等）：7 元数据字段 + 知识正文。 */
export function serializeInboxContent(record: InboxRecord): string {
  const payload: Record<string, unknown> = {
    summary: record.summary,
    objectType: record.objectType,
    sender: record.sender,
    priority: record.priority,
    createdAt: record.createdAt,
    routingPackagePath: record.routingPackagePath,
    linkedNextAction: record.linkedNextAction,
    body: record.body,
  };
  return JSON.stringify(payload, null, 2);
}

export interface KnowledgeSyncReport {
  /** 扫描到的源文件数（契约层 + 内容层）。 */
  scanned: number;
  /** 实际写入文档数（dry-run 恒 0）。 */
  inserted: number;
  /** hash 相同跳过数（幂等重入）。 */
  skipped: number;
  /** 源文件清空/删除而移除的既有行数（防陈旧知识注入）。 */
  removed: number;
  /** 内容层 inbox 过滤掉的单据数（陈旧 closed / 不可解析不计入 scanned）。 */
  filtered: number;
  /** dry-run 模式下的预估写入数（= scanned，不查库的保守口径）。 */
  wouldInsert: number;
  dryRun: boolean;
  /** 内容资产根（未部署 → null；契约层仍同步）。 */
  contentRoot: string | null;
  /** 单文件读取失败/单据解析失败列表（不阻断整体同步）。 */
  errors: string[];
}

/** 内容层排除文件：README 说明与 *-template 模板不注入（非知识页面）。 */
function isContentSkippedFile(fileName: string): boolean {
  return fileName === 'README.md' || /-template(\.md|\.json)?$/.test(fileName);
}

/** 注入一个文档（共用计数/幂等/空文件语义）。 */
function upsertSourceDoc(
  store: ReturnType<typeof createKnowledgeStore> | null,
  doc: KnowledgeDocument,
  dryRun: boolean,
  report: KnowledgeSyncReport,
): void {
  if (dryRun) {
    report.wouldInsert++;
    return;
  }
  const result = store!.upsertDocument(doc);
  if (result.status === 'inserted') {
    report.inserted++;
  } else {
    report.skipped++;
  }
}

/**
 * 全量/增量同步知识源到 knowledge.db：
 *   契约层 — source-agents/<id>/*.{memory,colleagues,social}.md
 *   内容层 — 内容资产 knowledge/employees/<id>/{wiki,inbox}/（wiki md + inbox JSON 单据）
 *
 * @param sourceRoot  TriCompany/source-agents 根（与 contract-resolver 同一输入）。
 * @param projectRoot knowledge.db 归属项目根（{projectRoot}/.tricompany-cognition/）。
 * @param dryRun      true 时不写库（不创建 DB 文件）。
 * @param agentFilter 增量模式：只同步指定 agent（watch 变更按目录名过滤；契约层与内容层同过滤）。
 * @param contentRoot 内容资产根；缺省按 resolveContentRoot(sourceRoot) 推导。
 * @param inboxClosedWindowDays inbox closed 单据近 N 天窗口（缺省 7 天）。
 * @param nowMs       当前时间源（测试注入；缺省 Date.now()）。
 */
export function syncKnowledgeFromSource(opts: {
  sourceRoot: string;
  projectRoot?: string;
  dryRun?: boolean;
  agentFilter?: string[];
  contentRoot?: string;
  inboxClosedWindowDays?: number;
  nowMs?: number;
}): KnowledgeSyncReport {
  const {
    sourceRoot,
    projectRoot,
    dryRun = false,
    contentRoot: contentRootOpt,
    inboxClosedWindowDays = INBOX_CLOSED_WINDOW_DAYS,
  } = opts;
  const agentFilter = opts.agentFilter ? new Set(opts.agentFilter) : null;
  const nowMs = opts.nowMs ?? Date.now();
  const contentRoot = contentRootOpt ? resolve(contentRootOpt) : resolveContentRoot(sourceRoot);
  const report: KnowledgeSyncReport = {
    scanned: 0,
    inserted: 0,
    skipped: 0,
    removed: 0,
    filtered: 0,
    wouldInsert: 0,
    dryRun,
    contentRoot,
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
    // ── 契约层：source-agents/<id>/*.{memory,colleagues,social}.md ──
    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const agentId = entry.name;
      if (agentFilter && !agentFilter.has(agentId)) continue;

      for (const layer of KNOWLEDGE_LAYERS.slice(0, 3)) {
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

        upsertSourceDoc(
          store,
          {
            namespace: `employee/${agentId}`,
            layer,
            agentId,
            sourcePath: filePath,
            content,
            contentHash: createHash('sha256').update(content).digest('hex'),
            sourceMtime,
            syncedAt,
          },
          dryRun,
          report,
        );
      }
    }

    // ── 内容层：TriCompany-copilot-host-assets/knowledge/employees/<id>/{wiki,inbox}/ ──
    // audit 写回显式排除（kernel 写回面非注入面）；org/shared 只预留路径不接入。
    if (!contentRoot || !existsSync(contentRoot)) {
      return report;
    }
    const employeesRoot = join(contentRoot, 'knowledge', 'employees');
    if (!existsSync(employeesRoot)) {
      return report;
    }
    for (const entry of readdirSync(employeesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const agentId = entry.name;
      if (agentFilter && !agentFilter.has(agentId)) continue;

      for (const layer of CONTENT_LAYER_DIRS) {
        const layerDir = join(employeesRoot, agentId, layer);
        if (!existsSync(layerDir)) continue;

        const files = readdirSync(layerDir).filter((name) => !isContentSkippedFile(name));
        for (const fileName of files) {
          const filePath = join(layerDir, fileName);

          if (layer === 'wiki') {
            // wiki 消费记录页：md 形态，全文注入（frontmatter + 正文原样保留）
            if (!fileName.endsWith('.md')) continue;
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
            if (!content.trim()) {
              if (!dryRun) {
                const removed = store!.removeDocumentBySource(
                  `employee/${agentId}`,
                  'wiki',
                  agentId,
                  filePath,
                );
                report.removed += removed;
              }
              continue;
            }
            upsertSourceDoc(
              store,
              {
                namespace: `employee/${agentId}`,
                layer: 'wiki',
                agentId,
                sourcePath: filePath,
                content,
                contentHash: createHash('sha256').update(content).digest('hex'),
                sourceMtime,
                syncedAt,
              },
              dryRun,
              report,
            );
            continue;
          }

          // inbox：JSON 单据（产品语义：首批只注入 JSON 单据；md 笔记与模板
          // 暂不接入，见技术债务标记）
          if (!fileName.endsWith('.json')) continue;
          report.scanned++;
          let raw: string;
          let sourceMtime: string;
          try {
            raw = readFileSync(filePath, 'utf-8');
            sourceMtime = statSync(filePath).mtime.toISOString();
          } catch (err) {
            report.errors.push(`${filePath}: ${(err as Error).message}`);
            continue;
          }
          const record = parseInboxRecord(raw, sourceMtime);
          if (!record) {
            report.filtered++;
            report.errors.push(`${filePath}: unparseable inbox record (skipped)`);
            continue;
          }
          // 过滤：仅注入 open 或近 N 天 closed；陈旧 closed 移除既有行
          if (!shouldInjectInboxRecord(record, nowMs, inboxClosedWindowDays)) {
            report.filtered++;
            if (!dryRun) {
              const removed = store!.removeDocumentBySource(
                `employee/${agentId}`,
                'inbox',
                agentId,
                filePath,
              );
              report.removed += removed;
            }
            continue;
          }
          const content = serializeInboxContent(record);
          upsertSourceDoc(
            store,
            {
              namespace: `employee/${agentId}`,
              layer: 'inbox',
              agentId,
              sourcePath: filePath,
              content,
              contentHash: createHash('sha256').update(content).digest('hex'),
              sourceMtime,
              syncedAt,
            },
            dryRun,
            report,
          );
        }
      }
    }
  } finally {
    store?.close();
  }

  return report;
}
