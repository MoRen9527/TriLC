// ── TriLC Local HTTP Server ──
// Exposes the same API surface as TriMC:
//   GET  /healthz              → { ok: true, service: 'trilc' }
//   GET  /v1/models            → Anthropic-compatible model list
//   GET  /models               → OpenAI-compatible model list
//   POST /v1/messages          → Anthropic Messages API (SSE + JSON)
//   POST /chat/completions     → OpenAI Chat Completions API (SSE + JSON)
//   POST /internal/v1/agent    → SSE + JSON modes (agentLoop from @trimetaverse/agent-core)
//
// TriLC does NOT load pipeline (Soul Loader / Memory Injector / Context Builder / Tool Gater).
// Those are TriMC-only services. Local mode uses legacy raw mode directly.

import { createServer, type Server, type ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { TriLCEnv } from '../config/env.js';
import { agentLoop, register as registerTool } from '@trimetaverse/agent-core';
import type { AgentEvent, AgentLoopOptions } from '@trimetaverse/agent-core';
import type { AgentTier, PermissionMode, PermissionRule } from '@trimetaverse/agent-core';
import { validateMessage, type GuardResult } from '@trimetaverse/agent-core';
import type { Message, ToolDefinition, UsageSummary } from 'trimodel';
import { createModelClient } from 'trimodel';
import { createEventQueue } from '../event-queue/index.js';
import type { ReplayRequest, ReplayResponse } from '../event-queue/types.js';
import { publish } from '../localbus/bus.js';
import { agentEventsToAnthropicSSE, formatSSELine } from './anthropic-stream.js';
import { agentEventsToOpenAISSE, formatOpenAISSE, OPENAI_SSE_DONE } from './openai-stream.js';
import { registerShellExecTool, getDefaultSupervisor, cancelAllShellProcesses } from '../tools/shell-exec.js';

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
  queueSize?: () => number;
  getPendingForReplay?: (connectionId: string, limit?: number) => ReplayEventItem[];
  applyReplayResponse?: (connectionId: string, res: ReplayResponse, events: ReplayEventItem[]) => void;
}

// ── Heartbeat Wake Reason Priority (absorbed from openclaw) ──
const WAKE_PRIORITY = {
  RETRY: 0,
  INTERVAL: 1,
  DEFAULT: 2,
  ACTION: 3,
} as const;

type WakeReasonKind = 'retry' | 'interval' | 'default' | 'action';

interface PendingWake {
  reason: WakeReasonKind;
  priority: number;
  requestedAt: number;
}

function resolveWakePriority(reason?: string): number {
  if (reason === 'retry') return WAKE_PRIORITY.RETRY;
  if (reason === 'interval') return WAKE_PRIORITY.INTERVAL;
  if (reason === 'action') return WAKE_PRIORITY.ACTION;
  return WAKE_PRIORITY.DEFAULT;
}

// ── ConnectionManager ──

class ConnectionManager {
  private state: ConnectionState = 'connected';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private readonly failThreshold = 3;
  private readonly recoverThreshold = 2;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private readonly trimcBaseUrl: string;
  private readonly healthCheckIntervalMs: number;
  private readonly nodeId: string;
  private readonly version: string;
  private startTime: number;
  private _queueSize: () => number;
  private _getPendingForReplay: (connectionId: string, limit?: number) => ReplayEventItem[];
  private _applyReplayResponse: (connectionId: string, res: ReplayResponse, events: ReplayEventItem[]) => void;
  private recoveryCallback: (() => void) | null = null;

  // ── Heartbeat Wake State (absorbed from openclaw heartbeat-wake) ──
  private heartbeatsEnabled = true;
  private pendingWake: PendingWake | null = null;
  private wakeTimer: NodeJS.Timeout | null = null;
  private wakeTimerDueAt: number | null = null;
  private wakeTimerKind: 'normal' | 'retry' | null = null;
  private wakeRunning = false;
  private wakeScheduled = false;
  private static readonly COALESCE_MS = 250;
  private static readonly RETRY_COOLDOWN_MS = 1_000;

  constructor(trimcBaseUrl: string, opts: ConnectionManagerOptions) {
    this.trimcBaseUrl = trimcBaseUrl;
    this.nodeId = opts.nodeId;
    this.version = opts.version;
    this.healthCheckIntervalMs = opts.intervalMs ?? 10_000;
    this._queueSize = opts.queueSize ?? (() => 0);
    this._getPendingForReplay = opts.getPendingForReplay ?? (() => []);
    this._applyReplayResponse = opts.applyReplayResponse ?? (() => {});
    this.startTime = Date.now();
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
        console.log('[trilc:conn] recovered → connected');
        publish({ type: 'node:connected' });
        // Trigger event replay for all pending events accumulated during degraded period
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
        console.log('[trilc:conn] degraded → will use local fallback');
        publish({ type: 'node:degraded' });
      }
    } else if (this.state === 'degraded') {
      // Already degraded, stay here
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
    this.healthCheckTimer = setInterval(() => {
      if (this.heartbeatsEnabled) {
        this.checkHealth().catch(() => {});
      }
    }, this.healthCheckIntervalMs);
    // Immediate first check
    if (this.heartbeatsEnabled) {
      this.checkHealth().catch(() => {});
    }
  }

  stopHealthCheckLoop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    // Clean up wake timer
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
      this.wakeTimerDueAt = null;
      this.wakeTimerKind = null;
    }
    this.pendingWake = null;
    this.wakeScheduled = false;
    this.wakeRunning = false;
  }

  // ── Heartbeat Wake (absorbed from openclaw heartbeat-wake) ──

  /** Enable or disable heartbeat checks (periodic + on-demand). */
  setHeartbeatsEnabled(enabled: boolean): void {
    this.heartbeatsEnabled = enabled;
    if (!enabled) {
      // Clear pending wake state
      if (this.wakeTimer) {
        clearTimeout(this.wakeTimer);
        this.wakeTimer = null;
        this.wakeTimerDueAt = null;
        this.wakeTimerKind = null;
      }
      this.pendingWake = null;
      this.wakeScheduled = false;
    }
  }

  /** Check if heartbeats are enabled. */
  areHeartbeatsEnabled(): boolean {
    return this.heartbeatsEnabled;
  }

  /**
   * Request an immediate heartbeat check with coalescing.
   * Multiple rapid calls within COALESCE_MS (250ms) are merged.
   * Higher priority reasons preempt lower ones.
   *
   * @param reason - Wake reason: 'action' (highest), 'default', 'interval', 'retry' (lowest)
   * @param coalesceMs - Coalesce window override (default: 250ms)
   */
  requestHeartbeatNow(opts?: { reason?: string; coalesceMs?: number }): void {
    if (!this.heartbeatsEnabled) return;

    const reason = opts?.reason ?? 'action';
    const priority = resolveWakePriority(reason);
    const wake: PendingWake = { reason: reason as WakeReasonKind, priority, requestedAt: Date.now() };

    // Merge: keep higher priority, or newer at same priority
    if (!this.pendingWake || priority > this.pendingWake.priority ||
        (priority === this.pendingWake.priority && wake.requestedAt >= this.pendingWake.requestedAt)) {
      this.pendingWake = wake;
    }

    this._scheduleWake(opts?.coalesceMs ?? ConnectionManager.COALESCE_MS, 'normal');
  }

  /** Check if a wake is pending (timer scheduled or queued). */
  hasPendingWake(): boolean {
    return this.pendingWake !== null || this.wakeTimer !== null || this.wakeScheduled;
  }

  // ── Internal wake scheduling ──

  private _scheduleWake(coalesceMs: number, kind: 'normal' | 'retry'): void {
    const delay = Number.isFinite(coalesceMs) ? Math.max(0, coalesceMs) : ConnectionManager.COALESCE_MS;
    const dueAt = Date.now() + delay;

    if (this.wakeTimer) {
      // Retry cooldown is a hard minimum — prevents collapse
      if (this.wakeTimerKind === 'retry') return;
      // Keep existing timer if it fires sooner or at same time
      if (typeof this.wakeTimerDueAt === 'number' && this.wakeTimerDueAt <= dueAt) return;
      // New request fires sooner — preempt
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
      this.wakeTimerDueAt = null;
      this.wakeTimerKind = null;
    }

    this.wakeTimerDueAt = dueAt;
    this.wakeTimerKind = kind;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.wakeTimerDueAt = null;
      this.wakeTimerKind = null;
      this.wakeScheduled = false;
      this._executeWake().catch(() => {});
    }, delay);
    this.wakeTimer.unref?.();
  }

  private async _executeWake(): Promise<void> {
    const wake = this.pendingWake;
    this.pendingWake = null;

    if (this.wakeRunning) {
      // Already running — reschedule
      if (wake) {
        this.pendingWake = wake;
        this._scheduleWake(ConnectionManager.COALESCE_MS, 'normal');
      }
      this.wakeScheduled = true;
      return;
    }

    this.wakeRunning = true;
    try {
      await this.checkHealth();
    } catch {
      // checkHealth handles its own error logging
    } finally {
      this.wakeRunning = false;
      // If more wakes arrived during execution, schedule another round
      if (this.pendingWake || this.wakeScheduled) {
        this.wakeScheduled = false;
        this._scheduleWake(ConnectionManager.RETRY_COOLDOWN_MS, 'retry');
      }
    }
  }

  // Register callback for post-recovery actions (e.g., reset connectionId)
  onRecovered(cb: () => void): void {
    this.recoveryCallback = cb;
  }

  // Replay pending events to TriMC after recovery from degraded state
  private async _performReplay(): Promise<void> {
    const connectionId = ''; // Will be resolved from closure via setConnectionId
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

export function createTriLCApp(env: TriLCEnv) {
  let server: Server | null = null;
  const eventQueue = createEventQueue({
    dbPath: `${env.dataDir}/event-queue.db`,
  });
  let connectionId = '';
  const resetConnectionId = () => {
    connectionId = `${env.nodeId}-${Date.now().toString(36)}`;
  };
  resetConnectionId();

  const connMgr = new ConnectionManager(env.trimcBaseUrl, {
    nodeId: env.nodeId,
    version: env.version,
    queueSize: () => eventQueue.getQueueSize(),
    getPendingForReplay: (cid, limit) => eventQueue.getPendingForReplay(cid, limit),
    applyReplayResponse: (cid, res, events) => eventQueue.applyReplayResponse(cid, res, events),
  });

  // Wire connectionId into ConnectionManager for replay
  connMgr._setConnectionId(connectionId);
  connMgr.onRecovered(() => {
    // On recovery, reset connectionId so replay events are scoped to new session
    resetConnectionId();
    connMgr._setConnectionId(connectionId);
  });

  return {
    async start(): Promise<void> {
      connMgr.startHealthCheckLoop();

      // P4.2: Register shell_exec tool backed by ProcessSupervisor
      registerShellExecTool({ supervisor: getDefaultSupervisor() });

      server = createServer(async (req, res) => {
        // ── /healthz ──
        if (req.url === '/healthz') {
          const triMcOnline = connMgr.currentState === 'connected';
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            service: 'trilc',
            trimc: triMcOnline ? 'connected' : 'degraded',
          }));
          return;
        }

        // ── GET /v1/models ──
        // Anthropic-compatible model list. Returns models available through TriModel.
        if (req.url === '/v1/models' && req.method === 'GET') {
          const models = getAvailableModels();
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

          const model = parsed.model ?? 'deepseek-v4-pro';
          const maxTurns = parsed.max_tokens ? Math.min(Math.ceil(parsed.max_tokens / 100), 25) : 25;

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

          const loopOptions: AgentLoopOptions = {
            model,
            systemPrompt: parsed.system ?? '',
            messages: internalMessages,
            maxTurns,
            tier: 'main',
            cwd: env.cwd,
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
                if (event.content) finalContent += event.content;
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
            model: parsed.model ?? 'deepseek-v4-pro',
            systemPrompt: parsed.systemPrompt ?? '',
            messages: parsed.messages ?? [],
            maxTurns: parsed.maxTurns ?? 25,
            tier: parsed.tier ?? 'main',
            cwd: parsed.cwd ?? env.cwd,
            permissionMode: parsed.permissionMode,
            permissionRules: parsed.permissionRules,
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
          const models = getAvailableModels();
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

          const model = parsed.model ?? 'deepseek-v4-pro';
          const maxTurns = parsed.max_tokens ? Math.min(Math.ceil(parsed.max_tokens / 100), 25) : 25;

          // Convert OpenAI messages to internal format
          const { systemPrompt, internalMessages } = convertOpenAIMessages(parsed.messages ?? []);

          // Register tools from request (if any)
          const toolDefs = convertOpenAITools(parsed.tools ?? []);
          const toolNames: string[] = [];
          for (const tool of toolDefs) {
            registerTool(tool, async (_args: Record<string, unknown>) => {
              return JSON.stringify({ _trilc_note: 'tool execution delegated to client' });
            });
            toolNames.push(tool.function.name);
          }

          const loopOptions: AgentLoopOptions = {
            model,
            systemPrompt,
            messages: internalMessages,
            maxTurns,
            tier: 'main',
            cwd: env.cwd,
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
                if (event.content) finalContent += event.content;
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
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              error: { type: 'api_error', message: msg },
            }));
          }
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

        // ── 404 ──
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      });

      await new Promise<void>((resolve, reject) => {
        server!.on('error', reject);
        server!.listen(env.port, () => resolve());
      });

      // Read actual port (in case port 0 for OS-assigned)
      const addr = server!.address();
      if (addr && typeof addr === 'object') {
        env.port = addr.port;
      }

      console.log(`[trilc] listening on :${env.port}`);

      // ── Signal handling (Linux detached runtime) ──
      // On Linux, the CLI sends SIGTERM as fallback after graceful /shutdown.
      // Handle both SIGTERM and SIGINT for clean daemon shutdown.
      const gracefulStop = async (signal: string) => {
        console.log(`[trilc] received ${signal}, shutting down...`);
        console.log('[trilc] cancelling all managed shell processes...');
        cancelAllShellProcesses();
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
      connMgr.stopHealthCheckLoop();
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

let _modelClient: ReturnType<typeof createModelClient> | null = null;
let _modelCache: { models: ModelInfo[]; expiresAt: number } | null = null;
const MODEL_CACHE_TTL_MS = 60_000; // 1 minute

function getAvailableModels(): ModelInfo[] {
  // Return cached models if still valid
  if (_modelCache && _modelCache.expiresAt > Date.now()) {
    return _modelCache.models;
  }

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
  } catch {
    // Fallback: return last cached or default models on error
    if (_modelCache) return _modelCache.models;
    return [
      { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', createdAt: '2025-01-01' },
      { id: 'deepseek-chat', displayName: 'DeepSeek Chat', createdAt: '2024-01-01' },
      { id: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner', createdAt: '2025-01-01' },
    ];
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

      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          textBlocks.push(block.text);
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

      // Emit text as user/assistant message
      if (textBlocks.length > 0) {
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
