// ── TriLC Local HTTP Server ──
// Exposes the same API surface as TriMC:
//   GET  /healthz              → { ok: true, service: 'trilc' }
//   POST /internal/v1/agent    → SSE + JSON modes (agentLoop from @trimetaverse/agent-core)
//
// TriLC does NOT load pipeline (Soul Loader / Memory Injector / Context Builder / Tool Gater).
// Those are TriMC-only services. Local mode uses legacy raw mode directly.

import { createServer, type Server, type ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { TriLCEnv } from '../config/env.js';
import { agentLoop } from '@trimetaverse/agent-core';
import type { AgentEvent, AgentLoopOptions } from '@trimetaverse/agent-core';
import type { AgentTier, PermissionMode, PermissionRule } from '@trimetaverse/agent-core';
import type { Message } from 'trimodel';
import { createEventQueue } from '../event-queue/index.js';
import type { ReplayRequest, ReplayResponse } from '../event-queue/types.js';
import { publish } from '../localbus/bus.js';

// ── ConnectionManager ──
// Tracks TriMC reachability for fast fallback decisions.
// CTO-008-M spec: 3 consecutive failures → DEGRADED → 2 consecutive successes → CONNECTED
// Uses POST /internal/v1/heartbeat with node metadata instead of bare GET /healthz.
// On recovery (DEGRADED→CONNECTED), triggers event replay via POST /internal/v1/events/replay.

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
      this.checkHealth().catch(() => {});
    }, this.healthCheckIntervalMs);
    // Immediate first check
    this.checkHealth().catch(() => {});
  }

  stopHealthCheckLoop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
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
    },

    get port(): number {
      return env.port;
    },

    get connectionState(): ConnectionState {
      return connMgr.currentState;
    },

    async stop(): Promise<void> {
      connMgr.stopHealthCheckLoop();
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server!.close((err) => (err ? reject(err) : resolve()));
        });
        server = null;
      }
    },
  };
}
