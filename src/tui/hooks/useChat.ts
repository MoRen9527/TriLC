// ── Chat controller (Ink, Anthropic /v1/messages) ──
// Persists sessions to daemon /internal/v1/sessions on each complete exchange.
import { useState, useCallback, useRef } from 'react';
import { connectAnthropicSSE } from './useAnthropicSSE.js';

const SESSION_ENDPOINT = 'http://localhost:8711/internal/v1/sessions';
const ENDPOINT = 'http://localhost:8711/v1/messages';
const MODEL = 'deepseek-v4-flash';

export type RequestState = 'idle' | 'waitingForFirstToken' | 'streaming';
export interface ToolCall { id: string; name: string; arguments: string; status: 'pending' | 'done' | 'blocked'; }
export interface Message { role: 'user' | 'assistant'; content: string; isStreaming?: boolean; toolCalls?: ToolCall[]; }

async function saveSession(sessionId: string | null, messages: Message[], model: string): Promise<string> {
  try {
    const apiMessages = messages
      .filter((m) => !m.isStreaming)
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content || null,
      }));
    if (apiMessages.length === 0) return sessionId ?? '';

    const body: Record<string, unknown> = {
      messages: apiMessages,
      model,
    };
    if (sessionId) body.sessionId = sessionId;

    const res = await fetch(SESSION_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json() as { ok: boolean; sessionId?: string };
    if (json.ok && json.sessionId) return json.sessionId;
    return sessionId ?? '';
  } catch {
    return sessionId ?? '';
  }
}

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [requestState, setRequestState] = useState<RequestState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const doneRef = useRef(false);

  const abort = useCallback(() => {
    abortRef.current?.(); abortRef.current = null; doneRef.current = true;
    setRequestState('idle');
  }, []);

  const send = useCallback((text: string, resumeMessages?: Message[], resumeSessionId?: string) => {
    if (!text.trim() && !resumeMessages) return;
    if (requestState !== 'idle') return;

    abortRef.current?.(); setError(null); doneRef.current = false;

    // Build conversation context: include any resumed messages
    const apiMessages: Array<{ role: string; content: string }> = [];
    if (resumeMessages) {
      for (const msg of resumeMessages) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          apiMessages.push({ role: msg.role, content: msg.content });
        }
      }
    }
    apiMessages.push({ role: 'user', content: text });

    // Initial state: resume messages + new user message + empty assistant
    const initialMessages: Message[] = [
      ...(resumeMessages ?? []),
      { role: 'user', content: text },
      { role: 'assistant', content: '', isStreaming: true, toolCalls: [] },
    ];

    setMessages(initialMessages);
    setSessionId(resumeSessionId ?? null);
    setRequestState('waitingForFirstToken');

    let streamContent = '';

    const cancel = connectAnthropicSSE({
      endpoint: ENDPOINT,
      body: { model: MODEL, max_tokens: 4096, messages: apiMessages, stream: true },
      onContentDelta: (token) => {
        streamContent += token;
        setRequestState('streaming');
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.role === 'assistant') last.content = streamContent;
          return copy;
        });
      },
      onToolUse: (id, name, input) => {
        setMessages((prev) => {
          const copy = [...prev]; const last = copy[copy.length - 1];
          if (last?.role === 'assistant') {
            last.toolCalls = [...(last.toolCalls || []), { id, name, arguments: input, status: 'pending' as const }];
            for (let i = last.toolCalls.length - 2; i >= 0; i--) {
              if (last.toolCalls[i].status === 'pending') last.toolCalls[i] = { ...last.toolCalls[i], status: 'done' as const };
            }
          }
          return copy;
        });
      },
      onDone: () => {
        if (doneRef.current) return;
        doneRef.current = true;
        setRequestState('idle');
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.role === 'assistant') {
            last.isStreaming = false;
            last.content = streamContent;
            if (last.toolCalls) last.toolCalls = last.toolCalls.map((tc) =>
              tc.status === 'pending' ? { ...tc, status: 'done' as const } : tc
            );
          }
          // Persist session asynchronously
          setSessionId((currentSid) => {
            const msgs = copy.filter((m) => !m.isStreaming);
            saveSession(currentSid, msgs, MODEL).then((sid) => {
              if (sid && sid !== currentSid) setSessionId(sid);
            }).catch(() => {});
            return currentSid;
          });
          return copy;
        });
        abortRef.current = null;
      },
      onError: (err) => {
        if (doneRef.current) return;
        doneRef.current = true;
        setRequestState('idle');
        setError(err.message);
        // Persist whatever we have on error too
        setMessages((prev) => {
          setSessionId((currentSid) => {
            const msgs = prev.filter((m) => !m.isStreaming);
            saveSession(currentSid, msgs, MODEL).catch(() => {});
            return currentSid;
          });
          return prev;
        });
        abortRef.current = null;
      },
    });
    abortRef.current = cancel;
  }, [requestState]);

  // ── Load session for resume ──
  const loadSession = useCallback(async (sid: string): Promise<{ messages: Message[]; sessionId: string } | null> => {
    try {
      const res = await fetch(`http://localhost:8711/internal/v1/sessions/${sid}`);
      const json = await res.json() as { ok: boolean; session?: { id: string; model: string }; messages?: Array<{ role: string; content: string | null }> };
      if (!json.ok || !json.messages) return null;
      const msgs: Message[] = json.messages
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content!,
          isStreaming: false,
        }));
      return { messages: msgs, sessionId: sid };
    } catch {
      return null;
    }
  }, []);

  const getSessionId = useCallback(() => sessionId, [sessionId]);

  return { messages, send, isLoading: requestState !== 'idle', requestState, error, abort, sessionId: getSessionId, loadSession };
}
