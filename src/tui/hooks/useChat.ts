// ── Chat controller (Ink, Anthropic /v1/messages) ──
// Persists sessions to daemon /internal/v1/sessions on each complete exchange.
// REGR-005: ContentBlock + blocks[] enable tool-call streaming (ordered insertion).
import { useState, useCallback, useRef } from 'react';
import { connectAnthropicSSE } from './useAnthropicSSE.js';

const SESSION_ENDPOINT = 'http://localhost:8711/internal/v1/sessions';
const ENDPOINT = 'http://localhost:8711/v1/messages';
const DEFAULT_MODEL = 'deepseek-v4-flash';

export type RequestState = 'idle' | 'waitingForFirstToken' | 'streaming';
export interface ToolCall { id: string; name: string; arguments: string; status: 'pending' | 'done' | 'blocked'; }

// ── ContentBlock: ordered block model for streaming tool insertion ──
// REPLACES the flat content + toolCalls model with interleaved blocks.
// Backward compat: if msg.blocks is empty/undefined, fall back to content + toolCalls.
export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  index: number;
  // text block
  text?: string;
  // tool_use block
  toolId?: string;
  toolName?: string;
  toolInput?: string;
  toolStatus?: 'pending' | 'done' | 'error';
  // tool_result block
  toolResultContent?: string;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string; // keep for backward compat
  blocks?: ContentBlock[]; // NEW: ordered content blocks (REGR-005)
  isStreaming?: boolean;
  toolCalls?: ToolCall[]; // keep for backward compat
  thinking?: string;
}

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
  const [inputTokens, setInputTokens] = useState(0);
  const [outputTokens, setOutputTokens] = useState(0);
  const [model, setModelState] = useState<string>(DEFAULT_MODEL);
  const abortRef = useRef<(() => void) | null>(null);
  const doneRef = useRef(false);
  const messagesRef = useRef<Message[]>([]);
  // Sync ref so send() can read latest messages without stale closure
  messagesRef.current = messages;

  const abort = useCallback(() => {
    abortRef.current?.(); abortRef.current = null; doneRef.current = true;
    setRequestState('idle');
  }, []);

  const send = useCallback((text: string, resumeMessages?: Message[], resumeSessionId?: string) => {
    if (!text.trim() && !resumeMessages) return;
    if (requestState !== 'idle') return;

    abortRef.current?.(); setError(null); doneRef.current = false;

    // Build conversation context from ALL existing messages (not just resume).
    // Previous code dropped history on every send() — fixed by preserving the
    // current message list and appending the new user + streaming assistant.
    const base = resumeMessages ?? messagesRef.current;
    const apiMessages: Array<{ role: string; content: string }> = [];
    for (const msg of base) {
      if (msg.isStreaming) continue;
      if (msg.role === 'user' || msg.role === 'assistant') {
        apiMessages.push({ role: msg.role, content: msg.content || '' });
      }
    }
    apiMessages.push({ role: 'user', content: text });

    const initialMessages: Message[] = [
      ...base.filter(m => !m.isStreaming),
      { role: 'user', content: text },
      { role: 'assistant', content: '', isStreaming: true, toolCalls: [], blocks: [] },
    ];

    setMessages(initialMessages);
    setSessionId(resumeSessionId ?? null);
    setRequestState('waitingForFirstToken');

    let streamContent = '';

    const cancel = connectAnthropicSSE({
      endpoint: ENDPOINT,
      // P3: interactive:true opts this client into AskUserQuestion waiting
      // and permission prompts via the daemon interaction bridge.
      body: { model, max_tokens: 4096, messages: apiMessages, stream: true, interactive: true },

      // ── REGR-005: onContentBlockStart — append new block to streaming message ──
      onContentBlockStart: (blockType, index) => {
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.role === 'assistant') {
            const blocks = [...(last.blocks || [])];
            const newBlock: ContentBlock = {
              type: blockType,
              index,
              ...(blockType === 'tool_use' ? { toolStatus: 'pending' as const, toolInput: '' } : {}),
              ...(blockType === 'text' ? { text: '' } : {}),
            };
            blocks.push(newBlock);
            copy[copy.length - 1] = { ...last, blocks };
          }
          return copy;
        });
      },

      // ── REGR-005: onContentBlockDelta — accumulate text / input_json into blocks ──
      onContentBlockDelta: (index, delta) => {
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.role === 'assistant' && last.blocks) {
            const blocks = [...last.blocks];
            const blockIdx = blocks.findIndex(b => b.index === index);
            if (blockIdx !== -1) {
              const block = { ...blocks[blockIdx]! };
              if (delta.type === 'text_delta' && delta.text !== undefined) {
                block.text = (block.text || '') + delta.text;
              } else if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
                block.toolInput = (block.toolInput || '') + delta.partial_json;
              }
              blocks[blockIdx] = block;
            }
            copy[copy.length - 1] = { ...last, blocks };
          }
          return copy;
        });
      },

      onContentDelta: (token) => {
        streamContent += token;
        setRequestState('streaming');
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          // Replace last with a NEW object so React.memo shallow compare sees a
          // new reference and re-renders (mutating `last` in place was skipped).
          if (last?.role === 'assistant') {
            copy[copy.length - 1] = { ...last, content: streamContent };
          }
          return copy;
        });
      },
      onTokens: (inTok, outTok) => {
        // Accumulate (not overwrite) so /cost reflects the whole session, not
        // just the last message's usage.
        if (inTok > 0) setInputTokens((prev) => prev + inTok);
        if (outTok > 0) setOutputTokens((prev) => prev + outTok);
      },
      onToolUse: (id, name, input) => {
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.role === 'assistant') {
            // ── Update toolCalls (backward compat) ──
            const prevCalls = last.toolCalls || [];
            const newCalls = [
              ...prevCalls.map((tc) =>
                tc.status === 'pending' ? { ...tc, status: 'done' as const } : tc,
              ),
              { id, name, arguments: input, status: 'pending' as const },
            ];

            // ── Update blocks: find latest tool_use block without toolId ──
            const blocks = last.blocks ? [...last.blocks] : undefined;
            if (blocks) {
              for (let i = blocks.length - 1; i >= 0; i--) {
                if (blocks[i]!.type === 'tool_use' && !blocks[i]!.toolId) {
                  blocks[i] = { ...blocks[i]!, toolId: id, toolName: name };
                  break;
                }
              }
            }

            copy[copy.length - 1] = { ...last, toolCalls: newCalls, blocks };
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
            // Flip pending blocks to done
            const blocks = last.blocks?.map((b) =>
              b.type === 'tool_use' && b.toolStatus === 'pending'
                ? { ...b, toolStatus: 'done' as const }
                : b,
            );

            // New object with finalized fields; flips any leftover pending tool
            // calls to done. Required for memo shallow compare to detect change.
            copy[copy.length - 1] = {
              ...last,
              isStreaming: false,
              content: streamContent,
              toolCalls: last.toolCalls?.map((tc) =>
                tc.status === 'pending' ? { ...tc, status: 'done' as const } : tc,
              ),
              blocks,
            };
          }
          // Persist session asynchronously
          setSessionId((currentSid) => {
            const msgs = copy.filter((m) => !m.isStreaming);
            saveSession(currentSid, msgs, model).then((sid) => {
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
            saveSession(currentSid, msgs, model).catch(() => {});
            return currentSid;
          });
          return prev;
        });
        abortRef.current = null;
      },
    });
    abortRef.current = cancel;
    // Include `model` so switching via /model doesn't leave the SSE body
    // pointing at the previous model (stale closure off-by-one).
  }, [requestState, model]);

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

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  const addSystemMessage = useCallback((content: string) => {
    setMessages((prev) => [...prev, { role: 'assistant', content, isStreaming: false }]);
  }, []);

  const setModel = useCallback((newModel: string) => {
    setModelState(newModel);
  }, []);

  return { messages, send, isLoading: requestState !== 'idle', requestState, error, abort, sessionId: getSessionId, loadSession, clearMessages, addSystemMessage, inputTokens, outputTokens, model, setModel };
}
