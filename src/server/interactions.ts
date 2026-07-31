// ── Interaction Bridge (P3) ──
// Connects daemon-side tool execution with the TUI for interactive prompts:
//   1. ask_user_question — AI asks a multiple-choice question, TUI collects the answer
//   2. permission ask — dangerous tool call requires allow/deny/always confirmation
//
// Tools execute inside the daemon process (agentLoop), while the user sits in
// the TUI process. The bridge therefore works over HTTP:
//   daemon tool handler → requestInteraction() → pending slot
//   TUI polls GET  /internal/v1/interactions/pending
//   TUI posts POST /internal/v1/interactions/answer → resolves the pending promise
//
// Scope control (P3): single-user local daemon — a simple FIFO queue is enough.
//
// P6: Permission persistence — rules are loaded from disk at startup and
// written when the user chooses "Always allow".

// ── Types ──

export type InteractionKind = 'question' | 'permission';

export interface PendingInteraction {
  id: string;
  kind: InteractionKind;
  /** question: { questions: Question[] }; permission: { toolName, argsSummary, reason } */
  payload: unknown;
  createdAt: number;
}

interface QueuedInteraction extends PendingInteraction {
  resolve: (response: unknown) => void;
  timeout: NodeJS.Timeout;
}

// ── State ──

/** Currently displayed interaction (at most one). */
let current: QueuedInteraction | null = null;
/** FIFO waiters — resolved one at a time as the user answers. */
const queue: Array<() => void> = [];

let nextId = 1;

/**
 * Interactive session tracking.
 * Count > 0 means a TUI (or other interactive client) has an in-flight
 * /v1/messages request with interactive:true. Tool handlers use this to
 * decide between waiting for a real user answer vs. non-interactive fallback.
 */
let interactiveSessions = 0;

export function beginInteractiveSession(): void {
  interactiveSessions++;
}

export function endInteractiveSession(): void {
  interactiveSessions = Math.max(0, interactiveSessions - 1);
}

export function isInteractiveActive(): boolean {
  return interactiveSessions > 0;
}

// ── Permission session memory ──
// Tools the user marked "always allow" — loaded from disk at startup (P6),
// added to during the session when the user selects "Always allow".

const alwaysAllowedTools = new Set<string>();

/** Load persisted allow rules from disk at daemon startup (P6). */
export function initPermissionStore(): void {
  try {
    // Dynamic import to avoid module-level side effects during testing
    import('../services/permissions/PermissionStore.js').then(
      ({ loadPersistedAllowRules }) => {
        const persisted = loadPersistedAllowRules();
        for (const toolName of persisted) {
          alwaysAllowedTools.add(toolName);
        }
        if (persisted.size > 0) {
          console.log(`[interactions] loaded ${persisted.size} persisted permission rules`);
        }
      },
      () => { /* PermissionStore not available — skip */ }
    );
  } catch {
    // PermissionStore module not available; skip
  }
}

export function isAlwaysAllowed(toolName: string): boolean {
  return alwaysAllowedTools.has(toolName);
}

export function rememberAlwaysAllow(toolName: string): void {
  alwaysAllowedTools.add(toolName);
  // P6: persist to disk so it survives daemon restarts
  try {
    import('../services/permissions/PermissionStore.js').then(
      ({ persistAllowRule }) => persistAllowRule(toolName),
      () => { /* skip */ }
    );
  } catch {
    // PermissionStore not available; session-level memory only
  }
}

export function getAlwaysAllowedTools(): string[] {
  return [...alwaysAllowedTools];
}

// ── Core API ──

/**
 * Request an interactive answer from the TUI.
 * Resolves with the user's response, or with `fallback` after `timeoutMs`.
 */
export function requestInteraction(
  kind: InteractionKind,
  payload: unknown,
  timeoutMs: number,
  fallback: unknown,
): Promise<unknown> {
  return new Promise((resolveOuter) => {
    const start = () => {
      const id = `int_${Date.now().toString(36)}_${nextId++}`;
      const timeout = setTimeout(() => {
        if (current?.id === id) {
          current = null;
          resolveOuter(fallback);
          drainQueue();
        }
      }, timeoutMs);
      timeout.unref?.();

      current = {
        id,
        kind,
        payload,
        createdAt: Date.now(),
        resolve: (response: unknown) => {
          clearTimeout(timeout);
          resolveOuter(response);
        },
        timeout,
      };
    };

    if (current) {
      // Another interaction is on screen — queue behind it.
      queue.push(start);
    } else {
      start();
    }
  });
}

function drainQueue(): void {
  const next = queue.shift();
  if (next) next();
}

/** Current pending interaction for the polling endpoint (null when idle). */
export function getPendingInteraction(): PendingInteraction | null {
  if (!current) return null;
  return { id: current.id, kind: current.kind, payload: current.payload, createdAt: current.createdAt };
}

/**
 * Resolve the pending interaction with the user's response.
 * Returns false when the id is stale (already answered / timed out).
 */
export function answerInteraction(id: string, response: unknown): boolean {
  if (!current || current.id !== id) return false;
  const c = current;
  current = null;
  c.resolve(response);
  drainQueue();
  return true;
}

/** Test helper: reset all interaction state. */
export function resetInteractions(): void {
  if (current) clearTimeout(current.timeout);
  current = null;
  queue.length = 0;
  alwaysAllowedTools.clear();
  interactiveSessions = 0;
}
