export class LocalNode {
  constructor(private readonly nodeId: string) {}

  async heartbeat(): Promise<void> {
    console.log('[trilc/local-node] heartbeat', this.nodeId);
  }
}