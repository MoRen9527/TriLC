// ── JSON-mode dedup regression guard (B + D) ──
// CTO fix: in app.ts, the JSON (non-streaming) routes for both /v1/messages
// and /chat/completions previously did:
//     if (event.content) finalContent += event.content;
// which APPENDED the assistant_message aggregate on top of the content_delta
// increments, producing duplicated client text.
//
// Fix (CTO directive):
//     if (!finalContent && event.content) finalContent = event.content;
//
// This file is a STATIC CODE-SHAPE guard, not a runtime test. It pins the
// post-fix shape of the two JSON routes so a regression (revert, accidental
// `+=`, or tool_calls collection breakage) trips a test failure.
//
// Why static instead of runtime: the JSON-mode collection loop is inline in
// the route handlers of src/server/app.ts (not factored into a testable
// helper). agentLoop internally calls createModelClient() with no injection
// seam, so runtime coverage requires either (a) extracting the loop into a
// pure helper or (b) booting an HTTP-level stub model backend. Both are
// follow-up work — tracked in 技术债务.
//
// The runtime dedup invariant itself IS covered for the streaming paths
// (A and C) in ./stream-dedup.test.ts, which exercise the same
// `!flag && event.content` pattern via the public stream-converter exports.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_TS_PATH = resolve(__dirname, '../../src/server/app.ts');
const SOURCE = readFileSync(APP_TS_PATH, 'utf8');

// Count non-overlapping occurrences of a literal substring.
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while ((from = haystack.indexOf(needle, from)) !== -1) {
    count += 1;
    from += needle.length;
  }
  return count;
}

describe('B+D. app.ts JSON-mode dedup shape guard', () => {
  it('B.1+D.1 text-dedup: both JSON routes use the `!finalContent && event.content` assignment pattern', () => {
    // CTO fix line, must appear exactly twice — once per JSON route
    // (/v1/messages JSON around line 780, /chat/completions JSON around 1142).
    const fixedPattern = 'if (!finalContent && event.content) finalContent = event.content;';
    const fixedCount = countOccurrences(SOURCE, fixedPattern);
    assert.strictEqual(
      fixedCount,
      2,
      `expected exactly 2 occurrences of the dedup-fixed pattern, found ${fixedCount}`,
    );

    // And the OLD buggy `+=` pattern must be completely gone from JSON routes.
    const buggyPattern = 'if (event.content) finalContent += event.content;';
    const buggyCount = countOccurrences(SOURCE, buggyPattern);
    assert.strictEqual(
      buggyCount,
      0,
      `old buggy "+=" pattern still present ${buggyCount} times — dedup regressed`,
    );
  });

  it('B.2+D.2 tool-render: tool_calls collection loops intact in both JSON routes', () => {
    // The fix must not have touched tool_calls handling. Both JSON routes
    // collect tool_calls via the same for-loop. Expect 2 occurrences.
    const toolLoopPattern = 'for (const tc of event.tool_calls)';
    const toolLoopCount = countOccurrences(SOURCE, toolLoopPattern);
    assert.strictEqual(
      toolLoopCount,
      2,
      `expected exactly 2 tool_calls collection loops (one per JSON route), found ${toolLoopCount}`,
    );

    // And each route must still push the structured toolCall object.
    const pushPattern = 'toolCalls.push({';
    const pushCount = countOccurrences(SOURCE, pushPattern);
    assert.strictEqual(
      pushCount,
      2,
      `expected exactly 2 toolCalls.push() call sites, found ${pushCount}`,
    );
  });

  it('B.3+D.3 content/tool_calls separation: each route handles them in independent `if` blocks', () => {
    // CTO constraint: the assistant_message handler must keep content and
    // tool_calls in separate control-flow branches so the dedup guard on
    // content never affects tool_calls forwarding. Verify the dedup line is
    // immediately followed by an independent tool_calls `if`, in both routes.
    const dedupLine = 'if (!finalContent && event.content) finalContent = event.content;';
    const toolIfLine = 'if (event.tool_calls)';

    let from = 0;
    let separationOk = 0;
    while (true) {
      const idx = SOURCE.indexOf(dedupLine, from);
      if (idx === -1) break;
      // Look within the next 200 chars for the independent tool_calls if.
      const window = SOURCE.slice(idx, idx + 200);
      if (window.includes(toolIfLine)) separationOk += 1;
      from = idx + dedupLine.length;
    }
    assert.strictEqual(
      separationOk,
      2,
      `expected dedup line to be followed by independent tool_calls if in both routes, found ${separationOk}`,
    );
  });

  it('B.4+D.4 streaming routes unchanged: tool_calls SSE handlers still intact for both converters', () => {
    // Cross-check: the streaming routes' tool_calls forwarding must also be
    // untouched. Verify the stream-converter wiring is still imported and
    // both /v1/messages and /chat/completions streaming branches exist.
    assert.ok(
      SOURCE.includes('agentEventsToAnthropicSSE'),
      'anthropic stream converter import/wiring missing',
    );
    assert.ok(
      SOURCE.includes('agentEventsToOpenAISSE'),
      'openai stream converter import/wiring missing',
    );

    // The /v1/messages SSE branch and /chat/completions SSE branch must
    // both still call their respective converters.
    const anthSseCallCount = countOccurrences(SOURCE, 'agentEventsToAnthropicSSE(');
    const oaiSseCallCount = countOccurrences(SOURCE, 'agentEventsToOpenAISSE(');
    assert.ok(
      anthSseCallCount >= 1,
      `expected at least 1 agentEventsToAnthropicSSE() call site, found ${anthSseCallCount}`,
    );
    assert.ok(
      oaiSseCallCount >= 1,
      `expected at least 1 agentEventsToOpenAISSE() call site, found ${oaiSseCallCount}`,
    );
  });
});
