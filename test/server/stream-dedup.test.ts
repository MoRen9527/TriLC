// ── Stream-converter dedup regression tests ──
// CTO fix: agentLoop emits BOTH content_delta (incremental) AND assistant_message
// (full aggregate) for the same text each turn. Stream converters must forward
// only one to avoid duplicate text on the client.
//
// Coverage:
//   A. /v1/messages streaming (agentEventsToAnthropicSSE)
//   C. /chat/completions streaming (agentEventsToOpenAISSE)
//
// Each path gets two assertions:
//   1. text-dedup: client text strictly equals model output, no duplication
//   2. tool-render: tool_use block / OpenAI tool_calls structure intact

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  agentEventsToAnthropicSSE,
  // formatSSELine is not needed for in-memory capture
} from '../../src/server/anthropic-stream.js';
import { agentEventsToOpenAISSE } from '../../src/server/openai-stream.js';
import type { AgentEvent } from '@tricompany/agent-core';

// ── Test fixtures ──
// Replicates the canonical turn shape emitted by agentLoop per model invocation:
//   request_start → content_delta* → assistant_message(content, tool_calls?) → loop_end

function makeTextOnlyEvents(text: string): AgentEvent[] {
  // Simulate incremental streaming of `text` in two chunks, followed by the
  // aggregate assistant_message carrying the full text.
  const mid = Math.ceil(text.length / 2);
  return [
    { type: 'loop_start', model: 'test-model', turn: 1 },
    { type: 'request_start', turn: 1, model: 'test-model' },
    { type: 'content_delta', turn: 1, delta: text.slice(0, mid) },
    { type: 'content_delta', turn: 1, delta: text.slice(mid) },
    { type: 'assistant_message', turn: 1, content: text, tool_calls: [] },
    {
      type: 'loop_end',
      reason: 'done',
      usageSummary: { tokens: { prompt_tokens: 5, completion_tokens: 5 } } as never,
    },
  ] as unknown as AgentEvent[];
}

function makeToolOnlyEvents(): AgentEvent[] {
  // Assistant responds with NO text content, only a tool_call.
  // assistant_message carries empty content + the tool_call aggregate.
  // Reproduces agentLoop's per-turn double-emission: BOTH assistant_message
  // (with tool_calls[]) AND a standalone tool_call event for the SAME id.
  // The stream converter must open the tool_use block only once per id.
  return [
    { type: 'loop_start', model: 'test-model', turn: 1 },
    { type: 'request_start', turn: 1, model: 'test-model' },
    {
      type: 'assistant_message',
      turn: 1,
      content: '',
      tool_calls: [
        {
          id: 'call_fixtures_1',
          function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
        },
      ],
    },
    {
      type: 'tool_call',
      turn: 1,
      id: 'call_fixtures_1',
      name: 'get_weather',
      arguments: '{"city":"Tokyo"}',
    },
    {
      type: 'loop_end',
      reason: 'tool_calls_finish',
      finish_reason: 'tool_calls',
      usageSummary: { tokens: { prompt_tokens: 5, completion_tokens: 5 } } as never,
    },
  ] as unknown as AgentEvent[];
}

async function driveAnthropic(events: AgentEvent[]): Promise<{ eventType: string; data: any }[]> {
  const captured: { eventType: string; data: any }[] = [];
  await agentEventsToAnthropicSSE(toAsync(events), {
    model: 'test-model',
    onSSE: (eventType, data) => captured.push({ eventType, data }),
  });
  return captured;
}

async function driveOpenAI(events: AgentEvent[]): Promise<any[]> {
  const captured: any[] = [];
  await agentEventsToOpenAISSE(toAsync(events), {
    model: 'test-model',
    onSSE: (data) => captured.push(data),
  });
  return captured;
}

async function* toAsync(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const e of events) yield e;
}

// ─────────────────────────────────────────────────────────────────────────────
// A. /v1/messages streaming (Anthropic SSE)
// ─────────────────────────────────────────────────────────────────────────────

describe('A. /v1/messages streaming — dedup + tool_use render', () => {
  it('A.1 text-dedup: client text strictly equals model output, no duplication', async () => {
    const modelText = 'Hello world';
    const captured = await driveAnthropic(makeTextOnlyEvents(modelText));

    // Concatenate every text_delta payload the client would receive.
    const clientText = captured
      .filter((e) => e.data?.delta?.type === 'text_delta')
      .map((e) => e.data.delta.text as string)
      .join('');

    // STRICT equality — the pre-fix bug produced "Hello worldHello world".
    assert.strictEqual(
      clientText,
      modelText,
      `client received "${clientText}" instead of "${modelText}" (duplicate text not suppressed)`,
    );
  });

  it('A.2 tool-render: tool_use block structure intact', async () => {
    const captured = await driveAnthropic(makeToolOnlyEvents());

    // Find the tool_use block_start.
    const toolStart = captured.find(
      (e) => e.eventType === 'content_block_start' && e.data?.content_block?.type === 'tool_use',
    );
    assert.ok(toolStart, 'expected a tool_use content_block_start event');

    const cb = toolStart!.data.content_block;
    assert.strictEqual(cb.id, 'call_fixtures_1');
    assert.strictEqual(cb.name, 'get_weather');

    // Verify input_json_delta forwarded for tool arguments.
    const jsonDeltas = captured
      .filter((e) => e.data?.delta?.type === 'input_json_delta')
      .map((e) => e.data.delta.partial_json as string)
      .join('');
    assert.strictEqual(jsonDeltas, '{"city":"Tokyo"}');

    // And no spurious text_delta leaked (content was empty).
    const textLeaks = captured.filter((e) => e.data?.delta?.type === 'text_delta');
    assert.strictEqual(textLeaks.length, 0, 'no text_delta expected for tool-only response');
  });

  it('A.3 tool-use-dedup: same tool_use id opens content_block_start exactly once', async () => {
    // makeToolOnlyEvents now reproduces the agentLoop double-emission:
    // assistant_message.tool_calls (aggregate) + a standalone tool_call with
    // the SAME id. Pre-fix, the converter opened TWO tool_use blocks for one
    // tool_use id and emitted the input JSON twice. Post-fix, only one.
    const captured = await driveAnthropic(makeToolOnlyEvents());

    const toolBlockStarts = captured.filter(
      (e) => e.eventType === 'content_block_start' && e.data?.content_block?.type === 'tool_use',
    );
    assert.strictEqual(
      toolBlockStarts.length,
      1,
      `expected exactly 1 tool_use content_block_start, got ${toolBlockStarts.length} (duplicate tool_use block not suppressed)`,
    );

    // Same id opened only once.
    assert.strictEqual(toolBlockStarts[0].data.content_block.id, 'call_fixtures_1');

    // input_json_delta forwarded exactly once — not doubled.
    const jsonConcat = captured
      .filter((e) => e.data?.delta?.type === 'input_json_delta')
      .map((e) => e.data.delta.partial_json as string)
      .join('');
    assert.strictEqual(
      jsonConcat,
      '{"city":"Tokyo"}',
      `input_json_delta concatenated to "${jsonConcat}" instead of a single '{"city":"Tokyo"}' (duplicate tool_use JSON not suppressed)`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. /chat/completions streaming (OpenAI SSE)
// ─────────────────────────────────────────────────────────────────────────────

describe('C. /chat/completions streaming — dedup + OpenAI tool_calls render', () => {
  it('C.1 text-dedup: client text strictly equals model output, no duplication', async () => {
    const modelText = 'Hello world';
    const captured = await driveOpenAI(makeTextOnlyEvents(modelText));

    // OpenAI delta.content — skip the initial role-establishment empty-string delta.
    const clientText = captured
      .map((c) => c?.choices?.[0]?.delta?.content)
      .filter((s: unknown): s is string => typeof s === 'string' && s.length > 0)
      .join('');

    assert.strictEqual(
      clientText,
      modelText,
      `client received "${clientText}" instead of "${modelText}" (duplicate text not suppressed)`,
    );
  });

  it('C.2 tool-render: OpenAI tool_calls structure intact', async () => {
    const captured = await driveOpenAI(makeToolOnlyEvents());

    // Find the chunk carrying tool_calls.
    const toolChunk = captured.find((c) => Array.isArray(c?.choices?.[0]?.delta?.tool_calls));
    assert.ok(toolChunk, 'expected a chunk with delta.tool_calls');

    const tc = toolChunk!.choices[0].delta.tool_calls[0];
    assert.strictEqual(tc.id, 'call_fixtures_1');
    assert.strictEqual(tc.type, 'function');
    assert.strictEqual(tc.function.name, 'get_weather');
    assert.strictEqual(tc.function.arguments, '{"city":"Tokyo"}');

    // No content leaked.
    const contentLeaks = captured.filter(
      (c) => typeof c?.choices?.[0]?.delta?.content === 'string' &&
        (c.choices[0].delta.content as string).length > 0,
    );
    assert.strictEqual(contentLeaks.length, 0, 'no content delta expected for tool-only response');
  });

  it('C.3 tool-calls-dedup: same tool_use id emits tool_calls delta exactly once', async () => {
    // Symmetric to A.3: makeToolOnlyEvents now reproduces the agentLoop
    // double-emission (assistant_message.tool_calls + standalone tool_call,
    // same id). Pre-fix, /chat/completions emitted TWO tool_calls delta chunks
    // for one id. Post-fix, only one.
    const captured = await driveOpenAI(makeToolOnlyEvents());

    const toolCallChunks = captured.filter((c) =>
      Array.isArray(c?.choices?.[0]?.delta?.tool_calls),
    );
    assert.strictEqual(
      toolCallChunks.length,
      1,
      `expected exactly 1 chunk with delta.tool_calls, got ${toolCallChunks.length} (duplicate tool_calls delta not suppressed)`,
    );

    const tc = toolCallChunks[0].choices[0].delta.tool_calls[0];
    assert.strictEqual(tc.id, 'call_fixtures_1');
    assert.strictEqual(tc.function.arguments, '{"city":"Tokyo"}');
  });
});
