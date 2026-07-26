// ── useSSE hook — low-level SSE stream parser ──
// Uses fetch() + ReadableStream (Node 20+ native) to consume SSE.
// Parses OpenAI-compatible SSE frames: data: <json>\n\n
//
// T2 extensions:
//   - SSEMessage: tool_calls delta field for function-calling streams
//   - SSEOptions: onFirstToken / onToolCall callbacks

export interface SSEMessage {
  id: string;
  choices: Array<{
    index: number;
    delta: {
      content?: string;
      role?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
}

export interface SSECallbacks {
  onToken: (token: string) => void;
  onDone: () => void;
  onError: (error: Error) => void;
  /** T2 ①: Called once when the first content delta arrives (before onToken). */
  onFirstToken?: () => void;
  /** T2 ②: Called for each tool_call frame received from daemon. */
  onToolCall?: (tc: { id: string; name: string; arguments: string }) => void;
}

export interface SSEOptions extends SSECallbacks {
  endpoint: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * Opens an SSE connection and calls onToken for each content delta.
 * Returns an abort function to cancel the stream.
 *
 * T2:
 *   - onFirstToken() fires once on the very first content delta (before onToken).
 *   - onToolCall() fires for each tool_call frame (complete frames, not incremental).
 */
export function connectSSE(opts: SSEOptions): () => void {
  const controller = new AbortController();
  const signal = opts.signal ?? controller.signal;

  let firstToken = true;

  (async () => {
    try {
      const response = await fetch(opts.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(opts.body),
        signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => 'unknown error');
        throw new Error(`SSE request failed: ${response.status} ${response.statusText} — ${text}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Response body is not readable');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE frames
        const lines = buffer.split('\n');
        // Keep the last (possibly incomplete) line in buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (!trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6); // Remove "data: " prefix
          if (data === '[DONE]') {
            opts.onDone();
            return;
          }

          try {
            const parsed: SSEMessage = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;

            // ── T2 ②: tool_calls (complete frames from daemon) ──
            if (delta.tool_calls && opts.onToolCall) {
              for (const tc of delta.tool_calls) {
                const name = tc.function?.name;
                const args = tc.function?.arguments ?? '';
                if (name) {
                  opts.onToolCall({ id: tc.id ?? '', name, arguments: args });
                }
              }
            }

            // ── content delta ──
            if (delta.content) {
              // T2 ①: first-token signal (fires before onToken, once only)
              if (firstToken) {
                firstToken = false;
                opts.onFirstToken?.();
              }
              opts.onToken(delta.content);
            }
          } catch {
            // Skip malformed JSON frames
          }
        }
      }

      // If stream ended without [DONE], still signal completion
      opts.onDone();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // Expected on abort, not an error
        return;
      }
      opts.onError(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return () => controller.abort();
}
