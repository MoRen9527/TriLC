import type { TriLCEnv } from '../config/env.js';
import { LocalNode } from '../local-node/node.js';

export class LocalRuntimeDaemon {
  constructor(private readonly env: TriLCEnv) {}

  async start(): Promise<void> {
    const node = new LocalNode(this.env.nodeId);
    await node.heartbeat();
    console.log(`[trilc] daemon started for ${this.env.nodeId}`);
  }
}