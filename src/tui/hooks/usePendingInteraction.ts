// ── Pending interaction polling hook (P3) ──
// While a chat request is in flight, the daemon may park on an interactive
// prompt (AskUserQuestion answers, permission allow/deny). This hook polls
// the daemon's interaction bridge and exposes the pending prompt + answer().
import { useState, useEffect, useCallback, useRef } from 'react';

// P3-fix: honor TRILC_PORT env so the TUI polls the correct daemon when it
// runs on a non-default port (was hardcoded to 8711, causing polls to miss
// when the daemon is on another port).
const TRILC_PORT = process.env.TRILC_PORT ?? '8711';
const PENDING_ENDPOINT = `http://localhost:${TRILC_PORT}/internal/v1/interactions/pending`;
const ANSWER_ENDPOINT = `http://localhost:${TRILC_PORT}/internal/v1/interactions/answer`;
const POLL_INTERVAL_MS = 400;

export interface PendingQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface PendingQuestion {
  question: string;
  header: string;
  options: PendingQuestionOption[];
  multiSelect?: boolean;
}

export interface PendingInteraction {
  id: string;
  kind: 'question' | 'permission';
  payload: {
    // question kind
    questions?: PendingQuestion[];
    // permission kind
    toolName?: string;
    argsSummary?: string;
    reason?: string;
  };
  createdAt: number;
}

export function usePendingInteraction(active: boolean) {
  const [pending, setPending] = useState<PendingInteraction | null>(null);
  const pendingRef = useRef<PendingInteraction | null>(null);
  pendingRef.current = pending;

  useEffect(() => {
    if (!active) {
      // Request finished — clear any stale prompt (the daemon resolves or
      // times out server-side; nothing left for the user to answer).
      setPending(null);
      return;
    }

    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(PENDING_ENDPOINT);
        const json = (await res.json()) as { ok: boolean; pending: PendingInteraction | null };
        if (cancelled) return;
        const incoming = json.pending ?? null;
        const current = pendingRef.current;
        // Only set state on actual change (id compare) to avoid re-render churn.
        if (incoming?.id !== current?.id) {
          setPending(incoming);
        }
      } catch {
        // Daemon unreachable — leave state as-is; next tick retries.
      }
    };

    const timer = setInterval(tick, POLL_INTERVAL_MS);
    tick(); // immediate first poll
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active]);

  const answer = useCallback(async (id: string, response: unknown): Promise<boolean> => {
    try {
      const res = await fetch(ANSWER_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, response }),
      });
      if (res.ok) {
        setPending(null);
        return true;
      }
      // 409 stale — daemon already resolved (timeout); clear locally too.
      setPending(null);
      return false;
    } catch {
      return false;
    }
  }, []);

  return { pending, answer };
}
