// ── Local Node (agent-core powered) ──
// Programmatic agent execution entry point — mirrors the HTTP server's
// agentLoop integration but as a direct API for other TriLC modules.
// Uses @trimetaverse/agent-core for loop, tools, and permissions.

import {
  agentLoop,
  listTools,
  type AgentLoopOptions,
  type AgentEvent,
} from '@trimetaverse/agent-core';
import type { TriLCEnv } from '../config/env.js';
import type { Message } from 'trimodel';

export interface LocalNodeRunOptions {
  systemPrompt: string;
  messages: Message[];
  maxTurns?: number;
  tier?: string;
  cwd?: string;
}

export class LocalNode {
  private state: 'idle' | 'running' = 'idle';

  constructor(private readonly env: TriLCEnv) {}

  // ── Programmatic agent execution ──
  async *runAgent(opts: LocalNodeRunOptions): AsyncGenerator<AgentEvent> {
    this.state = 'running';

    const loopOpts: AgentLoopOptions = {
      model: 'deepseek-v4-pro',
      systemPrompt: opts.systemPrompt,
      messages: opts.messages,
      maxTurns: opts.maxTurns ?? 25,
      tier: (opts.tier as AgentLoopOptions['tier']) ?? 'main',
      cwd: opts.cwd ?? this.env.cwd,
    };

    try {
      for await (const event of agentLoop(loopOpts)) {
        yield event;
      }
    } finally {
      this.state = 'idle';
    }
  }

  // ── Lifecycle ──
  get nodeId(): string {
    return this.env.nodeId;
  }

  get isRunning(): boolean {
    return this.state === 'running';
  }

  async heartbeat(): Promise<void> {
    console.log('[trilc/local-node] heartbeat', this.env.nodeId);
  }

  // ── Capability introspection ──
  getAvailableTools(): string[] {
    return listTools();
  }

  describeNode(): {
    nodeId: string;
    state: string;
    tools: string[];
  } {
    return {
      nodeId: this.env.nodeId,
      state: this.state,
      tools: this.getAvailableTools(),
    };
  }
}