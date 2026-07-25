// ── AgentEvent → Anthropic SSE stream converter ──
// Converts agentLoop's AgentEvent stream to Anthropic Messages API SSE format.
// The agentLoop handles the full tool-execution loop internally, so the
// /v1/messages endpoint streams the complete interaction as a single response.
//
// Anthropic SSE event types:
//   message_start, content_block_start, content_block_delta,
//   content_block_stop, message_delta, message_stop, ping, error

import type { AgentEvent } from '@trimetaverse/agent-core';

export interface AnthropicSSEOptions {
  model: string;
  onSSE: (eventType: string, data: object) => void;
}

interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  index: number;
  // text block
  text?: string;
  // tool_use block
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // tool_result block
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

interface StreamState {
  messageId: string;
  model: string;
  blockIndex: number;
  currentTextBlock: number | null; // index of current text block, null if none open
  blocks: ContentBlock[];
  started: boolean;
  finished: boolean;
  inputTokens: number;
  outputTokens: number;
  // Track tool_use JSON accumulation
  activeToolUseIndex: number | null;
  activeToolUseId: string | null;
  activeToolUseName: string | null;
  activeToolUseJson: string;
  // Dedup guard: agentLoop emits both content_delta (incremental) and
  // assistant_message (full aggregate) for the same text. We must forward
  // only one to avoid duplicate text on the client.
  textBlockHasDelta: boolean;
  // Dedup guard: agentLoop emits BOTH assistant_message.tool_calls (aggregate)
  // AND tool_call (per-call) for the same tool_use id each turn. Open the
  // tool_use block only once per id.
  processedToolUseIds: Set<string>;
}

function createStreamState(model: string): StreamState {
  return {
    messageId: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    model,
    blockIndex: 0,
    currentTextBlock: null,
    blocks: [],
    started: false,
    finished: false,
    inputTokens: 0,
    outputTokens: 0,
    activeToolUseIndex: null,
    activeToolUseId: null,
    activeToolUseName: null,
    activeToolUseJson: '',
    textBlockHasDelta: false,
    processedToolUseIds: new Set(),
  };
}

function ensureStarted(s: StreamState, emit: (eventType: string, data: object) => void): void {
  if (s.started) return;
  s.started = true;
  emit('message_start', {
    type: 'message_start',
    message: {
      id: s.messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: s.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: s.inputTokens, output_tokens: 0 },
    },
  });
}

function startTextBlock(s: StreamState, emit: (eventType: string, data: object) => void): void {
  if (s.currentTextBlock !== null) return; // already open
  const idx = s.blockIndex++;
  s.currentTextBlock = idx;
  const block: ContentBlock = { type: 'text', index: idx, text: '' };
  s.blocks.push(block);
  emit('content_block_start', {
    type: 'content_block_start',
    index: idx,
    content_block: { type: 'text', text: '' },
  });
}

function closeTextBlock(s: StreamState, emit: (eventType: string, data: object) => void): void {
  if (s.currentTextBlock === null) return;
  const idx = s.currentTextBlock;
  s.currentTextBlock = null;
  emit('content_block_stop', {
    type: 'content_block_stop',
    index: idx,
  });
}

function openToolUseBlock(
  s: StreamState,
  toolId: string,
  toolName: string,
  emit: (eventType: string, data: object) => void,
): void {
  // Close any open text block first
  closeTextBlock(s, emit);

  const idx = s.blockIndex++;
  s.activeToolUseIndex = idx;
  s.activeToolUseId = toolId;
  s.activeToolUseName = toolName;
  s.activeToolUseJson = '';

  const block: ContentBlock = { type: 'tool_use', index: idx, id: toolId, name: toolName, input: {} };
  s.blocks.push(block);

  emit('content_block_start', {
    type: 'content_block_start',
    index: idx,
    content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
  });
}

function appendToolUseJson(
  s: StreamState,
  jsonDelta: string,
  emit: (eventType: string, data: object) => void,
): void {
  if (s.activeToolUseIndex === null) return;
  s.activeToolUseJson += jsonDelta;
  emit('content_block_delta', {
    type: 'content_block_delta',
    index: s.activeToolUseIndex,
    delta: { type: 'input_json_delta', partial_json: jsonDelta },
  });
}

function closeToolUseBlock(s: StreamState, emit: (eventType: string, data: object) => void): void {
  if (s.activeToolUseIndex === null) return;
  const idx = s.activeToolUseIndex;
  const block = s.blocks[idx];
  if (block && s.activeToolUseJson) {
    try {
      block.input = JSON.parse(s.activeToolUseJson);
    } catch {
      block.input = { _raw: s.activeToolUseJson };
    }
  }
  s.activeToolUseIndex = null;
  s.activeToolUseId = null;
  s.activeToolUseName = null;
  s.activeToolUseJson = '';

  emit('content_block_stop', {
    type: 'content_block_stop',
    index: idx,
  });
}

function emitToolResult(
  s: StreamState,
  toolCallId: string,
  content: string,
  isError: boolean,
  emit: (eventType: string, data: object) => void,
): void {
  closeTextBlock(s, emit);
  closeToolUseBlock(s, emit);

  const idx = s.blockIndex++;
  const block: ContentBlock = {
    type: 'tool_result',
    index: idx,
    tool_use_id: toolCallId,
    content,
    is_error: isError,
  };
  s.blocks.push(block);

  emit('content_block_start', {
    type: 'content_block_start',
    index: idx,
    content_block: { type: 'tool_result', tool_use_id: toolCallId, content: [], is_error: isError },
  });

  // Stream tool result content as delta
  emit('content_block_delta', {
    type: 'content_block_delta',
    index: idx,
    delta: { type: 'text_delta', text: content },
  });

  emit('content_block_stop', {
    type: 'content_block_stop',
    index: idx,
  });
}

function finishStream(
  s: StreamState,
  stopReason: string,
  emit: (eventType: string, data: object) => void,
): void {
  if (s.finished) return;
  // Close any open blocks
  closeTextBlock(s, emit);
  closeToolUseBlock(s, emit);

  s.finished = true;
  emit('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { input_tokens: s.inputTokens, output_tokens: s.outputTokens },
  });
  emit('message_stop', { type: 'message_stop' });
}

/**
 * Convert an AgentEvent async generator to Anthropic SSE format.
 * Calls opts.onSSE(eventType, data) for each Anthropic SSE event.
 */
export async function agentEventsToAnthropicSSE(
  events: AsyncGenerator<AgentEvent>,
  opts: AnthropicSSEOptions,
): Promise<void> {
  const s = createStreamState(opts.model);
  const emit = opts.onSSE;

  try {
    for await (const event of events) {
      switch (event.type) {
        case 'loop_start': {
          s.inputTokens = 0;
          s.outputTokens = 0;
          break;
        }

        case 'request_start': {
          // Internal event, no Anthropic equivalent
          // Per-turn reset of the delta flag, so multi-turn streams do not
          // inherit the previous turn's "we already streamed deltas" state.
          s.textBlockHasDelta = false;
          s.processedToolUseIds.clear();
          break;
        }

        case 'content_delta': {
          ensureStarted(s, emit);
          startTextBlock(s, emit);
          emit('content_block_delta', {
            type: 'content_block_delta',
            index: s.currentTextBlock!,
            delta: { type: 'text_delta', text: event.delta },
          });
          s.outputTokens += estimateTokens(event.delta);
          s.textBlockHasDelta = true;
          if (s.currentTextBlock !== null) {
            const block = s.blocks[s.currentTextBlock];
            if (block) block.text = (block.text ?? '') + event.delta;
          }
          break;
        }

        case 'assistant_message': {
          ensureStarted(s, emit);

          // Emit text content if present AND no incremental delta has been
          // forwarded for this turn. When content_delta already streamed the
          // text, assistant_message.content is an aggregate duplicate — skip
          // it. Falls through to tool_calls handling below regardless.
          if (event.content && !s.textBlockHasDelta) {
            startTextBlock(s, emit);
            emit('content_block_delta', {
              type: 'content_block_delta',
              index: s.currentTextBlock!,
              delta: { type: 'text_delta', text: event.content },
            });
            s.outputTokens += estimateTokens(event.content);
            if (s.currentTextBlock !== null) {
              const block = s.blocks[s.currentTextBlock];
              if (block) block.text = (block.text ?? '') + event.content;
            }
            closeTextBlock(s, emit);
          }

          // Emit tool_calls as tool_use blocks
          if (event.tool_calls && event.tool_calls.length > 0) {
            for (const tc of event.tool_calls) {
              if (tc.id && s.processedToolUseIds.has(tc.id)) continue;
              if (tc.id) s.processedToolUseIds.add(tc.id);
              openToolUseBlock(s, tc.id, tc.function.name, emit);
              appendToolUseJson(s, tc.function.arguments, emit);
              s.outputTokens += estimateTokens(tc.function.arguments);
              closeToolUseBlock(s, emit);
            }
          }
          break;
        }

        case 'tool_call': {
          ensureStarted(s, emit);
          if (s.processedToolUseIds.has(event.id)) break;
          s.processedToolUseIds.add(event.id);
          openToolUseBlock(s, event.id, event.name, emit);
          appendToolUseJson(s, event.arguments, emit);
          s.outputTokens += estimateTokens(event.arguments);
          closeToolUseBlock(s, emit);
          break;
        }

        case 'tool_result': {
          ensureStarted(s, emit);
          emitToolResult(s, event.tool_call_id, event.content, event.is_error ?? false, emit);
          break;
        }

        case 'tool_blocked': {
          ensureStarted(s, emit);
          emitToolResult(
            s,
            `blocked_${event.tool_name}`,
            `Tool "${event.tool_name}" blocked: ${event.reason}`,
            true,
            emit,
          );
          break;
        }

        case 'loop_end': {
          ensureStarted(s, emit);
          if (event.usageSummary) {
            s.inputTokens = event.usageSummary.tokens.prompt_tokens ?? 0;
            s.outputTokens = event.usageSummary.tokens.completion_tokens ?? 0;
          }
          const stopReason = mapStopReason(event.reason, event.finish_reason);
          finishStream(s, stopReason, emit);
          return;
        }

        case 'error': {
          ensureStarted(s, emit);
          emit('error', { type: 'error', error: { type: 'api_error', message: event.message } });
          finishStream(s, 'error', emit);
          return;
        }

        case 'cache_metrics':
        case 'recovery': {
          // Internal events, skip
          break;
        }

        default:
          break;
      }
    }

    // If generator ended without loop_end, finalize
    if (!s.finished) {
      ensureStarted(s, emit);
      finishStream(s, 'end_turn', emit);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!s.started) ensureStarted(s, emit);
    emit('error', { type: 'error', error: { type: 'api_error', message: msg } });
    if (!s.finished) finishStream(s, 'error', emit);
  }
}

function mapStopReason(reason: string, finishReason?: string): string {
  if (reason === 'done' || reason === 'tool_calls_finish') return 'end_turn';
  if (reason === 'max_turns') return 'max_tokens';
  if (reason === 'aborted') return 'end_turn';
  if (reason === 'error') return 'error';
  if (finishReason === 'stop') return 'end_turn';
  if (finishReason === 'tool_calls') return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  return 'end_turn';
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token for English/Chinese mixed text
  return Math.ceil(text.length / 4);
}

/**
 * Generate a single SSE line string.
 */
export function formatSSELine(eventType: string, data: object): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}
