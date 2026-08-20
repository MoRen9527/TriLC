// ── Knowledge Consumption Injection ──
// FADE-ASSESS-003 消费路径（boot injection 非检索）：把 knowledge.db 中该员工
// 最新三层知识组装为 <knowledge-context> 注入块，追加到 system prompt 之后，
// 并按层写 knowledge_consumption 消费记录。
//
// 注入层不污染身份真源：contract-resolver.getSystemPrompt 保持 soul+agent_body
// 不变，注入只发生在消费挂接点（session-initializer / system-prompt 端点 /
// heartbeat 会话）。
//
// 降级语义：知识库不存在、无该员工知识或注入异常 → 原 prompt 原样返回，
// injected=false，不阻断会话（消费路径失败不致命）。

import { existsSync } from 'node:fs';
import {
  createKnowledgeStore,
  type InjectionMode,
  type KnowledgeLayer,
} from './knowledge-db.js';
import { getKnowledgeDbPath } from '../project/multi-project-router.js';

/** 层显示名（注入块内固定顺序 Memory → Colleagues → Social）。 */
const LAYER_LABELS: Record<KnowledgeLayer, string> = {
  memory: 'Memory',
  colleagues: 'Colleagues',
  social: 'Social',
};

export function knowledgeContextTag(namespace: string): string {
  return `<knowledge-context namespace="${namespace}">`;
}

/**
 * 组装注入块（纯函数，可单测）：
 *
 *   <knowledge-context namespace="employee/<id>">
 *   ## Memory
 *   <memory 内容>
 *
 *   ## Colleagues
 *   <colleagues 内容>
 *
 *   ## Social
 *   <social 内容>
 *   </knowledge-context>
 *
 * @param layers 按 Memory → Colleagues → Social 顺序（调用方保证；本函数不重排）。
 */
export function buildKnowledgeContextBlock(
  namespace: string,
  layers: Array<{ layer: KnowledgeLayer; content: string }>,
): string {
  if (layers.length === 0) return '';
  const body = layers
    .map(({ layer, content }) => `## ${LAYER_LABELS[layer]}\n\n${content.trim()}`)
    .join('\n\n');
  return `${knowledgeContextTag(namespace)}\n${body}\n</knowledge-context>`;
}

export interface KnowledgeInjectionResult {
  /** 注入后的完整 prompt（无知识/失败时原样返回）。 */
  prompt: string;
  /** 是否追加了知识注入块。 */
  injected: boolean;
  /** 实际注入的层（Memory → Colleagues → Social 顺序）。 */
  layers: KnowledgeLayer[];
  /** 写入 knowledge_consumption 的行数（每文档一行）。 */
  consumed: number;
  namespace: string;
}

/**
 * 把员工知识注入到 system prompt（boot injection 非检索）。
 *
 * @param opts.projectRoot 知识库归属项目根；缺省 = process.cwd()（与 router 口径一致）。
 * @param opts.sessionId   会话 id；prompt 组装先于会话创建时为 undefined（消费记录 session_id=null）。
 * @param opts.injectionMode 默认 'boot'；'reload' 预留给 watch 热重载补注入。
 */
export function injectKnowledgeContext(opts: {
  projectRoot?: string;
  agentId: string;
  systemPrompt: string;
  sessionId?: string;
  injectionMode?: InjectionMode;
}): KnowledgeInjectionResult {
  const { projectRoot, agentId, systemPrompt, sessionId, injectionMode = 'boot' } = opts;
  const namespace = `employee/${agentId}` as const;
  const noop: KnowledgeInjectionResult = {
    prompt: systemPrompt,
    injected: false,
    layers: [],
    consumed: 0,
    namespace,
  };

  const dbPath = getKnowledgeDbPath(projectRoot);
  if (!existsSync(dbPath)) {
    return noop; // 知识库未同步过 → 无知识可注入
  }

  let store: ReturnType<typeof createKnowledgeStore> | null = null;
  try {
    store = createKnowledgeStore(dbPath, { projectRoot });
    const docs = store.listLatestDocuments(namespace, agentId);
    if (docs.length === 0) {
      return noop;
    }

    const block = buildKnowledgeContextBlock(
      namespace,
      docs.map((doc) => ({ layer: doc.layer, content: doc.content })),
    );
    const prompt = systemPrompt
      ? `${systemPrompt}\n\n${block}`
      : block;

    // 每次注入每文档写一行消费记录（审计面；同 hash 重复消费也留痕）
    const consumedAt = new Date().toISOString();
    for (const doc of docs) {
      store.recordConsumption({
        namespace,
        agentId,
        contentHash: doc.contentHash,
        sessionId: sessionId ?? null,
        injectionMode,
        consumedAt,
      });
    }

    return {
      prompt,
      injected: true,
      layers: docs.map((doc) => doc.layer),
      consumed: docs.length,
      namespace,
    };
  } catch (err) {
    // 消费路径失败不致命：降级原 prompt，仅留告警
    console.warn(`[knowledge-injector] injection failed for ${agentId}:`, (err as Error).message);
    return noop;
  } finally {
    store?.close();
  }
}
