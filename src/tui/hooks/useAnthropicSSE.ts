// Anthropic SSE client for TriLC daemon /v1/messages
export interface AnthropicSSECallbacks {
  onContentDelta: (text: string) => void;
  onToolUse: (id: string, name: string, input: string) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

export interface AnthropicSSEOptions extends AnthropicSSECallbacks {
  endpoint: string;
  body: Record<string, unknown>;
}

export function connectAnthropicSSE(opts: AnthropicSSEOptions): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(opts.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': 'trilc-local',
        },
        body: JSON.stringify(opts.body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        opts.onError(new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`));
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const event = JSON.parse(data);
            switch (event.type) {
              case 'content_block_delta':
                if (event.delta?.text) opts.onContentDelta(event.delta.text);
                break;
              case 'content_block_start':
                if (event.content_block?.type === 'tool_use') {
                  opts.onToolUse(
                    event.content_block.id || '',
                    event.content_block.name || '',
                    ''
                  );
                }
                break;
              case 'content_block_stop':
                break;
              case 'message_delta':
                if (event.delta?.stop_reason) {
                  opts.onDone();
                }
                break;
              case 'message_stop':
                opts.onDone();
                break;
            }
          } catch { /* skip malformed SSE */ }
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        opts.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  })();

  return () => controller.abort();
}
