// ���� Chat controller (Ink, Anthropic /v1/messages) ����
import { useState, useCallback, useRef } from 'react';
import { connectAnthropicSSE } from './useAnthropicSSE.js';

export type RequestState = 'idle' | 'waitingForFirstToken' | 'streaming';
export interface ToolCall { id: string; name: string; arguments: string; status: 'pending' | 'done' | 'blocked'; }
export interface Message { role: 'user' | 'assistant'; content: string; isStreaming?: boolean; toolCalls?: ToolCall[]; }

const ENDPOINT = 'http://localhost:8711/v1/messages';
const MODEL = 'deepseek-v4-flash';

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [requestState, setRequestState] = useState<RequestState>('idle');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const doneRef = useRef(false);

  const abort = useCallback(() => {
    abortRef.current?.(); abortRef.current = null; doneRef.current = true;
    setRequestState('idle');
  }, []);

  const send = useCallback((text: string) => {
    if (!text.trim() || requestState !== 'idle') return;
    abortRef.current?.(); setError(null); doneRef.current = false;
    setMessages(prev => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '', isStreaming: true, toolCalls: [] }]);
    setRequestState('waitingForFirstToken');

    // Use a direct ref to accumulate content to avoid double-render
    let streamContent = '';
    
    const cancel = connectAnthropicSSE({
      endpoint: ENDPOINT,
      body: { model: MODEL, max_tokens: 4096, messages: [{ role: 'user', content: text }], stream: true },
      onContentDelta: (token) => {
        streamContent += token;
        setRequestState('streaming');
        setMessages(prev => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.role === 'assistant') last.content = streamContent;
          return copy;
        });
      },
      onToolUse: (id, name, input) => {
        setMessages(prev => {
          const copy = [...prev]; const last = copy[copy.length - 1];
          if (last?.role === 'assistant') {
            last.toolCalls = [...(last.toolCalls || []), { id, name, arguments: input, status: 'pending' as const }];
            for (let i = last.toolCalls.length - 2; i >= 0; i--) { if (last.toolCalls[i].status === 'pending') last.toolCalls[i] = { ...last.toolCalls[i], status: 'done' as const }; }
          }
          return copy;
        });
      },
      onDone: () => {
        if (doneRef.current) return;
        doneRef.current = true;
        setRequestState('idle');
        setMessages(prev => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.role === 'assistant') { last.isStreaming = false; last.content = streamContent; if (last.toolCalls) last.toolCalls = last.toolCalls.map(tc => tc.status === 'pending' ? { ...tc, status: 'done' as const } : tc); }
          return copy;
        });
        abortRef.current = null;
      },
      onError: (err) => { if (doneRef.current) return; doneRef.current = true; setRequestState('idle'); setError(err.message); abortRef.current = null; },
    });
    abortRef.current = cancel;
  }, [requestState]);

  return { messages, send, isLoading: requestState !== 'idle', requestState, error, abort };
}