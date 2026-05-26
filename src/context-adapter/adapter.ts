export class ContextAdapter {
  async describeCapabilities(): Promise<{
    source: 'neutral-local-context';
    capabilities: string[];
  }> {
    return {
      source: 'neutral-local-context',
      capabilities: ['workspace', 'filesystem', 'terminal', 'browser']
    };
  }
}