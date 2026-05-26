export type ToolInvocation = {
  toolName: string;
  input: Record<string, unknown>;
};

export class ToolBus {
  async invoke(invocation: ToolInvocation): Promise<{ ok: boolean }> {
    console.log('[trilc/toolbus] invoke', invocation.toolName);
    return { ok: true };
  }
}