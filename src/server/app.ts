// ── TriLC Local HTTP Server ──
// Exposes the same API surface as TriMC:
//   GET  /healthz              → { ok: true, service: 'trilc' }
//   GET  /v1/models            → Anthropic-compatible model list
//   GET  /models               → OpenAI-compatible model list
//   POST /v1/messages          → Anthropic Messages API (SSE + JSON)
//   POST /chat/completions     → OpenAI Chat Completions API (SSE + JSON)
//   POST /internal/v1/agent    → SSE + JSON modes (agentLoop from @tricompany/agent-core)
//
// TriLC does NOT load pipeline (Soul Loader / Memory Injector / Context Builder / Tool Gater).
// Those are TriMC-only services. Local mode uses legacy raw mode directly.

import { createServer, type Server, type ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { TriLCEnv } from '../config/env.js';
import { resolveWeeklyPlaneRoot } from '../project/weekly-plane-root.js';
import { agentLoop, register as registerTool, canUseTool } from '@tricompany/agent-core';
import type { AgentEvent, AgentLoopOptions, AgentLoopDeps } from '@tricompany/agent-core';
import type { AgentTier, PermissionMode, PermissionRule } from '@tricompany/agent-core';
import { isPlanModeActive, PLAN_MODE_WHITELIST } from '../tools/plan-mode.js';
import { validateMessage, type GuardResult } from '@tricompany/agent-core';
import type { Message, ToolDefinition, UsageSummary } from 'trimodel';
import { createModelClient } from 'trimodel';
import { createEventQueue } from '../event-queue/index.js';
import type { ReplayRequest, ReplayResponse } from '../event-queue/types.js';
import { publish, localBus } from '../localbus/bus.js';
import { agentEventsToAnthropicSSE, formatSSELine } from './anthropic-stream.js';
import { agentEventsToOpenAISSE, formatOpenAISSE, OPENAI_SSE_DONE } from './openai-stream.js';
import { registerShellExecTool, getDefaultSupervisor, cancelAllShellProcesses } from '../tools/shell-exec.js';
import { createSessionStore } from '../session-store/index.js';
import { runSafetyCheck } from '../session-store/safety-check.js';
import type { SessionRecord, SessionMessageRecord, SessionStatus } from '../session-store/types.js';
import {
  applyKeyCacheToEnvironment,
  getKeyCache,
  initKeyCache,
  onKeyCacheUpdated,
  stopKeyCache,
} from '../config/key-cache.js';
import { TaskMirrorPusher } from '../mirror/pusher.js';
import type { MirrorTaskSnapshot } from '../mirror/types.js';
import {
  beginInteractiveSession,
  endInteractiveSession,
  getPendingInteraction,
  answerInteraction,
  isAlwaysAllowed,
  rememberAlwaysAllow,
  requestInteraction,
} from './interactions.js';
import { createHeartbeatWake } from '../heartbeat/heartbeat-wake.js';
import { createHeartbeatRunner, type TriLCHeartbeatRunner, type HeartbeatAgentConfig } from '../heartbeat/heartbeat-runner.js';
import { CompanyInitState } from '../company/init-state.js';
import { buildOnboardingAgent } from '../company/onboarding.js';
import { createSessionReaper } from '../cron/session-reaper.js';
import { createMinimalCronEngine, type MinimalCronEngine } from '../cron/service.js';
import { createUpdateCheckHandler, startUpdateCheckLoop } from '../update/update-check.js';

// Cached roster of available sub-agents (built at daemon startup, injected
// into system prompts so the model knows by name which agents it can invoke
// with AgentTool — e.g. "let Xiao Jia check this" → AgentTool(agentType=ceo-chief-of-staff)).
let cachedAgentRoster = '';

// ── Builtin Agents ──
// Hardcoded sub-agents that are not loaded from TriCompany contracts.
// Exposed via GET /internal/v1/agents?scope=builtin (or scope=all).

interface BuiltinAgent {
  id: string;
  displayName: string;
  description: string;
  hasSystemPrompt: boolean;
  decisionRights: { approve: string[]; freeze: string[]; escalate: string[] };
  tools: Record<string, unknown>;
}

const BUILTIN_AGENTS: BuiltinAgent[] = [
  {
    id: 'code_explorer',
    displayName: 'Code Explorer',
    description: 'Search and explore codebases — find symbols, trace dependencies, navigate project structure',
    hasSystemPrompt: true,
    decisionRights: { approve: [], freeze: ['write', 'delete'], escalate: [] },
    tools: { name: 'Code Explorer', description: 'Structural codebase search and navigation agent' },
  },
  {
    id: 'test_runner',
    displayName: 'Test Runner',
    description: 'Run tests and report results — execute test suites and surface failures',
    hasSystemPrompt: true,
    decisionRights: { approve: [], freeze: ['write', 'delete'], escalate: [] },
    tools: { name: 'Test Runner', description: 'Test execution and result reporting agent' },
  },
  {
    id: 'file_processor',
    displayName: 'File Processor',
    description: 'Transform and process files — batch file operations, format conversions, data extraction',
    hasSystemPrompt: true,
    decisionRights: { approve: [], freeze: ['delete'], escalate: ['write'] },
    tools: { name: 'File Processor', description: 'File transformation and batch processing agent' },
  },
  {
    id: 'code_reviewer',
    displayName: 'Code Reviewer',
    description: 'Review code for quality and issues — lint, security scan, style check, best-practice audit',
    hasSystemPrompt: true,
    decisionRights: { approve: [], freeze: ['write', 'delete'], escalate: [] },
    tools: { name: 'Code Reviewer', description: 'Code quality review and audit agent' },
  },
];

// ── P3: Interactive permission rules ──
// Dangerous tools that trigger an interactive allow/deny/always prompt when
// the request opts in via `interactive: true`. Mode stays bypassPermissions
// so everything else passes at pipeline step 4; these hit step 2 (ask).
const INTERACTIVE_ASK_RULES: PermissionRule[] = [
  { toolName: 'shell_exec', behavior: 'ask', source: 'session' },
  { toolName: 'Bash', behavior: 'ask', source: 'session' },
  { toolName: 'Edit', behavior: 'ask', source: 'session' },
  { toolName: 'Write', behavior: 'ask', source: 'session' },
];

/** Compact human-readable summary of tool args for the permission prompt. */
function summarizeToolArgs(toolName: string, args: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  if (toolName === 'shell_exec' || toolName === 'Bash') {
    return str(args.command ?? args.cmd ?? '').slice(0, 200);
  }
  if (toolName === 'Edit' || toolName === 'Write') {
    return str(args.file_path ?? args.filePath ?? args.path ?? '').slice(0, 200);
  }
  return JSON.stringify(args).slice(0, 200);
}

// ── P7: Plan mode tool gating ──
// Injects deps.checkToolPermission into every AgentLoopOptions so that
// EnterPlanMode→ExitPlanMode brackets are enforced at tool-execution time.
// The callback runs AFTER permissionEngine (P3) and BEFORE actual execution.
function buildPlanModeDeps(): AgentLoopDeps {
  return {
    checkToolPermission: (toolName, tier) => {
      // First tier check (agent-core native tier gating)
      const tierResult = canUseTool(toolName, tier);
      if (!tierResult.allowed) return tierResult;

      // Plan mode whitelist check (P7)
      if (isPlanModeActive() && !PLAN_MODE_WHITELIST.has(toolName)) {
        return {
          allowed: false,
          reason:
            `Plan mode active: tool "${toolName}" is blocked. ` +
            'Only read/plan tools are allowed during plan mode. ' +
            'Use ExitPlanMode to resume full capabilities.',
        };
      }

      return { allowed: true };
    },
  };
}

// ── C15 v2: Compacting agent loop wrapper ──
// Wraps agentLoop with auto-compaction: monitors cumulative prompt tokens
// via loop_end.usageSummary, triggers compactViaModelClient (direct ModelClient,
// no HTTP → no circular dependency), injects summary as system context, restarts.
// Stops after maxRestarts to prevent infinite loop.

const COMPACT_TOKEN_THRESHOLD = 90_000; // ~70% of 128K context
const MAX_COMPACT_RESTARTS = 3;

async function* runCompactingAgentLoop(
  options: AgentLoopOptions,
  logger = (msg: string) => console.log(msg),
): AsyncGenerator<AgentEvent> {
  let currentOptions = { ...options };
  let accumulatedPromptTokens = 0;
  let restartCount = 0;

  while (restartCount <= MAX_COMPACT_RESTARTS) {
    let loopHadContent = false;
    let loopPromptTokens = 0;

    for await (const event of agentLoop(currentOptions)) {
      // Track token usage from loop_end
      if (event.type === 'loop_end' && event.usageSummary) {
        loopPromptTokens = event.usageSummary.tokens.prompt_tokens;
      }
      if (event.type === 'content_delta' || event.type === 'assistant_message') {
        loopHadContent = true;
      }
      yield event;
    }

    if (!loopHadContent) break; // empty loop, no point compacting

    accumulatedPromptTokens += loopPromptTokens;

    // Check compaction threshold
    if (accumulatedPromptTokens > COMPACT_TOKEN_THRESHOLD) {
      logger(`[trilc:compact] auto-trigger: ${accumulatedPromptTokens} tokens > ${COMPACT_TOKEN_THRESHOLD} threshold`);

      const compactable = (currentOptions.messages ?? [])
        .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));

      if (compactable.length < 3) {
        logger('[trilc:compact] not enough messages to compact, continuing');
        break;
      }

      try {
        const { compactViaModelClient } = await import('../services/compact/compact.js');
        const result = await compactViaModelClient(compactable);

        // Inject summary + keep last 2 messages for context
        currentOptions = {
          ...currentOptions,
          systemPrompt: `[Compact summary]\n${result.summary}\n\n---\n\n${currentOptions.systemPrompt ?? ''}`,
          messages: [
            ...(currentOptions.messages ?? []).slice(-2),
          ],
        };
        accumulatedPromptTokens = 0;
        restartCount++;
        yield { type: 'compaction', message: `Compacted: removed ~${result.tokensRemoved} tokens, ${compactable.length} messages → summary ${result.summary.length} chars` } as unknown as AgentEvent;
        logger(`[trilc:compact] done: removed ~${result.tokensRemoved} tokens, restart #${restartCount}`);
        continue; // restart loop with compacted context
      } catch (err) {
        logger(`[trilc:compact] failed: ${(err as Error).message}, continuing uncompacted`);
        yield { type: 'compaction_failed', message: (err as Error).message } as unknown as AgentEvent;
        break; // give up, continue with full context
      }
    }

    break; // normal completion, no compaction needed
  }

  if (restartCount > MAX_COMPACT_RESTARTS) {
    logger(`[trilc:compact] max restarts (${MAX_COMPACT_RESTARTS}) reached, giving up`);
  }
}

/** P3: onPermissionAsk bridge — routes 'ask' decisions to the TUI. */
async function askPermissionViaTui(
  toolName: string,
  args: Record<string, unknown>,
  reason?: string,
): Promise<'allow' | 'deny' | 'always'> {
  if (isAlwaysAllowed(toolName)) return 'allow';
  const verdict = await requestInteraction(
    'permission',
    { toolName, argsSummary: summarizeToolArgs(toolName, args), reason },
    120_000, // 2min timeout → fail closed (deny)
    'deny',
  );
  if (verdict === 'always') {
    rememberAlwaysAllow(toolName);
    return 'allow';
  }
  return verdict === 'allow' ? 'allow' : 'deny';
}

// ── ConnectionManager ──
// Tracks TriMC reachability for fast fallback decisions.
// CTO-008-M spec: 3 consecutive failures → DEGRADED → 2 consecutive successes → CONNECTED
// Uses POST /internal/v1/heartbeat with node metadata instead of bare GET /healthz.
// On recovery (DEGRADED→CONNECTED), triggers event replay via POST /internal/v1/events/replay.
//
// Heartbeat Wake (absorbed from openclaw heartbeat-wake pattern):
// - requestHeartbeatNow(): on-demand trigger with coalescing (250ms window)
// - Priority coalescing: retry < interval < default < action
// - Retry backoff: 1s cooldown on failure prevents collapse
// - enable/disable toggle for graceful shutdown

type ConnectionState = 'connected' | 'degraded' | 'local';

// Replay event item type alias from shared types
type ReplayEventItem = ReplayRequest['events'][number];

interface ConnectionManagerOptions {
  nodeId: string;
  version: string;
  intervalMs?: number;
  /** 2.5: Initial connection state (default: 'degraded').
   *  Use 'local' when trimcBaseUrl is empty — daemon runs standalone. */
  initialState?: ConnectionState;
  queueSize?: () => number;
  getPendingForReplay?: (connectionId: string, limit?: number) => ReplayEventItem[];
  applyReplayResponse?: (connectionId: string, res: ReplayResponse, events: ReplayEventItem[]) => void;
}

// ── ConnectionManager (2.5: local state + persistence + backoff) ──

class ConnectionManager {
  private state: ConnectionState;
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private readonly failThreshold = 3;
  private readonly recoverThreshold = 2;
  private readonly DEGRADED_BACKOFF_MS = 5 * 60 * 1000; // 2.5: slow heartbeat after 5 min degraded
  private readonly DEGRADED_SLOW_INTERVAL_MS = 60_000; // 2.5: 60s interval when degraded > 5 min
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private readonly trimcBaseUrl: string;
  private healthCheckIntervalMs: number;
  private readonly nodeId: string;
  private readonly version: string;
  private startTime: number;
  private degradedAt: number | null = null; // 2.5: timestamp when degraded started
  private _queueSize: () => number;
  private _getPendingForReplay: (connectionId: string, limit?: number) => ReplayEventItem[];
  private _applyReplayResponse: (connectionId: string, res: ReplayResponse, events: ReplayEventItem[]) => void;
  private recoveryCallback: (() => void) | null = null;
  private stateFile: string | null = null; // 2.5: persistence file path

  // ── Heartbeat Wake (CTO-008-M Phase 1: extracted to heartbeat-wake module) ──
  private wake = createHeartbeatWake();

  constructor(trimcBaseUrl: string, opts: ConnectionManagerOptions) {
    this.trimcBaseUrl = trimcBaseUrl;
    this.state = opts.initialState ?? 'degraded';
    this.nodeId = opts.nodeId;
    this.version = opts.version;
    this.healthCheckIntervalMs = opts.intervalMs ?? 10_000;
    this._queueSize = opts.queueSize ?? (() => 0);
    this._getPendingForReplay = opts.getPendingForReplay ?? (() => []);
    this._applyReplayResponse = opts.applyReplayResponse ?? (() => {});
    this.startTime = Date.now();
    if (this.state === 'local') {
      console.log('[trilc:conn] running in local mode — TriMC not configured');
    }
  }

  get currentState(): ConnectionState {
    return this.state;
  }

  recordSuccess(): void {
    const wasDegraded = this.state === 'degraded';
    this.consecutiveFailures = 0;
    if (this.state === 'degraded') {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.recoverThreshold) {
        this.state = 'connected';
        this.consecutiveSuccesses = 0;
        this.degradedAt = null; // 2.5: clear degraded timer
        this.healthCheckIntervalMs = 10_000; // 2.5: restore normal interval
        console.log('[trilc:conn] recovered → connected');
        this.persistState();
        publish({ type: 'node:connected' });
        this._performReplay().catch((err) => {
          console.error('[trilc:conn] replay failed:', err instanceof Error ? err.message : String(err));
        });
        if (this.recoveryCallback) this.recoveryCallback();
      }
    }
  }

  recordFailure(): void {
    this.consecutiveSuccesses = 0;
    if (this.state === 'connected') {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.failThreshold) {
        this.state = 'degraded';
        this.consecutiveFailures = 0;
        this.degradedAt = Date.now(); // 2.5: track when degraded started
        console.log('[trilc:conn] degraded → will use local fallback');
        this.persistState();
        publish({ type: 'node:degraded' });
      }
    } else if (this.state === 'degraded') {
      // 2.5: degraded backoff — after 5 min, slow heartbeat to 60s
      if (this.degradedAt && (Date.now() - this.degradedAt > this.DEGRADED_BACKOFF_MS)) {
        this.healthCheckIntervalMs = this.DEGRADED_SLOW_INTERVAL_MS;
      }
    }
  }

  // Send enhanced heartbeat to TriMC POST /internal/v1/heartbeat
  async checkHealth(): Promise<boolean> {
    try {
      const ok = await postHeartbeat(this.trimcBaseUrl, {
        nodeId: this.nodeId,
        state: this.state,
        queueSize: this._queueSize(),
        uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
        agentCoreVersion: this.version,
      });
      if (ok) {
        this.recordSuccess();
        return true;
      } else {
        this.recordFailure();
        return false;
      }
    } catch {
      this.recordFailure();
      return false;
    }
  }

  startHealthCheckLoop(): void {
    if (this.healthCheckTimer) return;

    // Register wake handler that delegates to checkHealth
    this.wake.setWakeHandler(async () => {
      const ok = await this.checkHealth();
      return ok
        ? { status: "ran" as const, durationMs: 0 }
        : { status: "failed" as const, reason: "health check failed" };
    });

    this.healthCheckTimer = setInterval(() => {
      if (this.wake.isEnabled()) {
        this.wake.requestHeartbeatNow({ reason: 'interval' });
      }
    }, this.healthCheckIntervalMs);

    // Immediate first check
    if (this.wake.isEnabled()) {
      this.wake.requestHeartbeatNow({ reason: 'interval', coalesceMs: 0 });
    }
  }

  stopHealthCheckLoop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    // Clear wake handler — handles all internal timer/pending/state cleanup
    this.wake.setWakeHandler(null);
  }

  // ── Heartbeat Wake (delegated to heartbeat-wake module) ──

  /** Enable or disable heartbeat checks (periodic + on-demand). */
  setHeartbeatsEnabled(enabled: boolean): void {
    this.wake.setEnabled(enabled);
  }

  /** Check if heartbeats are enabled. */
  areHeartbeatsEnabled(): boolean {
    return this.wake.isEnabled();
  }

  /**
   * Request an immediate heartbeat check with coalescing (delegated to wake module).
   * Multiple rapid calls within coalesce window (250ms) are merged.
   * Higher priority reasons preempt lower ones.
   */
  requestHeartbeatNow(opts?: { reason?: string; coalesceMs?: number }): void {
    this.wake.requestHeartbeatNow(opts);
  }

  /** Check if a wake is pending (timer scheduled or queued). */
  hasPendingWake(): boolean {
    return this.wake.hasPendingWake();
  }

  // Register callback for post-recovery actions (e.g., reset connectionId)
  onRecovered(cb: () => void): void {
    this.recoveryCallback = cb;
  }

  // Replay pending events to TriMC after recovery from degraded state
  private async _performReplay(): Promise<void> {
    // Use internal connectionId tracker set in createTriLCApp
    const cid = (this as unknown as { __connectionId: string }).__connectionId ?? '';
    const events = this._getPendingForReplay(cid);
    if (events.length === 0) {
      console.log('[trilc:conn] replay: no pending events');
      return;
    }
    console.log(`[trilc:conn] replay: replaying ${events.length} events`);
    try {
      const response = await postReplay(this.trimcBaseUrl, {
        nodeId: this.nodeId,
        connectionId: cid,
        events,
      });
      this._applyReplayResponse(cid, response, events);
      console.log(`[trilc:conn] replay: accepted=${response.accepted} conflicts=${response.conflicts.length}`);
    } catch (err) {
      console.error('[trilc:conn] replay request failed:', err instanceof Error ? err.message : String(err));
    }
  }

  // ── 2.5: State persistence ──

  /** Enable state persistence to {dataDir}/connection-state.json */
  enablePersistence(dataDir: string): void {
    this.stateFile = dataDir.replace(/\\/g, '/') + '/connection-state.json';
    this.restoreState();
    this.persistState();
  }

  private persistState(): void {
    if (!this.stateFile) return;
    try {
      const { mkdirSync, writeFileSync } = require('node:fs');
      const { dirname } = require('node:path');
      const dir = dirname(this.stateFile);
      if (!require('node:fs').existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify({
        state: this.state,
        lastStateChange: new Date().toISOString(),
        consecutiveFailures: this.consecutiveFailures,
        degradedAt: this.degradedAt ? new Date(this.degradedAt).toISOString() : null,
      }, null, 2), { encoding: 'utf-8', mode: 0o600 });
    } catch { /* best-effort */ }
  }

  private restoreState(): void {
    if (!this.stateFile) return;
    try {
      const { existsSync, readFileSync } = require('node:fs');
      if (!existsSync(this.stateFile)) return;
      const raw = readFileSync(this.stateFile, 'utf-8');
      const saved = JSON.parse(raw) as { state?: string; consecutiveFailures?: number; degradedAt?: string };
      if (saved.state && (saved.state === 'connected' || saved.state === 'degraded' || saved.state === 'local')) {
        this.state = saved.state;
        this.consecutiveFailures = saved.consecutiveFailures ?? 0;
        console.log(`[trilc:conn] restored state: ${this.state} (from ${this.stateFile})`);
      }
    } catch { /* ignore corrupt file */ }
  }

  /** 2.5: Get state info for task/submit response notification. */
  getStateInfo(): { connectionState: ConnectionState; warning?: string } {
    if (this.state === 'degraded') {
      return { connectionState: 'degraded', warning: 'TriMC unreachable, using local fallback' };
    }
    if (this.state === 'local') {
      return { connectionState: 'local', warning: 'TriMC not configured, running standalone' };
    }
    return { connectionState: 'connected' };
  }

  // Allow setting connectionId externally (used by createTriLCApp)
  _setConnectionId(id: string): void {
    (this as unknown as { __connectionId: string }).__connectionId = id;
  }
}

function postHeartbeat(baseUrl: string, hb: {
  nodeId: string;
  state: string;
  queueSize: number;
  uptimeSeconds: number;
  agentCoreVersion: string;
}, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const urlObj = new URL('/internal/v1/heartbeat', baseUrl);
    const reqFn = urlObj.protocol === 'https:' ? httpsRequest : httpRequest;
    const body = JSON.stringify(hb);
    const req = reqFn(
      {
        method: 'POST',
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body).toString(),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            resolve(data.ok === true);
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

// ── Post replay events to TriMC ──
// CTO-008-M §3.3.2. Sends queued offline events to TriMC for merge/arbitration.
async function postReplay(
  baseUrl: string,
  payload: { nodeId: string; connectionId: string; events: ReplayEventItem[] },
  timeoutMs = 10_000,
): Promise<ReplayResponse> {
  const urlObj = new URL('/internal/v1/events/replay', baseUrl);
  const reqFn = urlObj.protocol === 'https:' ? httpsRequest : httpRequest;
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = reqFn(
      {
        method: 'POST',
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body).toString(),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch {
            reject(new Error('invalid replay response'));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('replay timeout'));
    });
    req.write(body);
    req.end();
  });
}

// ── Proxy agent request to TriMC ──
// Used as inline logic in the request handler; kept here for potential standalone usage.

// ── Task stream state ──
// In-memory registry of submitted tasks awaiting SSE stream consumption.
// Tasks are created on POST /tasks/submit and executed when SSE client connects.
interface TaskStreamEntry {
  sessionId: string;
  message: string;
  conversationId: string;
  model: string;
  systemPrompt: string;
  context: { files: string[]; workspaceRoot: string };
  createdAt: number;
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
  progress?: { step: number; totalSteps: number; description: string };
}

// ── S7: Mirror helpers ──
// Map TaskStreamEntry status to mirror task status.
function mapStreamStatus(s: TaskStreamEntry['status']): MirrorTaskSnapshot['status'] {
  switch (s) {
    case 'pending':   return 'pending';
    case 'running':   return 'running';
    case 'done':      return 'success';
    case 'error':     return 'failed';
    case 'cancelled': return 'cancelled';
  }
}

function buildSummary(entry: TaskStreamEntry): string {
  if (entry.progress) {
    return `${entry.progress.description} (${entry.progress.step}/${entry.progress.totalSteps})`;
  }
  if (entry.status === 'done') return 'Task completed';
  if (entry.status === 'error') return 'Task failed';
  if (entry.status === 'cancelled') return 'Cancelled by user';
  return entry.message.slice(0, 200);
}

export function createTriLCApp(env: TriLCEnv) {
  let server: Server | null = null;
  let daemonStartTime = 0;
  const eventQueue = createEventQueue({
    dbPath: `${env.dataDir}/event-queue.db`,
  });
  const sessionStore = createSessionStore(`${env.dataDir}/sessions.db`);

  // ── Notifications (REQ-021) ──
  // In-memory + persisted to {dataDir}/notifications.json for client pulls.
  const noticeFile = join(env.dataDir, 'notifications.json');
  const notices: Array<{ id: string; title: string; body: string; context: string; createdAt: string; read: boolean }> = [];
  (async () => {
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(noticeFile, 'utf-8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) notices.push(...arr);
    } catch { /* no file yet */ }
  })();

  // ── Heartbeat Runner ──
  const heartbeatRunner: TriLCHeartbeatRunner = createHeartbeatRunner({
    sessionStore: {
      createSession(s) { sessionStore.createSession(s); },
      saveMessages(id, msgs) { sessionStore.saveMessages(id, msgs as any); },
      updateSessionStatus(id, status) { sessionStore.updateSessionStatus(id, status); },
    },
    cwd: env.cwd,
  });

  // ── Session Reaper ──
  const sessionReaper = createSessionReaper({
    storePath: `${env.dataDir}/sessions.db`,
  });

  // ── Minimal Cron Engine ──
  const cronEngine: MinimalCronEngine = createMinimalCronEngine({
    dataDir: env.dataDir,
    sessionStore: {
      createSession(s) { sessionStore.createSession(s); },
      saveMessages(id, msgs) { sessionStore.saveMessages(id, msgs as any); },
      updateSessionStatus(id, status) { sessionStore.updateSessionStatus(id, status); },
    },
    cwd: env.cwd,
    onJobTrigger(job) {
      publish({ type: 'cron:sweep', count: 1 });
      console.log(`[trilc:cron] job triggered: ${job.name}`);
    },
  });
  const taskStreams = new Map<string, TaskStreamEntry>();
  let connectionId = '';
  const resetConnectionId = () => {
    connectionId = `${env.nodeId}-${Date.now().toString(36)}`;
  };
  resetConnectionId();

  // 2.5: 'local' state when TriMC is not configured
  const isLocal = !env.trimcBaseUrl || env.trimcBaseUrl === 'http://localhost:8710' && !env.trimcBaseUrl;
  const connMgr = new ConnectionManager(env.trimcBaseUrl || 'http://localhost:8710', {
    nodeId: env.nodeId,
    version: env.version,
    initialState: isLocal ? 'local' : undefined,
    queueSize: () => eventQueue.getQueueSize(),
    getPendingForReplay: (cid, limit) => eventQueue.getPendingForReplay(cid, limit),
    applyReplayResponse: (cid, res, events) => eventQueue.applyReplayResponse(cid, res, events),
  });
  connMgr.enablePersistence(env.dataDir);

  // Wire connectionId into ConnectionManager for replay
  connMgr._setConnectionId(connectionId);
  connMgr.onRecovered(() => {
    // On recovery, reset connectionId so replay events are scoped to new session
    resetConnectionId();
    connMgr._setConnectionId(connectionId);
    // S7: Full push on recovery
    mirrorPusher.onReconnected();
  });

  // ── S7: TaskMirrorPusher ──
  // Event-driven task state push to TriMC mirror endpoint.
  // Builds snapshots from taskStreams (in-memory) + sessionStore (persisted).
  const getActiveSnapshots = (): MirrorTaskSnapshot[] => {
    const snapshots: MirrorTaskSnapshot[] = [];

    // ① 从 taskStreams（内存中的活跃/近期任务）
    for (const [id, entry] of taskStreams) {
      snapshots.push({
        taskId: id,
        title: entry.message.slice(0, 80),
        status: mapStreamStatus(entry.status),
        summary: buildSummary(entry),
        updatedAt: new Date(entry.createdAt).toISOString(),
      });
    }

    // ② 从 sessionStore（持久化的 active/interrupted 会话，不在 taskStreams 中）
    const activeSessions = sessionStore.listSessions({ status: 'active', limit: 50 })
      .concat(sessionStore.listSessions({ status: 'interrupted', limit: 50 }));

    for (const s of activeSessions) {
      if (taskStreams.has(s.id)) continue; // 避免重复
      snapshots.push({
        taskId: s.id,
        title: s.title ?? 'Untitled',
        status: s.status === 'interrupted' ? 'failed' : 'running',
        summary: `${s.messageCount} messages`,
        updatedAt: s.updatedAt,
      });
    }

    return snapshots;
  };

  const mirrorPusher = new TaskMirrorPusher(
    env.trimcBaseUrl,
    env.nodeId,
    getActiveSnapshots,
  );

  // S7: Wire degraded → pause mirror push
  localBus.on('event', (event) => {
    if (event.type === 'node:degraded') mirrorPusher.onDegraded();
  });

  // ── ACT2: Update check handler ──
  const updateCheckHandler = createUpdateCheckHandler({
    repo: process.env.TRILC_GITHUB_REPO ?? 'MoRen9527/TriLC',
  });
  let updateCheckLoop: { stop: () => void } | null = null;

  return {
    async start(): Promise<void> {
      daemonStartTime = Date.now();
      connMgr.startHealthCheckLoop();

      // P4.2: Register shell_exec tool backed by ProcessSupervisor
      registerShellExecTool({ supervisor: getDefaultSupervisor() });

      // 2.1/2.2: Post task result back to TriMC when connected or callback URL configured
      const postTaskResultToTriMC = async (
        sessionId: string, status: 'success' | 'failed', result?: string, error?: string,
      ): Promise<void> => {
        const callbackUrl = process.env.TRILC_TRIMC_CALLBACK_URL
          ?? (connMgr.currentState === 'connected' ? `${env.trimcBaseUrl}/internal/v1/tasks/result` : null);
        if (!callbackUrl) return;
        try {
          await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, status, result, error }),
          });
          console.log(`[trilc:task] result posted to TriMC: ${sessionId} status=${status}`);
        } catch (err) {
          console.warn(`[trilc:task] failed to post result to TriMC: ${(err as Error).message}`);
        }
      };

      // Step 2: Set TriModel API URL for HTTP-priority model fetching
      setTrimodelApiUrl(env.trimodelApiUrl);

      // C8: Read default permission mode from CLI/env (backward-compat: bypassPermissions)
      if (process.env.TRILC_PERMISSION_MODE) {
        _defaultPermissionMode = resolvePermissionMode(process.env.TRILC_PERMISSION_MODE);
        console.log(`[trilc] permission mode: ${_defaultPermissionMode} (from TRILC_PERMISSION_MODE)`);
      }

      // C9: Read CLI allow/deny rules, additional dirs, and print mode from env
      _cliAllowRulePatterns = parseRuleListEnv(process.env.TRILC_ALLOW_RULES);
      _cliDenyRulePatterns = parseRuleListEnv(process.env.TRILC_DENY_RULES);
      _cliAdditionalDirs = parseStringListEnv(process.env.TRILC_ADD_DIRS);
      _printMode = process.env.TRILC_PRINT_MODE === '1';

      if (_cliAllowRulePatterns.length > 0 || _cliDenyRulePatterns.length > 0) {
        console.log(`[trilc] CLI rules: ${_cliAllowRulePatterns.length} allow, ${_cliDenyRulePatterns.length} deny`);
      }
      if (_cliAdditionalDirs.length > 0) {
        console.log(`[trilc] additional dirs: ${_cliAdditionalDirs.join(', ')}`);
      }
      if (_printMode) {
        console.log('[trilc] print mode: non-interactive (-p), ask→deny enforced');
        // C9: -p forces non-interactive — if mode is bypass, must switch to default.
        // This is a safety enforcement: bypass mode requires user interaction for
        // safety-flagged tools, which is impossible in print mode.
        if (_defaultPermissionMode === 'bypassPermissions') {
          console.warn('[trilc] print mode: overriding bypassPermissions → default (bypass incompatible with -p)');
          _defaultPermissionMode = 'default';
        }
      }

      // C9: Load persisted permission rules from disk (both allow and deny)
      // and merge with CLI rules. CLI rules take precedence (checked first).
      try {
        const { loadPersistedRules } = await import('../services/permissions/PermissionStore.js');
        _persistedPermissionRules = loadPersistedRules();
        if (_persistedPermissionRules.length > 0) {
          console.log(`[trilc] loaded ${_persistedPermissionRules.length} persisted permission rules from disk`);
        }
      } catch (err) {
        console.warn('[trilc] failed to load persisted permission rules:', (err as Error).message);
      }

      // Step 2b: Initialize provider credentials before accepting model traffic.
      onKeyCacheUpdated(applyKeyCacheToEnvironment);
      await initKeyCache(env.trimodelApiUrl, env.dataDir, process.env.TRIMODEL_API_TOKEN);
      const initialKeyCache = getKeyCache();
      if (initialKeyCache) applyKeyCacheToEnvironment(initialKeyCache);

      // C12: Validate model registry at startup (after key cache → env applied).
      // Checks that fallback-target models are in the registry; WARNING on gaps,
      // never blocks startup. W30: "Unknown model" was a registry gap in prod.
      validateModelRegistry();

      // Phase 2: Initialize contract resolver (load agents from TriCompany)
      const { getContractResolver } = await import('../config/contract-resolver.js');
      const agentCount = await getContractResolver(env.tricompanySourcePath).loadAll();
      console.log(`[trilc] contract resolver: ${agentCount} agents loaded`);

      // Phase 2.1: Load employee roster for display metadata
      const rosterCount = getContractResolver().loadEmployeeRoster();
      console.log(`[trilc] employee roster: ${rosterCount} employees loaded`);

      // Build assistant-facing agent roster (injected into system prompt).
      try {
        const resolver = getContractResolver();
        const lines: string[] = [];
        for (const id of resolver.listAgents()) {
          const rights = resolver.getDecisionRights(id);
          const hasPrompt = !!resolver.getSystemPrompt(id);
          // Use decision_rights to give the model context on what each agent can do
          const can = rights ? Object.entries(rights).filter(([,v]) => Array.isArray(v) && v.length > 0).map(([k]) => k).join('/') : '';
          lines.push(`- **${id}**${can ? ` (${can})` : ''}${hasPrompt ? '' : ''}`);
        }
        cachedAgentRoster = `\n\n## Available Sub-Agents (use AgentTool)\n\n` +
          `These agents are loaded from TriCompany. Use AgentTool with subagent_type set to an agent ID when the user asks to delegate work.\n\n` +
          lines.join('\n') +
          `\n- **code_explorer** — search codebases` +
          `\n- **test_runner** — run tests` +
          `\n- **file_processor** — transform files` +
          `\n- **code_reviewer** — review code` +
          `\n\nWhen the user says "let X handle this" or "have Y check it", find the matching agent above and call AgentTool.`;
      } catch { /* fall through */ }

      server = createServer(async (req, res) => {
        // ── /healthz ──
        if (req.url === '/healthz') {
          const triMcOnline = connMgr.currentState === 'connected';
          const uptime = daemonStartTime > 0
            ? Math.floor((Date.now() - daemonStartTime) / 1000)
            : 0;
          let activeTasks = 0;
          for (const entry of taskStreams.values()) {
            if (entry.status === 'pending' || entry.status === 'running') activeTasks++;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            service: 'trilc',
            serverTime: new Date().toISOString(),
            trimc: triMcOnline ? 'connected' : 'degraded',
            uptime,
            activeTasks,
            queueSize: eventQueue.getQueueSize(),
            version: env.version,
            daemon: {
              mode: process.platform === 'win32' ? 'schtasks' : process.platform === 'darwin' ? 'launchd' : 'systemd',
            },
            heartbeat: {
              enabled: heartbeatRunner.isRunning,
              agentCount: 1, // default heartbeat agent
            },
            cron: {
              enabled: cronEngine.isRunning,
              jobCount: cronEngine.jobCount,
              degraded: cronEngine.isDegraded(),
              consecutiveFailures: cronEngine.consecutiveFailures,
            },
            sessionReaper: {
              enabled: sessionReaper.isRunning(),
            },
          }));
          return;
        }

        // ── GET /v1/models ──
        // Anthropic-compatible model list. Returns models available through TriModel.
        if (req.url === '/v1/models' && req.method === 'GET') {
          const models = await getAvailableModels();
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            data: models.map((m) => ({
              id: m.id,
              type: 'model',
              display_name: m.displayName,
              created_at: m.createdAt,
            })),
          }));
          return;
        }

        // ── GET /internal/v1/agents ──
        // Returns agents loaded from TriCompany .contract.yaml and/or builtin agents.
        // Supports ?scope=company|builtin|all (default: all).
        //   company  — contract-resolver agents only (13 employee contracts + 1 registry)
        //   builtin  — hardcoded builtin agents only (code_explorer, test_runner, file_processor, code_reviewer)
        //   all      — both company and builtin agents merged
        const agentsUrlMatch = req.url?.match(/^\/internal\/v1\/agents(\?.*)?$/);
        if (agentsUrlMatch && req.method === 'GET') {
          const urlObj = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
          const scope = urlObj.searchParams.get('scope') ?? 'all';

          const agents: Array<{
            id: string;
            displayName: string;
            role?: string;
            supervisor?: string;
            description?: string;
            hasSystemPrompt: boolean;
            decisionRights?: { approve: string[]; freeze: string[]; escalate: string[] };
            tools?: Record<string, unknown>;
          }> = [];

          // Company agents (from contract resolver)
          let tricompanyEnabled = false;
          if (scope === 'company' || scope === 'all') {
            try {
              const resolver = getContractResolver();
              const agentIds = resolver.listAgents();
              tricompanyEnabled = agentIds.length > 0;
              for (const id of agentIds) {
                const rights = resolver.getDecisionRights(id);
                const tools = resolver.getToolControl(id);
                const rosterInfo = resolver.getEmployeeInfo(id);
                agents.push({
                  id,
                  displayName: rosterInfo?.displayName ??
                    (typeof tools?.name === 'string' ? tools.name : id),
                  role: rosterInfo?.role,
                  supervisor: rosterInfo?.reportsTo,
                  description: typeof tools?.description === 'string' ? tools.description : undefined,
                  hasSystemPrompt: !!resolver.getSystemPrompt(id),
                  decisionRights: rights,
                  tools,
                });
              }
            } catch {
              // Contract resolver not initialized: skip company agents
            }
          }

          // Builtin agents
          if (scope === 'builtin' || scope === 'all') {
            for (const ba of BUILTIN_AGENTS) {
              agents.push({ ...ba });
            }
          }

          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ agents, count: agents.length, scope, tricompanyEnabled }));
          return;
        }

        // ── GET /internal/v1/agents/{id}/system-prompt ──
        const agentPromptMatch = req.url?.match(/^\/internal\/v1\/agents\/([^/]+)\/system-prompt$/);
        if (agentPromptMatch && req.method === 'GET') {
          try {
            const agentId = decodeURIComponent(agentPromptMatch[1]);
            const systemPrompt = getContractResolver().getSystemPrompt(agentId);
            if (!systemPrompt) {
              res.writeHead(404, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: `agent not found: ${agentId}` }));
              return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, agentId, systemPrompt }));
          } catch (error) {
            const message = error instanceof URIError ? 'invalid agent id' : 'contract resolver not initialized';
            res.writeHead(error instanceof URIError ? 400 : 500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: message }));
          }
          return;
        }

        // ── GET /internal/v1/interactions/pending ──
        // P3: TUI polls this while a request is in flight to discover
        // AskUserQuestion / permission prompts awaiting user input.
        if (req.url === '/internal/v1/interactions/pending' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, pending: getPendingInteraction() }));
          return;
        }

        // ── POST /internal/v1/interactions/answer ──
        // P3: TUI posts the user's response. Body: { id, response }.
        // question → response: { answers: Record<string,string>, cancelled?: boolean }
        // permission → response: 'allow' | 'deny' | 'always'
        if (req.url === '/internal/v1/interactions/answer' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: { id?: string; response?: unknown } = {};
          try {
            body = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
            return;
          }
          if (!body.id) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'id is required' }));
            return;
          }
          const answered = answerInteraction(body.id, body.response);
          if (!answered) {
            res.writeHead(409, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'stale_or_missing_interaction' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // ── POST /v1/messages ──
        // Anthropic Messages API compatible endpoint.
        // Accepts: model, messages, system, max_tokens, stream, tools
        // Returns: SSE stream (stream: true) or JSON response
        if (req.url === '/v1/messages' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');

          let parsed: AnthropicRequest;
          try {
            parsed = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } }));
            return;
          }

          const model = parsed.model ?? 'tmv-deepseek-v4-pro';
          // Step 4: End-to-end verification — log received model parameter
          console.log(`[trilc] /v1/messages model=${model}`);
          const maxTurns = parsed.max_tokens ? Math.min(Math.ceil(parsed.max_tokens / 100), 25) : 25;

          // P3: interactive opt-in — the TUI sets interactive:true, enabling
          // AskUserQuestion waiting and permission prompts for this request.
          // res 'close' fires on every completion path (stream end, JSON end,
          // error, client disconnect), guaranteeing the session is ended.
          const isInteractive = parsed.interactive === true;
          if (isInteractive) {
            beginInteractiveSession();
            res.on('close', () => endInteractiveSession());
          }

          // Convert Anthropic messages to internal Message format
          const internalMessages: Message[] = convertAnthropicMessages(parsed.messages ?? []);

          // Register tools from request (if any)
          const toolDefs = convertAnthropicTools(parsed.tools ?? []);
          const toolNames: string[] = [];
          for (const tool of toolDefs) {
            registerTool(tool, async (_args: Record<string, unknown>) => {
              // Tool execution is done by TriPilot client; here we return a placeholder
              // indicating that the tool should be executed client-side.
              return JSON.stringify({ _trilc_note: 'tool execution delegated to TriPilot client' });
            });
            toolNames.push(tool.function.name);
          }

          const effectivePermissionMode = resolvePermissionMode(parsed.permission_mode) as PermissionMode;
          // C9: Build combined permission rules (CLI + persisted + interactive)
          const sessionRules = buildSessionPermissionRules();
          const mergedPermissionRules: PermissionRule[] = [
            ...sessionRules,
            // P3: interactive requests inject ask rules for dangerous tools
            ...(isInteractive && !_printMode ? INTERACTIVE_ASK_RULES : []),
          ];

          const loopOptions: AgentLoopOptions = {
            model,
            systemPrompt: parsed.system || defaultSystemPrompt(),
            messages: internalMessages,
            maxTurns,
            tier: 'main',
            cwd: env.cwd,
            // C8: Use resolved permission mode (from request body or env default)
            permissionMode: effectivePermissionMode,
            permissionRules: mergedPermissionRules.length > 0 ? mergedPermissionRules : undefined,
            // C9: Additional directories from CLI --add-dir
            additionalDirectories: _cliAdditionalDirs.length > 0 ? _cliAdditionalDirs : undefined,
            // P3: interactive requests get the TUI permission bridge;
            // C9: print mode (-p) disables onPermissionAsk (non-interactive — ask→deny).
            ...(isInteractive && !_printMode
              ? { onPermissionAsk: askPermissionViaTui }
              : {}),
            // P7: Plan mode tool gating via deps.checkToolPermission
            deps: buildPlanModeDeps(),
          };
          const wantsStream = parsed.stream !== false;

          if (wantsStream) {
            // ── Anthropic SSE streaming ──
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              'connection': 'keep-alive',
              'x-accel-buffering': 'no',
            });

          let streamedContent = false;
          let streamedToolCalls = false;

          try {
            await agentEventsToAnthropicSSE(agentLoop(loopOptions), {
              model,
              onSSE: (eventType, data) => {
                if (eventType === 'content_block_delta' || eventType === 'message_delta') {
                  streamedContent = true;
                } else if (eventType === 'content_block_start') {
                  streamedToolCalls = true;
                }
                res.write(formatSSELine(eventType, data));
              },
            });

            // ── Post-stream guard: warn if nothing meaningful was emitted ──
            if (!streamedContent && !streamedToolCalls) {
              res.write(formatSSELine('message_stop', {
                type: 'message_stop',
                warning: 'No content or tool calls were emitted (possible reasoning-only response)',
              }));
            }
          } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              res.write(formatSSELine('error', {
                type: 'error',
                error: { type: 'api_error', message: msg },
              }));
            }
            res.end();
            return;
          }

          // ── JSON mode (non-streaming) ──
          const allEvents: AgentEvent[] = [];
          let finalContent = '';
          const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
          let usageSummary: UsageSummary | null = null;

          try {
            for await (const event of agentLoop(loopOptions)) {
              allEvents.push(event);
              if (event.type === 'content_delta') {
                finalContent += event.delta;
              } else if (event.type === 'assistant_message') {
                if (!finalContent && event.content) finalContent = event.content;
                if (event.tool_calls) {
                  for (const tc of event.tool_calls) {
                    toolCalls.push({
                      id: tc.id,
                      type: 'function' as const,
                      function: { name: tc.function.name, arguments: tc.function.arguments },
                    });
                  }
                }
              } else if (event.type === 'loop_end' && event.usageSummary) {
                usageSummary = event.usageSummary;
              }
            }

            // ── Message guard: reject empty assistant responses ──
            // Prevents "空头" — DeepSeek reasoning_content-only messages
            // that have neither content nor tool_calls.
            const guardResult: GuardResult = validateMessage({
              role: 'assistant',
              content: finalContent || null,
              tool_calls: toolCalls.length > 0
                ? toolCalls.map((tc) => ({ id: tc.id, type: 'function' as const, function: tc.function }))
                : undefined,
            });
            if (!guardResult.allowed) {
              res.writeHead(422, { 'content-type': 'application/json' });
              res.end(JSON.stringify({
                type: 'error',
                error: { type: 'empty_response', message: `Message rejected: ${guardResult.reason}` },
              }));
              return;
            }

            const content = toolCalls.length > 0
              ? [{ type: 'text' as const, text: finalContent }, ...toolCalls.map((tc) => ({
                  type: 'tool_use' as const,
                  id: tc.id,
                  name: tc.function.name,
                  input: safeJsonParse(tc.function.arguments),
                }))]
              : [{ type: 'text' as const, text: finalContent }];

            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              id: `msg_${Date.now().toString(36)}`,
              type: 'message',
              role: 'assistant',
              content,
              model,
              stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
              stop_sequence: null,
              usage: {
                input_tokens: usageSummary?.tokens?.prompt_tokens ?? 0,
                output_tokens: usageSummary?.tokens?.completion_tokens ?? 0,
              },
            }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              type: 'error',
              error: { type: 'api_error', message: msg },
            }));
          }
          // ── Session auto-save (Anthropic JSON mode) ──
          // Persist the full conversation for recovery after abnormal interruption.
          try {
            const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
            sessionStore.createSession({
              id: sessionId,
              model,
              systemPrompt: parsed.system || undefined,
              cwd: env.cwd,
            });
            const allMsgs: Array<{
              role: 'user' | 'assistant' | 'system' | 'tool';
              content: string | null;
              toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
              reasoningContent?: string | null;
            }> = [];
            for (const msg of internalMessages) {
              allMsgs.push({
                role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
                content: typeof msg.content === 'string' ? msg.content : null,
                toolCalls: msg.tool_calls?.map((tc) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: { name: tc.function.name, arguments: tc.function.arguments },
                })),
                reasoningContent: (msg as unknown as Record<string, unknown>).reasoning_content as string | undefined,
              });
            }
            // Add final assistant message
            allMsgs.push({
              role: 'assistant',
              content: finalContent || null,
              toolCalls: toolCalls.length > 0
                ? toolCalls.map((tc) => ({ id: tc.id, type: 'function' as const, function: tc.function }))
                : undefined,
            });
            sessionStore.saveMessages(sessionId, allMsgs);
            sessionStore.updateSessionStatus(sessionId, 'completed');
          } catch (saveErr) {
            console.warn('[trilc:session] failed to save session:', (saveErr as Error).message);
          }

          return;
        }

        // ── POST /internal/v1/agent ──
        if (req.url?.startsWith('/internal/v1/agent') && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');

          // Validate body is parseable JSON before proxying
          let parsed: {
            model?: string;
            systemPrompt?: string;
            messages?: Message[];
            maxTurns?: number;
            tier?: AgentTier;
            cwd?: string;
            permissionMode?: PermissionMode;
            permissionRules?: PermissionRule[];
          };
          try {
            parsed = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_json' }));
            return;
          }

          const urlObj = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
          const queryString = urlObj.search; // e.g. ?stream=true

          // ── Proxy to TriMC if connected ──
          if (connMgr.currentState === 'connected') {
            try {
              // Use a flag tracked via a simple wrapper to detect proxy failure
              await new Promise<void>((resolve, reject) => {
                const trimcUrl = new URL(`/internal/v1/agent${queryString}`, env.trimcBaseUrl);
                const reqFn = trimcUrl.protocol === 'https:' ? httpsRequest : httpRequest;

                const proxyReq = reqFn(
                  {
                    method: 'POST',
                    hostname: trimcUrl.hostname,
                    port: trimcUrl.port,
                    path: trimcUrl.pathname + trimcUrl.search,
                    headers: {
                      'content-type': 'application/json',
                      'content-length': Buffer.byteLength(raw).toString(),
                      'accept': req.headers.accept ?? 'application/json',
                      'x-trilc-node-id': env.nodeId,
                      'x-trilc-version': env.version,
                      'x-trilc-connection-id': connectionId,
                    },
                    timeout: 30_000,
                  },
                  (proxyRes) => {
                    connMgr.recordSuccess();
                    res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
                    proxyRes.pipe(res);
                    resolve();
                  },
                );

                proxyReq.on('error', (err) => {
                  connMgr.recordFailure();
                  reject(err);
                });
                proxyReq.on('timeout', () => {
                  proxyReq.destroy();
                  connMgr.recordFailure();
                  reject(new Error('timeout'));
                });
                proxyReq.write(raw);
                proxyReq.end();
              });
              return; // Successfully proxied
            } catch {
              // TriMC unreachable — fall through to local agentLoop
              console.log('[trilc] trimc unreachable, using local agentLoop');
            }
          }

          // ── Local agentLoop fallback ──
          const loopOptions: AgentLoopOptions = {
            model: parsed.model ?? 'tmv-deepseek-v4-pro',
            systemPrompt: parsed.systemPrompt ?? '',
            messages: parsed.messages ?? [],
            maxTurns: parsed.maxTurns ?? 25,
            tier: parsed.tier ?? 'main',
            cwd: parsed.cwd ?? env.cwd,
            permissionMode: parsed.permissionMode,
            permissionRules: parsed.permissionRules,
            // P7: Plan mode tool gating via deps.checkToolPermission
            deps: buildPlanModeDeps(),
          };

          const wantsSSE =
            queryString.includes('stream=true') ||
            req.headers.accept?.includes('text/event-stream');

          if (wantsSSE) {
            // ── SSE streaming mode ──
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              'connection': 'keep-alive',
              'x-accel-buffering': 'no',
            });

            const writeSSE = (eventType: string, data: object) => {
              res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
            };

            try {
              for await (const event of agentLoop(loopOptions)) {
                writeSSE(event.type, event);
              }
              res.write('data: [DONE]\n\n');
              res.end();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              writeSSE('error', { type: 'error', message: msg });
              res.write('data: [DONE]\n\n');
              res.end();
            }
            return;
          }

          // ── JSON mode ──
          const events: AgentEvent[] = [];
          try {
            for await (const event of agentLoop(loopOptions)) {
              events.push(event);
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: true,
                turns:
                  events.filter((e) => e.type === 'loop_end').length > 0
                    ? 'completed'
                    : 'no_turns',
                events,
              }),
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'agent_error', message: msg, events }));
          }
          return;
        }

        // ── GET /models (OpenAI-compatible) ──
        // Returns model list in OpenAI format for opencode / Vercel AI SDK.
        if (req.url === '/models' && req.method === 'GET') {
          const models = await getAvailableModels();
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            object: 'list',
            data: models.map((m) => ({
              id: m.id,
              object: 'model',
              created: Math.floor(new Date(m.createdAt).getTime() / 1000),
              owned_by: 'trilc',
            })),
          }));
          return;
        }

        // ── POST /chat/completions (OpenAI-compatible) ──
        // OpenAI Chat Completions API compatible endpoint.
        // Converts OpenAI format → internal → agentLoop → OpenAI SSE/JSON output.
        // Used by opencode custom provider (Vercel AI SDK @ai-sdk/openai-compatible).
        if (req.url === '/chat/completions' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');

          let parsed: OpenAIRequest;
          try {
            parsed = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON' } }));
            return;
          }

          const model = parsed.model ?? 'tmv-deepseek-v4-pro';
          const maxTurns = parsed.max_tokens ? Math.min(Math.ceil(parsed.max_tokens / 100), 25) : 25;

          // Convert OpenAI messages to internal format
          const { systemPrompt: oaiSystem, internalMessages } = convertOpenAIMessages(parsed.messages ?? []);

          // Register tools from request (if any)
          const toolDefs = convertOpenAITools(parsed.tools ?? []);
          const toolNames: string[] = [];
          for (const tool of toolDefs) {
            registerTool(tool, async (_args: Record<string, unknown>) => {
              return JSON.stringify({ _trilc_note: 'tool execution delegated to client' });
            });
            toolNames.push(tool.function.name);
          }

          const oaiPermissionMode = resolvePermissionMode(parsed.permission_mode) as PermissionMode;
          const oaiSessionRules = buildSessionPermissionRules();

          const loopOptions: AgentLoopOptions = {
            model,
            systemPrompt: oaiSystem || defaultSystemPrompt(),
            messages: internalMessages,
            maxTurns,
            tier: 'main',
            cwd: env.cwd,
            // C8: Use resolved permission mode
            permissionMode: oaiPermissionMode,
            permissionRules: oaiSessionRules.length > 0 ? oaiSessionRules : undefined,
            // C9: Additional directories from CLI --add-dir
            additionalDirectories: _cliAdditionalDirs.length > 0 ? _cliAdditionalDirs : undefined,
            // P7: Plan mode tool gating via deps.checkToolPermission
            deps: buildPlanModeDeps(),
          };

          const wantsStream = parsed.stream !== false;

          if (wantsStream) {
            // ── OpenAI SSE streaming ──
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              'connection': 'keep-alive',
              'x-accel-buffering': 'no',
            });

            try {
              await agentEventsToOpenAISSE(agentLoop(loopOptions), {
                model,
                onSSE: (data) => {
                  res.write(formatOpenAISSE(data));
                },
              });
              res.write(OPENAI_SSE_DONE);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              res.write(formatOpenAISSE({
                error: { type: 'api_error', message: msg },
              }));
              res.write(OPENAI_SSE_DONE);
            }
            res.end();
            return;
          }

          // ── JSON mode (non-streaming) ──
          let finalContent = '';
          const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
          let usageSummary: UsageSummary | null = null;

          try {
            for await (const event of agentLoop(loopOptions)) {
              if (event.type === 'content_delta') {
                finalContent += event.delta;
              } else if (event.type === 'assistant_message') {
                if (!finalContent && event.content) finalContent = event.content;
                if (event.tool_calls) {
                  for (const tc of event.tool_calls) {
                    toolCalls.push({
                      id: tc.id,
                      type: 'function' as const,
                      function: { name: tc.function.name, arguments: tc.function.arguments },
                    });
                  }
                }
              } else if (event.type === 'loop_end' && event.usageSummary) {
                usageSummary = event.usageSummary;
              }
            }

            // Message guard: reject empty responses
            const guardResult: GuardResult = validateMessage({
              role: 'assistant',
              content: finalContent || null,
              tool_calls: toolCalls.length > 0
                ? toolCalls.map((tc) => ({ id: tc.id, type: 'function' as const, function: tc.function }))
                : undefined,
            });
            if (!guardResult.allowed) {
              res.writeHead(422, { 'content-type': 'application/json' });
              res.end(JSON.stringify({
                error: { type: 'empty_response', message: `Message rejected: ${guardResult.reason}` },
              }));
              return;
            }

            const choice: Record<string, unknown> = {
              index: 0,
              message: {
                role: 'assistant',
                content: finalContent || null,
              },
              finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
            };

            if (toolCalls.length > 0) {
              (choice.message as Record<string, unknown>).tool_calls = toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.function.name,
                  arguments: tc.function.arguments,
                },
              }));
            }

            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              id: `chatcmpl-${Date.now().toString(36)}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [choice],
              usage: {
                prompt_tokens: usageSummary?.tokens?.prompt_tokens ?? 0,
                completion_tokens: usageSummary?.tokens?.completion_tokens ?? 0,
                total_tokens: (usageSummary?.tokens?.prompt_tokens ?? 0) + (usageSummary?.tokens?.completion_tokens ?? 0),
              },
            }));

            // ── Session auto-save (OpenAI JSON mode) ──
            try {
              const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
              sessionStore.createSession({
                id: sessionId,
                model,
                systemPrompt: oaiSystem || defaultSystemPrompt(),
                cwd: env.cwd,
              });
              const allMsgs: Array<{
                role: 'user' | 'assistant' | 'system' | 'tool';
                content: string | null;
                toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
                reasoningContent?: string | null;
              }> = [];
              for (const msg of internalMessages) {
                allMsgs.push({
                  role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
                  content: typeof msg.content === 'string' ? msg.content : null,
                  toolCalls: msg.tool_calls?.map((tc) => ({
                    id: tc.id,
                    type: 'function' as const,
                    function: { name: tc.function.name, arguments: tc.function.arguments },
                  })),
                  reasoningContent: (msg as unknown as Record<string, unknown>).reasoning_content as string | undefined,
                });
              }
              allMsgs.push({
                role: 'assistant',
                content: finalContent || null,
                toolCalls: toolCalls.length > 0
                  ? toolCalls.map((tc) => ({ id: tc.id, type: 'function' as const, function: tc.function }))
                  : undefined,
              });
              sessionStore.saveMessages(sessionId, allMsgs);
              sessionStore.updateSessionStatus(sessionId, 'completed');
            } catch (saveErr) {
              console.warn('[trilc:session] failed to save session:', (saveErr as Error).message);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              error: { type: 'api_error', message: msg },
            }));
          }
          return;
        }

        // ── POST /internal/v1/sessions ──
        // Saves a TUI chat session: creates or appends messages to an existing session.
        // Body: { sessionId?: string, model?: string, messages: [{ role, content }] }
        // If sessionId is omitted, a new one is created.
        if (req.url === '/internal/v1/sessions' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: {
            sessionId?: string;
            model?: string;
            title?: string;
            messages?: Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string | null }>;
          } = {};
          try {
            body = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
            return;
          }

          try {
            let sessionId = body.sessionId;
            if (!sessionId || !sessionStore.getSession(sessionId)) {
              sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
              sessionStore.createSession({
                id: sessionId,
                model: body.model ?? 'tmv-deepseek-v4-flash',
                systemPrompt: defaultSystemPrompt(),
                cwd: env.cwd,
                title: body.title,
              });
            }

            if (body.messages && body.messages.length > 0) {
              sessionStore.saveMessages(sessionId!, body.messages);
              sessionStore.updateSessionStatus(sessionId!, 'active');
            }

            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, sessionId }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: msg }));
          }
          return;
        }

        // ── GET /internal/v1/sessions/{id} ──
        // Returns a single session with its messages.
        if (req.url?.startsWith('/internal/v1/sessions/') && !req.url.endsWith('/stream') && !req.url.endsWith('/cancel') && !req.url.endsWith('/fork') && req.method === 'GET') {
          const sessionIdMatch = req.url.match(/^\/internal\/v1\/sessions\/([^/]+)$/);
          if (sessionIdMatch) {
            const sessionId = sessionIdMatch[1];
            const session = sessionStore.getSession(sessionId);
            if (!session) {
              res.writeHead(404, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'not_found', message: `Session ${sessionId} not found` }));
              return;
            }
            const messages = sessionStore.getMessages(sessionId);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, session, messages }));
            return;
          }
        }

        // ── POST /internal/v1/sessions/{id}/fork (P6) ──
        // Forks a conversation session: copies all messages to a new session ID.
        // CC equivalent: /branch command (session transcript fork, not git worktree).
        if (req.url?.startsWith('/internal/v1/sessions/') && req.url.endsWith('/fork') && req.method === 'POST') {
          const forkMatch = req.url.match(/^\/internal\/v1\/sessions\/(.+)\/fork$/);
          if (forkMatch) {
            const originalId = forkMatch[1];
            const original = sessionStore.getSession(originalId);
            if (!original) {
              res.writeHead(404, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'not_found', message: `Session ${originalId} not found` }));
              return;
            }
            const messages = sessionStore.getMessages(originalId);
            if (messages.length === 0) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'empty', message: 'No messages to fork' }));
              return;
            }
            const { randomUUID } = await import('node:crypto');
            const forkId = randomUUID();
            const forkedTitle = (original.title ?? 'Branched conversation') + ' (Branch)';
            sessionStore.createSession({
              id: forkId,
              model: original.model,
              systemPrompt: original.systemPrompt,
              cwd: original.cwd,
              title: forkedTitle,
            });
            sessionStore.saveMessages(forkId, messages.map(m => ({
              role: m.role,
              content: m.content,
              toolCalls: m.toolCalls ? JSON.parse(m.toolCalls) : null,
              toolCallId: m.toolCallId,
              reasoningContent: m.reasoningContent,
            })));
            console.log(`[trilc] forked session ${originalId.slice(0,12)} → ${forkId.slice(0,12)} (${messages.length} messages)`);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              originalId,
              sessionId: forkId,
              title: forkedTitle,
              messageCount: messages.length,
            }));
            return;
          }
        }

        // ── POST /internal/v1/sessions/recover ──
        // Recovers an interrupted session with optional work-tree safety check.
        // Body: { sessionId?: string } — if omitted, recovers the most recent interrupted session.
        // Response: RecoveryResult with session, messages, and safety report.
        if (req.url === '/internal/v1/sessions/recover' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: { sessionId?: string; includeSafetyCheck?: boolean } = {};
          try {
            body = JSON.parse(raw);
          } catch {
            // empty body is OK — recover most recent
          }

          const targetId = body.sessionId;
          let session: SessionRecord | null = null;
          let messages: SessionMessageRecord[] | null = null;
          const warnings: string[] = [];

          if (targetId) {
            session = sessionStore.getSession(targetId);
            if (session) {
              messages = sessionStore.getMessages(targetId);
            }
          } else {
            // Find most recent interrupted/active session
            const interrupted = sessionStore.findInterruptedSessions();
            if (interrupted.length > 0) {
              session = interrupted[0];
              messages = sessionStore.getMessages(session.id);
            }
          }

          if (!session) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              ok: false,
              session: null,
              messages: null,
              safetyReport: null,
              warnings: ['No recoverable session found'],
            }));
            return;
          }

          // Check for empty assistant messages in the session
          if (messages) {
            const emptyAssistants = messages.filter(
              (m) => m.role === 'assistant' && !m.content && !m.toolCalls,
            );
            if (emptyAssistants.length > 0) {
              warnings.push(
                `Found ${emptyAssistants.length} empty assistant message(s) (no content, no tool_calls). ` +
                'These may cause 400 errors on DeepSeek reasoning models. Consider filtering before retry.',
              );
            }
          }

          // Run work-tree safety check
          const safetyReport = body.includeSafetyCheck !== false
            ? runSafetyCheck(session.cwd || env.cwd)
            : { cwd: env.cwd, hasUncommittedChanges: false, changedFiles: [], typeCheckPassed: null, riskLevel: 'low' as const };

          if (safetyReport.riskLevel === 'high') {
            warnings.push('Work-tree has type errors — resolve before continuing agent work');
          } else if (safetyReport.riskLevel === 'medium') {
            warnings.push(`Work-tree has ${safetyReport.changedFiles.length} uncommitted changes — review before continuing`);
          }

          // Mark session as interrupted so it can be recovered again
          sessionStore.updateSessionStatus(session.id, 'interrupted');

          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            session,
            messages,
            safetyReport,
            warnings,
          }));
          return;
        }


        // ── POST /internal/v1/tasks/submit ──
        // W30 S2: Submit user intent → returns sessionId + SSE stream endpoint.
        // Body: { message, conversationId, systemPrompt?, context? }
        // Response 201: { sessionId, streamEndpoint, status }
        if (req.url === '/internal/v1/tasks/submit' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');

          let body: {
            message?: string;
            conversationId?: string;
            systemPrompt?: string;
            context?: { files?: string[]; workspaceRoot?: string };
          } = {};
          try {
            body = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_json', message: 'Request body must be valid JSON' }));
            return;
          }

          if (!body.message || !body.message.trim()) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'bad_request', message: 'message is required' }));
            return;
          }

          const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
          const model = getKeyCache()?.defaultModel ?? process.env.TRIMODEL_DEFAULT_MODEL ?? 'tmv-deepseek-v4-pro';
          const entry: TaskStreamEntry = {
            sessionId,
            message: body.message.trim(),
            conversationId: body.conversationId ?? `conv_${Date.now().toString(36)}`,
            model,
            systemPrompt: body.systemPrompt ?? defaultSystemPrompt(),
            context: {
              files: body.context?.files ?? [],
              workspaceRoot: body.context?.workspaceRoot ?? env.cwd,
            },
            createdAt: Date.now(),
            status: 'pending',
          };
          taskStreams.set(sessionId, entry);

          // S7: Publish task:queued for mirror pusher
          publish({ type: 'task:queued', taskId: sessionId });

          // Persist session for recovery
          try {
            sessionStore.createSession({
              id: sessionId,
              model: entry.model,
              systemPrompt: entry.systemPrompt,
              cwd: entry.context.workspaceRoot,
            });
          } catch (saveErr) {
            console.warn('[trilc:task] failed to persist session:', (saveErr as Error).message);
          }

          // 2.5: Include connection state in task submission response
          const connInfo = connMgr.getStateInfo();
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            sessionId,
            streamEndpoint: `/internal/v1/sessions/${sessionId}/stream`,
            status: 'running',
            connectionState: connInfo.connectionState,
            ...(connInfo.warning ? { warning: connInfo.warning } : {}),
          }));
          return;
        }

        // ── SSE GET /internal/v1/sessions/{id}/stream ──
        // W30 S2: Real-time SSE stream of LLM output + tool call status.
        // Event types: delta, tool_use, tool_result, task_progress, task_done, task_error
        if (req.url?.startsWith('/internal/v1/sessions/') && req.url.endsWith('/stream') && req.method === 'GET') {
          const sessionId = req.url.split('/')[4]; // /internal/v1/sessions/{id}/stream
          const entry = taskStreams.get(sessionId);

          if (!entry) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'not_found', message: `No task found for session ${sessionId}` }));
            return;
          }

          // SSE headers
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
            'x-accel-buffering': 'no',
          });

          const writeSSE = (eventType: string, data: object) => {
            res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
          };

          // Mark running
          entry.status = 'running';
          // S7: Publish task:running for mirror pusher
          publish({ type: 'task:running', taskId: sessionId });

          // Build agentLoop options from task entry
          const cwd = entry.context.workspaceRoot || env.cwd;
          const messages: Message[] = [{ role: 'user', content: entry.message }];
          const systemPrompt = entry.systemPrompt || defaultSystemPrompt();

          // C12: Pre-validate model against registry before starting agent loop.
          // W30 lesson: fallback chain end must be in listModels() — if the model
          // isn't registered, fail immediately with a clear task_error instead of
          // letting agentLoop hit "Unknown model" downstream.
          const modelCheck = validateModelAgainstRegistry(entry.model);
          if (!modelCheck.valid) {
            const errDetail = modelCheck.error ?? `Model "${entry.model}" not available`;
            console.error(`[trilc:model] CRITICAL: model not in registry for task=${sessionId}: ${errDetail}`);
            entry.status = 'error';
            publish({ type: 'task:failed', taskId: sessionId, error: errDetail });
            writeSSE('task_error', { status: 'failed', error: errDetail });
            try { sessionStore.updateSessionStatus(sessionId, 'error'); } catch { /* ignore */ }
            res.end();
            return;
          }

          try {
            // Track tool states for progress reporting
            let toolCount = 0;
            let deltaContent = '';
            let terminalError: string | undefined;

            const taskSessionRules = buildSessionPermissionRules();
            for await (const event of runCompactingAgentLoop({
              model: entry.model,
              systemPrompt,
              messages,
              maxTurns: 25,
              tier: 'main',
              cwd,
              permissionMode: _defaultPermissionMode as PermissionMode,
              permissionRules: taskSessionRules.length > 0 ? taskSessionRules : undefined,
              additionalDirectories: _cliAdditionalDirs.length > 0 ? _cliAdditionalDirs : undefined,
              // C9: -p print mode: no onPermissionAsk (non-interactive — ask→deny)
              ...(_printMode ? {} : {}),
            })) {
              // C13: Stop processing if we already sent a terminal error.
              // W30 lesson: never send task_done after task_error.
              if (terminalError) break;

              // Map agent events to W30 SSE event types
              switch (event.type as string) {
                case 'content_delta': {
                  deltaContent += (event as any).delta ?? '';
                  writeSSE('delta', { content: (event as any).delta ?? '' });
                  break;
                }
                case 'tool_call': {
                  toolCount++;
                  const tc = event as any;
                  writeSSE('tool_use', {
                    toolName: tc.name ?? tc.tool_name ?? 'unknown',
                    input: tc.input ?? tc.arguments ?? {},
                  });
                  // Update progress
                  entry.progress = {
                    step: toolCount,
                    totalSteps: toolCount + 1, // estimate
                    description: `Calling tool: ${tc.name ?? 'unknown'}`,
                  };
                  writeSSE('task_progress', entry.progress);
                  break;
                }
                case 'tool_result': {
                  const tr = event as any;
                  writeSSE('tool_result', {
                    toolName: tr.name ?? tr.tool_name ?? 'unknown',
                    output: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result ?? ''),
                    durationMs: tr.durationMs ?? 0,
                  });
                  break;
                }
                case 'assistant_message': {
                  const am = event as any;
                  if (am.content && !deltaContent) {
                    writeSSE('delta', { content: am.content });
                  }
                  break;
                }
                case 'loop_start': {
                  // Forward loop_start metadata to SSE clients
                  break;
                }
                case 'recovery': {
                  const rec = event as any;
                  if (rec.tier === 2) {
                    console.log(`[trilc:model] degraded to fallback model: ${rec.message}`);
                  }
                  break;
                }
                case 'compaction': {
                  const comp = event as any;
                  console.log(`[trilc:compact] ${comp.message}`);
                  writeSSE('task_progress', {
                    step: toolCount,
                    totalSteps: toolCount + 1,
                    description: comp.message ?? 'Compacting conversation...',
                  });
                  break;
                }
                case 'compaction_failed': {
                  console.warn(`[trilc:compact] failed: ${(event as any).message}`);
                  break;
                }
                case 'compaction_done': {
                  // handled by compaction case above (combined progress reporting)
                  break;
                }
                case 'loop_end': {
                  // Will be handled after the loop
                  break;
                }
                case 'error': {
                  const err = event as any;
                  const errorMessage = err.message ?? String(err);
                  terminalError = errorMessage;
                  // C13/R3: all providers exhausted — agent-core has already
                  // attempted Tier 1 (retry) and Tier 2 (fallback model) recovery.
                  console.error(`[trilc:model] CRITICAL: all providers exhausted for task=${sessionId}: ${errorMessage}`);
                  writeSSE('task_error', {
                    status: 'failed',
                    error: errorMessage,
                  });
                  entry.status = 'error';
                  // S7: Publish task:failed for mirror pusher
                  publish({ type: 'task:failed', taskId: sessionId, error: errorMessage });
                  break;
                }
                default: {
                  // Forward unknown events as generic
                  break;
                }
              }
            }

            if (terminalError) {
              try {
                sessionStore.updateSessionStatus(sessionId, 'error');
              } catch {
                // ignore
              }
              res.end();
              return;
            }

            // C13: Post-loop guard — if the loop completed without any content delta
            // AND without any tool calls, this is a pseudo-success. Treat as error.
            // W30 lesson: provider 全挂时可能静默返回空内容，绝不能发伪 task_done。
            const producedAnyOutput = deltaContent.length > 0 || toolCount > 0;
            if (!producedAnyOutput) {
              const emptyError = 'Model loop completed without any content or tool calls — possible provider failure or empty reasoning-only response';
              console.error(`[trilc:model] CRITICAL: all providers exhausted for task=${sessionId}: ${emptyError}`);
              entry.status = 'error';
              publish({ type: 'task:failed', taskId: sessionId, error: emptyError });
              writeSSE('task_error', { status: 'failed', error: emptyError });
              try { sessionStore.updateSessionStatus(sessionId, 'error'); } catch { /* ignore */ }
              res.end();
              return;
            }

            // Task completed successfully
            entry.status = 'done';
            // S7: Publish task:succeeded for mirror pusher
            publish({ type: 'task:succeeded', taskId: sessionId, result: { summary: deltaContent.slice(0, 200) } });
            writeSSE('task_done', {
              status: 'success',
              summary: deltaContent
                ? deltaContent.slice(0, 200) + (deltaContent.length > 200 ? '...' : '')
                : 'Task completed',
            });

            // 2.1/2.2: Post result back to TriMC
            postTaskResultToTriMC(sessionId, 'success', deltaContent || undefined).catch(() => {});

            // Persist session as completed
            try {
              sessionStore.saveMessages(sessionId, [
                { role: 'user', content: entry.message },
                { role: 'assistant', content: deltaContent || 'Task completed' },
              ]);
              sessionStore.updateSessionStatus(sessionId, 'completed');
            } catch (saveErr) {
              console.warn('[trilc:sse] failed to save session:', (saveErr as Error).message);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[trilc:model] CRITICAL: all providers exhausted for task=${sessionId}: ${msg}`);
            entry.status = 'error';
            publish({ type: 'task:failed', taskId: sessionId, error: msg });
            writeSSE('task_error', { status: 'failed', error: msg });
            // 2.1/2.2: Post failure result back to TriMC
            postTaskResultToTriMC(sessionId, 'failed', undefined, msg).catch(() => {});

            try {
              sessionStore.updateSessionStatus(sessionId, 'error');
            } catch {
              // ignore
            }
          }

          // Cleanup
          res.end();
          return;
        }

        // ── POST /internal/v1/sessions/{id}/cancel ──
        // W30 S4: Cancel a running task. Marks session as cancelled and aborts SSE stream.
        if (req.url?.startsWith('/internal/v1/sessions/') && req.url.endsWith('/cancel') && req.method === 'POST') {
          const sessionId = req.url.split('/')[4]; // /internal/v1/sessions/{id}/cancel

          // Check in-memory task streams
          const entry = taskStreams.get(sessionId);
          if (entry && (entry.status === 'pending' || entry.status === 'running')) {
            entry.status = 'cancelled';
            // S7: Publish task:cancelled for mirror pusher
            publish({ type: 'task:cancelled', taskId: sessionId });
          }

          // Update persistent session store
          try {
            const session = sessionStore.getSession(sessionId);
            if (session) {
              sessionStore.updateSessionStatus(sessionId, 'interrupted');
            } else {
              res.writeHead(404, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'not_found', message: `Session ${sessionId} not found` }));
              return;
            }
          } catch {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'not_found', message: `Session ${sessionId} not found` }));
            return;
          }

          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, sessionId, status: 'cancelled' }));
          return;
        }

        // ── GET /internal/v1/sessions ──
        // Lists sessions with optional status filter.
        // Query: ?status=running|completed|failed|cancelled&limit=20
        // W30 S4: Merges in-memory taskStreams (for running tasks) with persistent sessionStore.
        if (req.url?.startsWith('/internal/v1/sessions') && req.method === 'GET') {
          const urlObj = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
          const statusFilter = urlObj.searchParams.get('status');
          const limit = parseInt(urlObj.searchParams.get('limit') ?? '20', 10);

          const result: Array<{
            id: string;
            title?: string;
            status: string;
            progress?: { step: number; totalSteps: number; description: string };
            createdAt: string;
            updatedAt: string;
            completedAt: string | null;
          }> = [];

          // Include in-memory task streams (current/active tasks)
          if (!statusFilter || statusFilter === 'running') {
            for (const [id, entry] of taskStreams) {
              if (statusFilter && entry.status !== statusFilter) continue;
              result.push({
                id: entry.sessionId,
                title: entry.message.slice(0, 80),
                status: entry.status,
                progress: entry.progress,
                createdAt: new Date(entry.createdAt).toISOString(),
                updatedAt: new Date(entry.createdAt).toISOString(),
                completedAt: null,
              });
            }
          }

          // Include persistent sessions from sessionStore
          const storeFilter: SessionStatus | undefined =
            statusFilter === 'running' ? 'active' :
            statusFilter === 'failed' ? 'interrupted' :
            statusFilter === 'cancelled' ? undefined :
            statusFilter as SessionStatus | undefined;

          if (storeFilter || !statusFilter) {
            const sessions = sessionStore.listSessions({ status: storeFilter, limit });
            for (const s of sessions) {
              // Skip sessions already in taskStreams (avoid duplicates)
              if (taskStreams.has(s.id)) continue;
              const summary = sessionStore.getSessionSummary(s.id);
              let displayStatus: string = s.status;
              if (s.status === 'active' || s.status === 'interrupted') displayStatus = 'running';
              result.push({
                id: s.id,
                title: summary?.lastUserMessage?.slice(0, 80) ?? undefined,
                status: displayStatus,
                createdAt: s.createdAt,
                updatedAt: s.updatedAt,
                completedAt: s.closedAt,
              });
            }
          }

          // Sort by updatedAt descending, limit
          result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          const limited = result.slice(0, limit);

          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, count: limited.length, sessions: limited }));
          return;
        }

        // ── C15: POST /internal/v1/sessions/{id}/compact ──
        // Manual compaction: reads session messages, calls compactConversation(),
        // returns summary + tokensRemoved. Optionally persists compacted messages.
        const compactMatch = req.url?.match(/^\/internal\/v1\/sessions\/([^/]+)\/compact$/);
        if (compactMatch && req.method === 'POST') {
          try {
            const sessionId = compactMatch[1];
            const session = sessionStore.getSession(sessionId);
            if (!session) {
              res.writeHead(404, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'not_found', message: `Session ${sessionId} not found` }));
              return;
            }

            const messages = sessionStore.getMessages(sessionId);
            if (messages.length < 3) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'not_enough_messages', message: 'Need at least 3 messages to compact' }));
              return;
            }

            // Parse optional body for custom instructions
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk);
            let body: { instructions?: string; persist?: boolean } = {};
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { /* empty body OK */ }

            const { compactConversation } = await import('../services/compact/compact.js');
            const triLcMessages = messages
              .filter((m) =>
                (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length > 0)
              .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));

            const result = await compactConversation(triLcMessages, body.instructions);

            // Optionally persist the compacted summary
            if (body.persist !== false) {
              sessionStore.saveMessages(sessionId, [
                { role: 'assistant', content: `[Compacted conversation summary]\n${result.summary}` },
              ]);
            }

            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              sessionId,
              summaryLength: result.summary.length,
              summary: result.summary,
              tokensRemoved: result.tokensRemoved,
              originalMessageCount: messages.length,
            }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'compact_failed', message: msg }));
          }
          return;
        }

        // ── POST /internal/v1/cron/jobs ──
        // Add a new cron job. Body: CronJobCreate JSON.
        if (req.url === '/internal/v1/cron/jobs' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) { chunks.push(chunk); }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: Record<string, unknown> = {};
          try { body = JSON.parse(raw); } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
            return;
          }
          try {
            const job = await cronEngine.addJob({
              ...(body as Record<string, unknown>),
              systemPrompt: (body.systemPrompt as string) ?? '',
            } as never);
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, job }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: msg }));
          }
          return;
        }

        // ── GET /internal/v1/cron/jobs ──
        // List all cron jobs.
        if (req.url === '/internal/v1/cron/jobs' && req.method === 'GET') {
          try {
            const jobs = await cronEngine.listJobs();
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, jobs, count: jobs.length }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: msg }));
          }
          return;
        }

        // ── PATCH /internal/v1/cron/jobs/{id} ──
        // Update a cron job. Body: CronJobPatch JSON.
        if (req.url?.startsWith('/internal/v1/cron/jobs/') && req.method === 'PATCH') {
          const jobIdMatch = req.url.match(/^\/internal\/v1\/cron\/jobs\/(.+)$/);
          if (!jobIdMatch) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid_path' }));
            return;
          }
          const jobId = decodeURIComponent(jobIdMatch[1]);
          const chunks: Buffer[] = [];
          for await (const chunk of req) { chunks.push(chunk); }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: Record<string, unknown> = {};
          try { body = JSON.parse(raw); } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
            return;
          }
          try {
            const job = await cronEngine.updateJob(jobId, body as any);
            if (!job) {
              res.writeHead(404, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'not_found' }));
              return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, job }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: msg }));
          }
          return;
        }

        // ── DELETE /internal/v1/cron/jobs/{id} ──
        // Remove a cron job.
        if (req.url?.startsWith('/internal/v1/cron/jobs/') && req.method === 'DELETE') {
          const jobIdMatch = req.url.match(/^\/internal\/v1\/cron\/jobs\/(.+)$/);
          if (!jobIdMatch) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid_path' }));
            return;
          }
          const jobId = decodeURIComponent(jobIdMatch[1]);
          try {
            await cronEngine.removeJob(jobId);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: msg }));
          }
          return;
        }

        // ── POST /internal/v1/cron/jobs/{id}/run ──
        // Immediately run a cron job. Body: { force?: boolean }
        if (req.url?.startsWith('/internal/v1/cron/jobs/') && req.url.endsWith('/run') && req.method === 'POST') {
          const jobIdMatch = req.url.match(/^\/internal\/v1\/cron\/jobs\/(.+)\/run$/);
          if (!jobIdMatch) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid_path' }));
            return;
          }
          const jobId = decodeURIComponent(jobIdMatch[1]);
          const chunks: Buffer[] = [];
          for await (const chunk of req) { chunks.push(chunk); }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: { force?: boolean } = {};
          try { body = JSON.parse(raw); } catch { /* empty body OK */ }
          try {
            const result = await cronEngine.runJob(jobId, body.force);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: msg }));
          }
          return;
        }

        // ── GET /internal/v1/cron/log ──
        // Query: ?jobId=<id>&limit=<n>. Without jobId returns recent from all jobs.
        if (req.url?.startsWith('/internal/v1/cron/log') && req.method === 'GET') {
          const urlObj = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
          const jobId = urlObj.searchParams.get('jobId');
          const limit = parseInt(urlObj.searchParams.get('limit') ?? '20', 10);
          try {
            const logs = jobId
              ? await cronEngine.getExecutionLogs(jobId, limit)
              : await cronEngine.getRecentExecutionLogs(limit);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, logs, count: logs.length }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: msg }));
          }
          return;
        }

        // ── GET /internal/v1/cron/status ──
        if (req.url === '/internal/v1/cron/status' && req.method === 'GET') {
          try {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              status: {
                running: cronEngine.isRunning,
                degraded: cronEngine.isDegraded(),
                consecutiveFailures: cronEngine.consecutiveFailures,
                jobCount: cronEngine.jobCount,
              },
            }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: msg }));
          }
          return;
        }

        // ── GET /internal/v1/update/check ──
        // ACT2: Returns update information comparing local version.json
        // against the latest GitHub Release. TriPilot consumes this to show
        // update notifications. Query: ?force=true to bypass cache.
        if (req.url?.startsWith('/internal/v1/update/check') && req.method === 'GET') {
          const urlObj = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
          await updateCheckHandler(req, res, urlObj.searchParams);
          return;
        }

        // ── GET/POST /internal/v1/notifications ──
        // REQ-021: system notifications for clients (TriPilot / trilc chat).
        // POST: external scripts (e.g. weekly_plane_shift) push completion notices.
        // GET: clients pull unread notifications; ?ack=1 marks read.
        if (req.url === '/internal/v1/notifications' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) { chunks.push(chunk); }
          let body: Record<string, unknown> = {};
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { /* ignore */ }
          const notice = {
            id: `ntf_${Date.now().toString(36)}`,
            title: String(body.title ?? '通知'),
            body: String(body.body ?? ''),
            context: String(body.context ?? 'system'),
            createdAt: new Date().toISOString(),
            read: false,
          };
          notices.push(notice);
          if (notices.length > 100) notices.shift(); // cap
          try { await writeFile(noticeFile, JSON.stringify(notices, null, 2), 'utf-8'); } catch { /* best-effort */ }
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, notification: notice }));
          return;
        }
        if (req.url?.startsWith('/internal/v1/notifications') && req.method === 'GET') {
          const urlObj = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
          const ack = urlObj.searchParams.get('ack') === '1';
          if (ack) { for (const n of notices) n.read = true; try { await writeFile(noticeFile, JSON.stringify(notices, null, 2), 'utf-8'); } catch {} }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, notifications: notices.filter((n) => !n.read || ack), count: notices.filter((n) => !n.read).length }));
          return;
        }

        // ── POST /shutdown ──
        // Graceful shutdown endpoint for Windows-compatible daemon stop.
        // On Windows, SIGTERM is a hard kill; this provides a clean alternative.
        if (req.url === '/shutdown' && req.method === 'POST') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: 'shutting down' }));
          // Defer shutdown to let response flush
          setImmediate(() => {
            console.log('[trilc] graceful shutdown via /shutdown');
            process.exit(0);
          });
          return;
        }

        // ── C10: MCP Server Management Endpoints ──

        // GET /internal/v1/mcp/servers — list all configured + connected servers
        if (req.url === '/internal/v1/mcp/servers' && req.method === 'GET') {
          try {
            const { getMcpClientManager } = await import('../tools/mcp-tool.js');
            const { listProjectMCPServers } = await import('../mcp/mcp-config.js');
            const mcp = getMcpClientManager();
            const connected = mcp?.listServers() ?? [];
            const connectedNames = new Set(connected.map(s => s.name));
            const configured = listProjectMCPServers(env.cwd);

            const servers = configured.map(c => {
              const live = connected.find(s => s.name === c.name);
              return {
                name: c.name,
                type: c.type,
                status: c.disabled ? 'disabled' : live ? 'connected' : 'disconnected',
                toolCount: live?.toolCount ?? 0,
                resourceCount: live?.resourceCount ?? 0,
                promptCount: live?.promptCount ?? 0,
                source: c.source.replace(env.cwd, '.').replace(/\\/g, '/'),
              };
            });

            // Add connected-but-not-in-config servers
            for (const live of connected) {
              if (!configured.some(c => c.name === live.name)) {
                servers.push({
                  name: live.name,
                  type: live.type,
                  status: 'connected',
                  toolCount: live.toolCount,
                  resourceCount: live.resourceCount,
                  promptCount: live.promptCount,
                  source: '(runtime)',
                } as typeof servers[number]);
              }
            }

            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ servers, count: servers.length }));
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'mcp_error', message: (err as Error).message }));
          }
          return;
        }

        // GET /internal/v1/mcp/servers/{name} — single server status
        const mcpServerMatch = req.url?.match(/^\/internal\/v1\/mcp\/servers\/([^/]+)$/);
        if (mcpServerMatch && req.method === 'GET') {
          try {
            const serverName = decodeURIComponent(mcpServerMatch[1]);
            const { getMcpClientManager } = await import('../tools/mcp-tool.js');
            const mcp = getMcpClientManager();
            const connected = mcp?.listServers().find(s => s.name === serverName);

            if (!connected) {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ name: serverName, status: 'disconnected', connected: false }));
              return;
            }

            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              ...connected,
              connected: true,
            }));
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'mcp_error', message: (err as Error).message }));
          }
          return;
        }

        // POST /internal/v1/mcp/servers/add — runtime connect a server
        if (req.url === '/internal/v1/mcp/servers/add' && req.method === 'POST') {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            const { getMcpClientManager } = await import('../tools/mcp-tool.js');
            const mcp = getMcpClientManager();
            if (!mcp) {
              res.writeHead(503, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'mcp_not_initialized' }));
              return;
            }
            const registered = await mcp.connectServer({
              name: body.name,
              type: body.type ?? 'stdio',
              command: body.command,
              args: body.args,
              env: body.env,
              url: body.url,
            });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, name: body.name, toolsRegistered: registered.length, toolNames: registered }));
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'mcp_add_failed', message: (err as Error).message }));
          }
          return;
        }

        // POST /internal/v1/mcp/servers/{name}/remove — runtime disconnect
        const mcpRemoveMatch = req.url?.match(/^\/internal\/v1\/mcp\/servers\/([^/]+)\/remove$/);
        if (mcpRemoveMatch && req.method === 'POST') {
          try {
            const serverName = decodeURIComponent(mcpRemoveMatch[1]);
            const { getMcpClientManager } = await import('../tools/mcp-tool.js');
            const mcp = getMcpClientManager();
            if (!mcp) {
              res.writeHead(503, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'mcp_not_initialized' }));
              return;
            }
            await mcp.disconnectServer(serverName);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, name: serverName }));
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'mcp_remove_failed', message: (err as Error).message }));
          }
          return;
        }

        // POST /internal/v1/mcp/servers/refresh — reload config + reconnect
        if (req.url === '/internal/v1/mcp/servers/refresh' && req.method === 'POST') {
          try {
            const { getMcpClientManager } = await import('../tools/mcp-tool.js');
            const { loadMCPServerConfigs } = await import('../mcp/mcp-config.js');
            const mcp = getMcpClientManager();
            if (!mcp) {
              res.writeHead(503, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'mcp_not_initialized' }));
              return;
            }
            const configs = loadMCPServerConfigs(env.cwd);
            await mcp.disconnectAll();
            const results: Array<{ name: string; tools: number }> = [];
            for (const config of configs) {
              try {
                const registered = await mcp.connectServer(config);
                results.push({ name: config.name, tools: registered.length });
              } catch (err) {
                results.push({ name: config.name, tools: 0 });
                console.warn(`[mcp] refresh: failed to reconnect "${config.name}": ${(err as Error).message}`);
              }
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, refreshed: results.length, servers: results }));
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'mcp_refresh_failed', message: (err as Error).message }));
          }
          return;
        }

        // ── 404 ──
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      });

      await new Promise<void>((resolve, reject) => {
        server!.on('error', reject);
        server!.listen(env.port, '127.0.0.1', () => resolve());
      });

      // Read actual port (in case port 0 for OS-assigned)
      const addr = server!.address();
      if (addr && typeof addr === 'object') {
        env.port = addr.port;
      }

      console.log(`[trilc] listening on :${env.port}`);

      // S7: Start mirror pusher (event-driven + 30s heartbeat)
      mirrorPusher.start();

      // ── Heartbeat Runner: default heartbeat agent + onboarding (REQ-001) ──
      const DEFAULT_HEARTBEAT_AGENT: HeartbeatAgentConfig = {
        agentId: "default-heartbeat",
        intervalMs: 30 * 60 * 1000,
        model: "tmv-deepseek-v4-flash",
        maxTurns: 10,
        systemPrompt: "You are a system heartbeat agent. Report current status concisely.",
        userMessage: "Periodic heartbeat check. Confirm all systems nominal.",
      };

      // REQ-20260805-001: if TriCompany uninitialized, register onboarding agent
      // (auto-pushes greet → ask CEO name → role list → select+name → assemble).
      const companyInit = new CompanyInitState(env.dataDir, env.projectRoot ?? env.cwd);
      const agents: HeartbeatAgentConfig[] = [DEFAULT_HEARTBEAT_AGENT];
      try {
        if (await companyInit.isOnboardingPending()) {
          // REQ-014b: onboarding workspace = projectRoot (TRILC_PROJECT_ROOT), not daemon cwd
          // REQ-016: statePath so the agent reads the real progress file (dataDir), not workspace copies
          const companyStatePath = join(env.dataDir, 'company', 'state.json');
          agents.push(buildOnboardingAgent(env.projectRoot ?? env.cwd, getKeyCache()?.defaultModel ?? "tmv-deepseek-v4-flash", companyStatePath));
          console.log("[trilc] TriCompany uninitialized — onboarding agent registered");
        } else {
          console.log("[trilc] TriCompany initialized — onboarding skipped");
        }
      } catch (err) {
        console.warn("[trilc] company init check failed:", (err as Error).message);
      }

      heartbeatRunner.updateAgents(agents);
      heartbeatRunner.start();
      publish({ type: "heartbeat:sent", nodeId: env.nodeId });
      console.log(`[trilc] heartbeat runner started (${agents.length} agent${agents.length > 1 ? "s" : ""})`);

      // ── Session Reaper: hourly sweep ──
      sessionReaper.start();
      publish({ type: "cron:sweep", count: 0 });

      // ── Cron Engine: load persisted jobs ──
      cronEngine.start().catch((err) => {
        console.warn("[trilc] cron engine start failed:", (err as Error).message);
      });

      // ── ACT2: Update check loop ──
      updateCheckLoop = startUpdateCheckLoop({
        repo: process.env.TRILC_GITHUB_REPO ?? 'MoRen9527/TriLC',
      });
      console.log("[trilc] update check loop started");

      // ── Signal handling (Linux detached runtime) ──
      // On Linux, the CLI sends SIGTERM as fallback after graceful /shutdown.
      // Handle both SIGTERM and SIGINT for clean daemon shutdown.
      const gracefulStop = async (signal: string) => {
        console.log(`[trilc] received ${signal}, shutting down...`);
        console.log('[trilc] cancelling all managed shell processes...');
        cancelAllShellProcesses();
        cronEngine.stop();
        sessionReaper.stop();
        heartbeatRunner.stop();
        mirrorPusher.stop();
        updateCheckLoop?.stop();
        if (server) {
          await new Promise<void>((res) => server!.close(() => res()));
          server = null;
        }
        connMgr.stopHealthCheckLoop();
        process.exit(0);
      };
      process.on('SIGTERM', () => gracefulStop('SIGTERM'));
      process.on('SIGINT', () => gracefulStop('SIGINT'));
    },

    get port(): number {
      return env.port;
    },

    get connectionState(): ConnectionState {
      return connMgr.currentState;
    },

    async stop(): Promise<void> {
      cronEngine.stop();
      sessionReaper.stop();
      heartbeatRunner.stop();
      mirrorPusher.stop();
      updateCheckLoop?.stop();
      connMgr.stopHealthCheckLoop();
      stopKeyCache();
      cancelAllShellProcesses();
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server!.close((err) => (err ? reject(err) : resolve()));
        });
        server = null;
      }
    },
  };
}

// ── Anthropic API helpers ──

interface AnthropicRequest {
  model?: string;
  messages?: AnthropicMessage[];
  system?: string;
  max_tokens?: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  /** P3: opt-in interactive mode — enables TUI question/permission prompts. */
  interactive?: boolean;
  /** C8: Permission mode override (default/acceptEdits/auto/dontAsk/bypass/plan). */
  permission_mode?: string;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

// ── OpenAI Chat Completions types ──
// Used by the /chat/completions endpoint for opencode / Vercel AI SDK compatibility.

interface OpenAIRequest {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  max_tokens?: number;
  tools?: OpenAIToolDef[];
  /** C8: Permission mode override (default/acceptEdits/auto/dontAsk/bypass/plan). */
  permission_mode?: string;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface ModelInfo {
  id: string;
  displayName: string;
  createdAt: string;
}

/**
 * C12: Validate that a model name exists in the TriModel registry.
 * Returns detailed error for fallback-chain diagnostics.
 * W30 lesson: fallback chain must end at a registered model — never assume defaults.
 */
function validateModelAgainstRegistry(model: string): { valid: boolean; error?: string } {
  try {
    if (!_modelClient) {
      _modelClient = createModelClient();
    }
    const registeredModels = _modelClient.listModels();
    if (registeredModels.length === 0) {
      return {
        valid: false,
        error: `Model registry is empty — no providers configured. Check API keys (DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, etc.).`,
      };
    }
    if (registeredModels.includes(model)) {
      return { valid: true };
    }
    return {
      valid: false,
      error: `Model "${model}" not in registry. Available: ${registeredModels.join(', ')}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[trilc:model] cannot validate model "${model}": ${msg}`);
    return {
      valid: false,
      error: `Model registry unavailable — cannot validate "${model}": ${msg}`,
    };
  }
}

/**
 * C12/R2: Startup-time model registry integrity check.
 * Runs after key cache init + env propagation. Validates that the configured
 * default model and well-known fallback targets exist in TriModel's registry.
 * Gaps emit WARNING; never blocks startup.
 * W30 lesson: a registry gap ("Unknown model") in prod is a silent user-facing failure.
 */
function validateModelRegistry(): void {
  try {
    const client = createModelClient();
    const models = client.listModels();
    if (models.length === 0) {
      console.warn('[trilc:model] WARNING: model registry is empty — no providers configured, chat will fail');
      console.warn('[trilc:model]         check API keys (DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, etc.)');
      return;
    }

    const defaultModel = getKeyCache()?.defaultModel
      ?? process.env.TRIMODEL_DEFAULT_MODEL
      ?? 'tmv-deepseek-v4-pro';

    // Known ultimate fallback targets — these MUST be in the registry for
    // agent-core's Tier 2 recovery to work. If missing, tmv-* models will
    // have no viable fallback path when TriStaciss is offline.
    const criticalFallbacks = ['tmv-deepseek-v4-flash', 'tmv-deepseek-v4-pro'];
    const missing: string[] = [];
    if (!models.includes(defaultModel)) {
      missing.push(defaultModel);
    }
    for (const fb of criticalFallbacks) {
      if (!models.includes(fb)) missing.push(fb);
    }

    if (missing.length > 0) {
      console.warn(`[trilc:model] WARNING: model(s) not in registry: ${missing.join(', ')} — check provider API keys`);
    }
    console.log(
      `[trilc:model] registry check: ${models.length} models (${models.join(', ')})` +
      (missing.length === 0 ? ', fallback chain ok' : ', fallback chain incomplete — see WARNING above'),
    );
  } catch (err) {
    console.warn(`[trilc:model] registry check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let _modelClient: ReturnType<typeof createModelClient> | null = null;
let _modelCache: { models: ModelInfo[]; expiresAt: number } | null = null;
const MODEL_CACHE_TTL_MS = 60_000; // 1 minute

// C8: Default permission mode — set from env TRILC_PERMISSION_MODE at startup,
// overridable per-request via permission_mode body field. Backward-compat: bypassPermissions.
let _defaultPermissionMode: string = 'bypassPermissions';

// C9: CLI rule patterns, additional dirs, and print mode (loaded from env at startup)
let _cliAllowRulePatterns: string[] = [];
let _cliDenyRulePatterns: string[] = [];
let _cliAdditionalDirs: string[] = [];
let _printMode = false;
let _persistedPermissionRules: Array<{ toolName: string; behavior: 'allow' | 'deny'; source: 'userSettings' }> = [];

/** C9: Parse a JSON string array from env (e.g. '["Read","Glob(git)"]'). */
function parseRuleListEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch { return []; }
}

/** C9: Parse a JSON string array of paths from env. */
function parseStringListEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch { return []; }
}

/** C9: Parse a CLI rule pattern "ToolName" or "ToolName(content)" into PermissionRule. */
function parseCliRulePattern(pattern: string, behavior: 'allow' | 'deny'): { toolName: string; content?: string } | null {
  const match = pattern.match(/^([^(]+)(?:\((.+)\))?$/);
  if (!match) return null;
  const toolName = match[1].trim();
  const content = match[2]?.trim();
  if (!toolName) return null;
  return { toolName, content: content || undefined };
}

/**
 * C9: Build the complete permission rules array for the current session.
 * Merges CLI rules (highest priority) + persisted rules from disk.
 * CLI rules are source='cliArg', persisted rules are source='userSettings'.
 * Deny rules come before allow rules (pipeline step 1 vs step 6).
 */
function buildSessionPermissionRules(): PermissionRule[] {
  const rules: PermissionRule[] = [];

  // 1. CLI deny rules (highest priority)
  for (const pattern of _cliDenyRulePatterns) {
    const parsed = parseCliRulePattern(pattern, 'deny');
    if (parsed) {
      rules.push({
        toolName: parsed.toolName,
        ...(parsed.content ? { content: parsed.content } : {}),
        behavior: 'deny',
        source: 'cliArg',
      });
    }
  }

  // 2. Persisted deny rules from disk
  for (const pr of _persistedPermissionRules) {
    if (pr.behavior === 'deny') {
      rules.push({ toolName: pr.toolName, behavior: 'deny', source: 'userSettings' });
    }
  }

  // 3. CLI allow rules
  for (const pattern of _cliAllowRulePatterns) {
    const parsed = parseCliRulePattern(pattern, 'allow');
    if (parsed) {
      rules.push({
        toolName: parsed.toolName,
        ...(parsed.content ? { content: parsed.content } : {}),
        behavior: 'allow',
        source: 'cliArg',
      });
    }
  }

  // 4. Persisted allow rules from disk
  for (const pr of _persistedPermissionRules) {
    if (pr.behavior === 'allow') {
      rules.push({ toolName: pr.toolName, behavior: 'allow', source: 'userSettings' });
    }
  }

  return rules;
}

/** C8: Resolve the effective permission mode for a request. */
function resolvePermissionMode(requestOverride?: string): string {
  if (requestOverride) {
    // Accept shorthand 'bypass' → 'bypassPermissions'
    if (requestOverride === 'bypass') return 'bypassPermissions';
    return requestOverride;
  }
  return _defaultPermissionMode;
}

// TriModel configuration-plane API URL for HTTP-priority model fetching
let _trimodelApiUrl = 'http://127.0.0.1:3333';

export function setTrimodelApiUrl(url: string): void {
  _trimodelApiUrl = url;
}

async function fetchModelsFromApi(): Promise<ModelInfo[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${_trimodelApiUrl}/v1/models`, { signal: controller.signal });
    if (!res.ok) throw new Error(`TriModel API ${res.status}`);
    const json = await res.json() as { data: Array<{ id: string; display_name?: string; created?: number }> };
    return (json.data ?? []).map((m) => ({
      id: m.id,
      displayName: m.display_name ?? m.id,
      createdAt: String(m.created ? new Date(m.created * 1000).toISOString().slice(0, 10) : '2025-01-01'),
    }));
  } finally {
    clearTimeout(timeout);
  }
}

async function getAvailableModels(): Promise<ModelInfo[]> {
  // Return cached models if still valid
  if (_modelCache && _modelCache.expiresAt > Date.now()) {
    return _modelCache.models;
  }

  // Phase 1: Try HTTP from TriModel API first
  try {
    const models = await fetchModelsFromApi();
    _modelCache = { models, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
    return models;
  } catch (apiErr) {
    console.warn(`[trilc] TriModel API unreachable (${apiErr instanceof Error ? apiErr.message : String(apiErr)}), falling back to library`);
  }

  // Fallback: direct library import (TriModel npm package)
  try {
    if (!_modelClient) {
      _modelClient = createModelClient();
    }
    const modelIds = _modelClient.listModels();
    const models: ModelInfo[] = modelIds.map((id) => ({
      id,
      displayName: id,
      createdAt: '2025-01-01',
    }));
    _modelCache = { models, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
    return models;
  } catch (err) {
    // C12: W30 lesson — never return hardcoded defaults when registry is unavailable.
    // A hardcoded default masks the root cause and causes "Unknown model" downstream.
    console.error(`[trilc:model] model registry unavailable (API + library both failed): ${err instanceof Error ? err.message : String(err)}`);
    if (_modelCache) {
      console.warn('[trilc:model] serving stale cached model list as last resort');
      return _modelCache.models;
    }
    return [];
  }
}

/**
 * Convert Anthropic Messages API format to internal Message[] format.
 * Handles:
 * - Simple text content: { role: "user", content: "hello" }
 * - Content blocks: [{ type: "text", text: "hello" }]
 * - Tool results: [{ type: "tool_result", tool_use_id: "...", content: "..." }]
 */
function convertAnthropicMessages(anthropicMessages: AnthropicMessage[]): Message[] {
  const result: Message[] = [];

  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      // Simple text message
      result.push({
        role: msg.role,
        content: msg.content,
      });
    } else if (Array.isArray(msg.content)) {
      // Content blocks — may contain text AND tool results
      const textBlocks: string[] = [];
      const toolResults: Array<{ tool_call_id: string; content: string }> = [];
      const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          textBlocks.push(block.text);
        } else if (block.type === 'tool_use') {
          toolUses.push({
            id: block.id ?? '',
            name: block.name ?? '',
            input: block.input ?? {},
          });
        } else if (block.type === 'tool_result') {
          const resultContent = typeof block.content === 'string'
            ? block.content
            : (Array.isArray(block.content)
              ? block.content.map((c) => c.text ?? '').join('\n')
              : '');
          toolResults.push({
            tool_call_id: block.tool_use_id ?? '',
            content: resultContent,
          });
        }
      }

      // Emit assistant text + tool_use as ONE assistant message carrying tool_calls,
      // so following role:'tool' messages (from tool_result) pair by tool_call_id.
      if (msg.role === 'assistant' && toolUses.length > 0) {
        result.push({
          role: 'assistant',
          content: textBlocks.join('\n'),
          tool_calls: toolUses.map((tu) => ({
            id: tu.id,
            type: 'function' as const,
            function: { name: tu.name, arguments: JSON.stringify(tu.input) },
          })),
        });
      } else if (textBlocks.length > 0) {
        result.push({
          role: msg.role,
          content: textBlocks.join('\n'),
        });
      }

      // Emit tool results as tool messages
      for (const tr of toolResults) {
        result.push({
          role: 'tool',
          content: tr.content,
          tool_call_id: tr.tool_call_id,
        });
      }
    }
  }

  return result;
}

/**
 * Convert Anthropic tool definitions to internal ToolDefinition format.
 */
function convertAnthropicTools(tools: AnthropicTool[]): ToolDefinition[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema ?? { type: 'object', properties: {} },
    },
  }));
}

/**
 * Build a platform-aware default system prompt.
 *
 * Critical: without this, the model generates Unix-style commands (ls, find,
 * pwd, cat) which either fail or — worse — hang on Windows. Windows `find.exe`
 * with Unix args reads from stdin and blocks until timeout. Telling the model
 * the OS + shell up front prevents the "agent hangs on file search" failure.
 *
 * P2-Batch1-#5: Automatically loads CLAUDE.md from current directory if present.
 * Uses cache-first approach: first call async-loads, subsequent calls use cache.
 */

// Cached CLAUDE.md content per directory
let cachedClaudeMd: { cwd: string; content: string | null; loaded: boolean } | null = null;

// Start async load in background (non-blocking)
function startCLAUDE_mdLoad(cwd: string): void {
  if (cachedClaudeMd && cachedClaudeMd.cwd === cwd && cachedClaudeMd.loaded) return;

  import('node:fs/promises').then(async ({ readFile }) => {
    import('node:path').then(async ({ resolve }) => {
      try {
        const claudeMdPath = resolve(cwd, 'CLAUDE.md');
        const content = await readFile(claudeMdPath, 'utf-8');
        cachedClaudeMd = { cwd, content, loaded: true };
      } catch {
        cachedClaudeMd = { cwd, content: null, loaded: true };
      }
    });
  });
}

export function defaultSystemPrompt(cwd?: string): string {
  const isWin = process.platform === 'win32';
  const shell = isWin
    ? 'Windows. Commands run via cmd.exe. Use Windows-compatible commands: dir (not ls), where (not which), type (not cat), findstr (not grep). Avoid Unix-only flags like -name. Prefer PowerShell-style or native Windows commands.'
    : process.platform === 'darwin'
      ? 'macOS. Commands run via sh.'
      : 'Linux. Commands run via sh.';

  const basePrompt = `You are TriCade, a capable coding and task assistant running on ${shell} When you need to run shell commands or search files, generate commands compatible with this platform. Prefer the Read/Glob/Grep tools for file operations instead of raw shell commands when available.`;

  // r17 ②：公司周平面根注入（读取端，r2 树契约的最后一环）——
  // 模型上下文需知道公司周平面根，否则按旧约定找项目内
  // docs/execution/operating-records（安装态为空/旧数据）→ current-week
  // 判定错误（W33 vs 实际 active W34）。仅读取提示，不改变任何写语义。
  const weeklyPlaneHint = buildWeeklyPlaneHint();

  // P2-Batch1-#5: Trigger async load if needed
  const targetCwd = cwd || process.cwd();
  if (!cachedClaudeMd || cachedClaudeMd.cwd !== targetCwd) {
    // Reset cache and start loading
    cachedClaudeMd = { cwd: targetCwd, content: null, loaded: false };
    startCLAUDE_mdLoad(targetCwd);
  }

  // Append cached content if available; always include agent roster (KI-PH2-001 fix)
  if (cachedClaudeMd && cachedClaudeMd.content) {
    return `${basePrompt}\n\n## Project Instructions (from CLAUDE.md)\n\n${cachedClaudeMd.content}${cachedAgentRoster}${weeklyPlaneHint}`;
  }

  return basePrompt + cachedAgentRoster + weeklyPlaneHint;
}

/**
 * r17 ②：公司周平面读取提示（读取端注入）。
 * 周平面根解析走 src/project/weekly-plane-root.ts（env 显式 → workspace
 * sibling → undefined 回退不注入）。
 */
function buildWeeklyPlaneHint(): string {
  const planeRoot = resolveWeeklyPlaneRoot();
  if (!planeRoot) return '';
  return `\n\n## Company Weekly Plane (read-only)\n\nThe company weekly operating plane lives at \`${planeRoot}\`. When asked about the current week, weekly indexes (OP-*.json), operating records, or unresolved items, read from this directory instead of any project-local operating-records path. The active week is the \`2026-Wnn\` directory whose OP index has \`status: "active"\` (its index also carries \`latestActiveWeek: true\`).`;
}

/**
 * Convert OpenAI Chat Completions messages to internal Message[] format.
 * Extracts system messages into a separate systemPrompt string.
 */
function convertOpenAIMessages(openaiMessages: OpenAIMessage[]): { systemPrompt: string; internalMessages: Message[] } {
  let systemPrompt = '';
  const internalMessages: Message[] = [];

  for (const msg of openaiMessages) {
    if (msg.role === 'system') {
      systemPrompt += (systemPrompt ? '\n' : '') + (msg.content ?? '');
    } else if (msg.role === 'user') {
      internalMessages.push({ role: 'user', content: msg.content ?? '' });
    } else if (msg.role === 'assistant') {
      const toolCalls = msg.tool_calls?.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));
      internalMessages.push({
        role: 'assistant',
        content: msg.content ?? '',
        tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      });
    } else if (msg.role === 'tool') {
      internalMessages.push({
        role: 'tool',
        content: msg.content ?? '',
        tool_call_id: msg.tool_call_id ?? '',
      });
    }
  }

  return { systemPrompt, internalMessages };
}

/**
 * Convert OpenAI tool definitions to internal ToolDefinition format.
 */
function convertOpenAITools(tools: OpenAIToolDef[]): ToolDefinition[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.function.name,
      description: t.function.description ?? '',
      parameters: t.function.parameters ?? { type: 'object', properties: {} },
    },
  }));
}

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}
