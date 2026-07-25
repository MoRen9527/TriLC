// ── QA INDEPENDENT VERIFICATION (TestEngineer 小柯) ──
// This file is an INDEPENDENT runtime verification of the stream-converter
// dedup fix. It is intentionally NOT derived from dev's stream-dedup.test.ts
// (though fixtures overlap by necessity — the AgentEvent shape is fixed).
//
// What this file adds beyond dev's coverage:
//   1. Multi-turn fixture: text → tool → text → tool → final-text.
//      Verifies the per-turn reset of textBlockHasDelta / hasTextDelta is
//      actually wired (Dev's tests only exercise a single turn).
//   2. Edge case: assistant_message with content but NO preceding content_delta
//      (some providers send only the aggregate). Verifies the converter still
//      forwards text in that case (the `!flag` guard must not over-suppress).
//   3. Edge case: assistant_message with content="" + tool_calls (no text).
//   4. Strict equality with explicit failure context for QA audit.

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { agentEventsToAnthropicSSE } from '../../src/server/anthropic-stream.js';
import { agentEventsToOpenAISSE } from '../../src/server/openai-stream.js';
import type { AgentEvent } from '@trimetaverse/agent-core';

async function* toAsync(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const e of events) yield e;
}

async function driveAnthropic(events: AgentEvent[]) {
  const captured: { eventType: string; data: any }[] = [];
  await agentEventsToAnthropicSSE(toAsync(events), {
    model: 'qa-model',
    onSSE: (eventType, data) => captured.push({ eventType, data }),
  });
  return captured;
}

async function driveOpenAI(events: AgentEvent[]) {
  const captured: any[] = [];
  await agentEventsToOpenAISSE(toAsync(events), {
    model: 'qa-model',
    onSSE: (data) => captured.push(data),
  });
  return captured;
}

// Extract the visible client-side ASSISTANT TEXT from captured SSE events.
// IMPORTANT: Anthropic protocol also emits text_delta payloads INSIDE
// tool_result content blocks (the tool's output text). Those are not part of
// the assistant's authored reply and must be excluded from the dedup check.
// We track which content_block indices are type 'text' vs 'tool_result' and
// only fold in text_delta events whose parent block is 'text'.
function anthropicClientText(captured: { eventType: string; data: any }[]): string {
  const blockTypeByIndex = new Map<number, 'text' | 'tool_result' | 'tool_use'>();
  for (const e of captured) {
    if (e.eventType === 'content_block_start') {
      const idx = e.data?.index as number | undefined;
      const t = e.data?.content_block?.type as 'text' | 'tool_result' | 'tool_use' | undefined;
      if (idx !== undefined && t) blockTypeByIndex.set(idx, t);
    }
  }
  return captured
    .filter((e) => {
      if (e.data?.delta?.type !== 'text_delta') return false;
      const idx = e.data?.index as number | undefined;
      // If we never saw a content_block_start for this index, assume text.
      return idx === undefined || blockTypeByIndex.get(idx) === 'text';
    })
    .map((e) => e.data.delta.text as string)
    .join('');
}

function openaiClientText(captured: any[]): string {
  return captured
    .map((c) => c?.choices?.[0]?.delta?.content)
    .filter((s: unknown): s is string => typeof s === 'string' && s.length > 0)
    .join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Q1. Multi-turn dedup — the canonical agentLoop emission for a tool-calling
// conversation that resolves in 2 turns. Pre-fix, the SECOND turn's text would
// be doubled (or the first turn's, depending on which flag state was buggy).
// ─────────────────────────────────────────────────────────────────────────────

function makeMultiTurnEvents(): AgentEvent[] {
  // Turn 1: model says "Let me check." + tool_call(get_weather)
  // Turn 2: tool_result returned → model says "It is sunny." (final, no tool)
  return [
    { type: 'loop_start', model: 'qa-model', turn: 1 },
    { type: 'request_start', turn: 1, model: 'qa-model' },
    { type: 'content_delta', turn: 1, delta: 'Let me ' },
    { type: 'content_delta', turn: 1, delta: 'check.' },
    {
      type: 'assistant_message',
      turn: 1,
      content: 'Let me check.',
      tool_calls: [
        { id: 'call_qa_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } },
      ],
    },
    { type: 'tool_result', turn: 1, tool_call_id: 'call_qa_1', content: 'sunny, 25C' },
    { type: 'request_start', turn: 2, model: 'qa-model' },
    { type: 'content_delta', turn: 2, delta: 'It is ' },
    { type: 'content_delta', turn: 2, delta: 'sunny.' },
    { type: 'assistant_message', turn: 2, content: 'It is sunny.', tool_calls: [] },
    {
      type: 'loop_end',
      reason: 'done',
      usageSummary: { tokens: { prompt_tokens: 10, completion_tokens: 10 } } as never,
    },
  ] as unknown as AgentEvent[];
}

describe('QA-Anthropic stream — multi-turn + edge cases', () => {
  it('Q1.1 multi-turn: client text is "Let me check.It is sunny." (no duplication)', async () => {
    const captured = await driveAnthropic(makeMultiTurnEvents());
    const clientText = anthropicClientText(captured);
    // STRICT: pre-fix would yield "Let me check.Let me check.It is sunny.It is sunny."
    assert.strictEqual(
      clientText,
      'Let me check.It is sunny.',
      `multi-turn text not deduped; got "${clientText}"`,
    );
  });

  it('Q1.2 multi-turn: tool_use block from turn 1 is forwarded (id, name, args)', async () => {
    const captured = await driveAnthropic(makeMultiTurnEvents());
    const toolStart = captured.find(
      (e) => e.eventType === 'content_block_start' && e.data?.content_block?.type === 'tool_use',
    );
    assert.ok(toolStart, 'expected a tool_use content_block_start');
    const cb = toolStart!.data.content_block;
    assert.strictEqual(cb.id, 'call_qa_1');
    assert.strictEqual(cb.name, 'get_weather');
    const jsonDeltas = captured
      .filter((e) => e.data?.delta?.type === 'input_json_delta')
      .map((e) => e.data.delta.partial_json as string)
      .join('');
    assert.strictEqual(jsonDeltas, '{"city":"Tokyo"}');
  });

  it('Q2 fallback path: assistant_message with content but NO content_delta still forwards text', async () => {
    // Some providers skip content_delta and only emit assistant_message.
    // The `!flag` guard must NOT suppress this case (flag is false).
    const events: AgentEvent[] = [
      { type: 'loop_start', model: 'qa-model', turn: 1 },
      { type: 'request_start', turn: 1, model: 'qa-model' },
      { type: 'assistant_message', turn: 1, content: 'aggregate-only-text', tool_calls: [] },
      { type: 'loop_end', reason: 'done', usageSummary: { tokens: { prompt_tokens: 1, completion_tokens: 1 } } as never },
    ] as unknown as AgentEvent[];
    const captured = await driveAnthropic(events);
    const clientText = anthropicClientText(captured);
    assert.strictEqual(clientText, 'aggregate-only-text', 'aggregate-only fallback path broken');
  });

  it('Q3 empty-content + tool_calls only: no spurious text, tool forwarded', async () => {
    const events: AgentEvent[] = [
      { type: 'loop_start', model: 'qa-model', turn: 1 },
      { type: 'request_start', turn: 1, model: 'qa-model' },
      { type: 'assistant_message', turn: 1, content: '', tool_calls: [
        { id: 'call_qa_2', type: 'function', function: { name: 'shell_exec', arguments: '{"cmd":"ls"}' } },
      ] },
      { type: 'loop_end', reason: 'tool_calls_finish', finish_reason: 'tool_calls', usageSummary: { tokens: { prompt_tokens: 1, completion_tokens: 1 } } as never },
    ] as unknown as AgentEvent[];
    const captured = await driveAnthropic(events);
    const clientText = anthropicClientText(captured);
    assert.strictEqual(clientText, '', 'expected no text for tool-only turn');
    const toolStart = captured.find(
      (e) => e.eventType === 'content_block_start' && e.data?.content_block?.type === 'tool_use',
    );
    assert.ok(toolStart, 'expected tool_use block');
    assert.strictEqual(toolStart!.data.content_block.name, 'shell_exec');
  });
});

describe('QA-OpenAI stream — multi-turn + edge cases', () => {
  it('Q1.3 multi-turn: client content is "Let me check.It is sunny." (no duplication)', async () => {
    const captured = await driveOpenAI(makeMultiTurnEvents());
    const clientText = openaiClientText(captured);
    assert.strictEqual(
      clientText,
      'Let me check.It is sunny.',
      `multi-turn text not deduped; got "${clientText}"`,
    );
  });

  it('Q1.4 multi-turn: OpenAI tool_calls delta forwarded with correct id/name/args', async () => {
    const captured = await driveOpenAI(makeMultiTurnEvents());
    const toolChunk = captured.find((c) => Array.isArray(c?.choices?.[0]?.delta?.tool_calls));
    assert.ok(toolChunk, 'expected chunk with delta.tool_calls');
    const tc = toolChunk!.choices[0].delta.tool_calls[0];
    assert.strictEqual(tc.id, 'call_qa_1');
    assert.strictEqual(tc.type, 'function');
    assert.strictEqual(tc.function.name, 'get_weather');
    assert.strictEqual(tc.function.arguments, '{"city":"Tokyo"}');
  });

  it('Q2 fallback path: aggregate-only assistant_message forwards text', async () => {
    const events: AgentEvent[] = [
      { type: 'loop_start', model: 'qa-model', turn: 1 },
      { type: 'request_start', turn: 1, model: 'qa-model' },
      { type: 'assistant_message', turn: 1, content: 'aggregate-only-text', tool_calls: [] },
      { type: 'loop_end', reason: 'done', usageSummary: { tokens: { prompt_tokens: 1, completion_tokens: 1 } } as never },
    ] as unknown as AgentEvent[];
    const captured = await driveOpenAI(events);
    const clientText = openaiClientText(captured);
    assert.strictEqual(clientText, 'aggregate-only-text');
  });

  it('Q3 empty-content + tool_calls only: tool_calls intact, no content', async () => {
    const events: AgentEvent[] = [
      { type: 'loop_start', model: 'qa-model', turn: 1 },
      { type: 'request_start', turn: 1, model: 'qa-model' },
      { type: 'assistant_message', turn: 1, content: '', tool_calls: [
        { id: 'call_qa_3', type: 'function', function: { name: 'read_file', arguments: '{"path":"/x"}' } },
      ] },
      { type: 'loop_end', reason: 'tool_calls_finish', finish_reason: 'tool_calls', usageSummary: { tokens: { prompt_tokens: 1, completion_tokens: 1 } } as never },
    ] as unknown as AgentEvent[];
    const captured = await driveOpenAI(events);
    const clientText = openaiClientText(captured);
    assert.strictEqual(clientText, '');
    const toolChunk = captured.find((c) => Array.isArray(c?.choices?.[0]?.delta?.tool_calls));
    assert.ok(toolChunk);
    assert.strictEqual(toolChunk!.choices[0].delta.tool_calls[0].function.name, 'read_file');
  });
});
