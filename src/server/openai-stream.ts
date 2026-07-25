// ── AgentEvent → OpenAI SSE stream converter ──
// Converts agentLoop's AgentEvent stream to OpenAI Chat Completions SSE format.
// Used by the /chat/completions endpoint for opencode / Vercel AI SDK compatibility.
//
// OpenAI SSE format:
//   data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{...}}]}
//   data: [DONE]

import type { AgentEvent } from '@trimetaverse/agent-core';

export interface OpenAISSEOptions {
  model: string;
  onSSE: (data: object) => void;
}

interface StreamState {
  id: string;
  model: string;
  created: number;
  started: boolean;
  finished: boolean;
  hasEmittedRole: boolean;
  inputTokens: number;
  outputTokens: number;
  // Dedup guard: agentLoop emits both content_delta (incremental) and
  // assistant_message (full aggregate) for the same text. Forwarding both
  // produces duplicate text on the client.
  hasTextDelta: boolean;
  // Dedup guard: agentLoop emits BOTH assistant_message.tool_calls (aggregate)
  // AND tool_call (per-call) for the same tool_use id each turn. Emit the
  // tool_calls delta only once per id.
  processedToolUseIds: Set<string>;
}

function createStreamState(model: string): StreamState {
  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    model,
    created: Math.floor(Date.now() / 1000),
    started: false,
    finished: false,
    hasEmittedRole: false,
    inputTokens: 0,
    outputTokens: 0,
    hasTextDelta: false,
    processedToolUseIds: new Set(),
  };
}

function emitDelta(s: StreamState, delta: Record<string, unknown>, finishReason: string | null, emit: (data: object) => void): void {
  s.started = true;
  emit({
    id: s.id,
    object: 'chat.completion.chunk',
    created: s.created,
    model: s.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  });
}

function emitUsage(
  s: StreamState,
  inputTokens: number,
  outputTokens: number,
  emit: (data: object) => void,
): void {
  emit({
    id: s.id,
    object: 'chat.completion.chunk',
    created: s.created,
    model: s.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: null,
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  });
}

function finishStream(
  s: StreamState,
  stopReason: string,
  inputTokens: number,
  outputTokens: number,
  emit: (data: object) => void,
): void {
  if (s.finished) return;
  s.finished = true;
  s.inputTokens = inputTokens;
  s.outputTokens = outputTokens;

  // Final chunk with finish_reason
  emit({
    id: s.id,
    object: 'chat.completion.chunk',
    created: s.created,
    model: s.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: stopReason,
      },
    ],
  });

  // Usage stats chunk
  if (inputTokens > 0 || outputTokens > 0) {
    emit({
      id: s.id,
      object: 'chat.completion.chunk',
      created: s.created,
      model: s.model,
      choices: [{ index: 0, delta: {}, finish_reason: null }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    });
  }
}

function mapStopReason(reason: string, finishReason?: string): string {
  if (reason === 'done' || reason === 'tool_calls_finish') return 'stop';
  if (reason === 'max_turns') return 'length';
  if (reason === 'aborted') return 'stop';
  if (reason === 'error') return 'error';
  if (finishReason === 'stop') return 'stop';
  if (finishReason === 'tool_calls') return 'tool_calls';
  if (finishReason === 'length') return 'length';
  return 'stop';
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Convert an AgentEvent async generator to OpenAI SSE format.
 * Calls opts.onSSE(data) for each OpenAI SSE-compatible JSON object.
 * Does NOT emit the initial role delta — opencode/Vercel AI SDK handles that client-side.
 */
export async function agentEventsToOpenAISSE(
  events: AsyncGenerator<AgentEvent>,
  opts: OpenAISSEOptions,
): Promise<{ inputTokens: number; outputTokens: number }> {
  const s = createStreamState(opts.model);
  const emit = opts.onSSE;

  try {
    for await (const event of events) {
      switch (event.type) {
        case 'loop_start': {
          break;
        }

        case 'request_start': {
          // Per-turn reset of the delta flag, so multi-turn streams do not
          // inherit the previous turn's "we already streamed deltas" state.
          s.hasTextDelta = false;
          s.processedToolUseIds.clear();
          break;
        }

        case 'content_delta': {
          // Emit role on first content (opencode expects it)
          if (!s.hasEmittedRole) {
            s.hasEmittedRole = true;
            emitDelta(s, { role: 'assistant', content: '' }, null, emit);
          }
          s.outputTokens += estimateTokens(event.delta);
          emitDelta(s, { content: event.delta }, null, emit);
          s.hasTextDelta = true;
          break;
        }

        case 'assistant_message': {
          if (!s.hasEmittedRole) {
            s.hasEmittedRole = true;
          }

          // Emit text content only if no incremental delta has been forwarded
          // for this turn. When content_delta already streamed the text,
          // assistant_message.content is an aggregate duplicate — skip it.
          // Tool_calls handling below runs regardless.
          if (event.content && !s.hasTextDelta) {
            emitDelta(s, { role: 'assistant', content: '' }, null, emit);
            s.outputTokens += estimateTokens(event.content);
            emitDelta(s, { content: event.content }, null, emit);
          }

          // Emit tool_calls as OpenAI format tool_calls delta
          if (event.tool_calls && event.tool_calls.length > 0) {
            for (const tc of event.tool_calls) {
              if (tc.id && s.processedToolUseIds.has(tc.id)) continue;
              if (tc.id) s.processedToolUseIds.add(tc.id);
              emitDelta(
                s,
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: tc.id,
                      type: 'function',
                      function: {
                        name: tc.function.name,
                        arguments: tc.function.arguments,
                      },
                    },
                  ],
                },
                null,
                emit,
              );
              s.outputTokens += estimateTokens(tc.function.arguments);
            }
          }
          break;
        }

        case 'tool_call': {
          if (s.processedToolUseIds.has(event.id)) break;
          s.processedToolUseIds.add(event.id);
          emitDelta(
            s,
            {
              tool_calls: [
                {
                  index: 0,
                  id: event.id,
                  type: 'function',
                  function: {
                    name: event.name,
                    arguments: event.arguments,
                  },
                },
              ],
            },
            null,
            emit,
          );
          s.outputTokens += estimateTokens(event.arguments);
          break;
        }

        case 'tool_result': {
          // Tool results are handled internally by agentLoop;
          // opencode expects them as part of the next request's messages array.
          // We don't emit SSE for tool results in OpenAI format.
          break;
        }

        case 'tool_blocked': {
          emitDelta(
            s,
            { content: `\n\n[Tool "${event.tool_name}" blocked: ${event.reason}]\n\n` },
            null,
            emit,
          );
          break;
        }

        case 'loop_end': {
          const stopReason = mapStopReason(event.reason, event.finish_reason);
          const inTokens = event.usageSummary?.tokens?.prompt_tokens ?? 0;
          const outTokens = event.usageSummary?.tokens?.completion_tokens ?? 0;
          finishStream(s, stopReason, inTokens, outTokens, emit);
          return { inputTokens: s.inputTokens, outputTokens: s.outputTokens };
        }

        case 'error': {
          emitDelta(s, { content: `\n\n[Error: ${event.message}]\n\n` }, null, emit);
          finishStream(s, 'error', 0, 0, emit);
          return { inputTokens: 0, outputTokens: 0 };
        }

        case 'cache_metrics':
        case 'recovery': {
          break;
        }

        default:
          break;
      }
    }

    // If generator ended without loop_end, finalize
    if (!s.finished) {
      finishStream(s, 'stop', s.inputTokens, s.outputTokens, emit);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!s.started) {
      emitDelta(s, { role: 'assistant', content: '' }, null, emit);
    }
    emitDelta(s, { content: `\n\n[Error: ${msg}]\n\n` }, null, emit);
    if (!s.finished) finishStream(s, 'error', 0, 0, emit);
  }

  return { inputTokens: s.inputTokens, outputTokens: s.outputTokens };
}

/**
 * Format an OpenAI SSE data line.
 * OpenAI SSE format is just: "data: <json>\n\n"
 */
export function formatOpenAISSE(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * The terminal SSE event for OpenAI streams.
 */
export const OPENAI_SSE_DONE = 'data: [DONE]\n\n';
