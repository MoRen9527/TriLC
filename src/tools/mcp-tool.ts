// ── MCP Tool Proxy (P6 + P7 + P8) ──
import { register as registerTool } from '@tricompany/agent-core';

let mcpManager: import('../mcp/mcp-client.js').McpClientManager | null = null;
let initialized = false;

export function setMcpClientManager(manager: import('../mcp/mcp-client.js').McpClientManager): void {
  mcpManager = manager;
}

export function getMcpClientManager(): import('../mcp/mcp-client.js').McpClientManager | null {
  return mcpManager;
}

export function registerMCPTool(): void {
  if (initialized) return;
  initialized = true;
  registerTool({
    type: 'function',
    function: {
      name: 'MCPTool',
      description: 'Call a tool on a connected MCP server. Use "mcp__list" as serverName to list tools, "mcp__resources" to list/read resources, or "mcp__prompts" to list/get prompts.',
      parameters: {
        type: 'object',
        properties: {
          serverName: { type: 'string', description: 'The MCP server name, "mcp__list", "mcp__resources", or "mcp__prompts".' },
          toolName: { type: 'string', description: 'The tool name, "list"/"read" for resources, or "list"/"get" for prompts.' },
          arguments: { type: 'object', description: 'Tool arguments. For resource read include { uri: "..." }, for prompt get include { name: "...", args: {...} }.' },
        },
        required: ['serverName', 'toolName', 'arguments'],
      },
    },
  }, async (args: Record<string, unknown>) => {
    const serverName = args.serverName as string;
    const toolName = args.toolName as string;
    const toolArgs = (args.arguments ?? {}) as Record<string, unknown>;
    if (!mcpManager) return JSON.stringify({ error: 'MCP not initialized.' });
    if (serverName === 'mcp__list') {
      const all = mcpManager.listAllTools();
      const byServer: Record<string, Array<{ name: string; description: string }>> = {};
      for (const t of all) {
        (byServer[t.serverName] ??= []).push({ name: t.toolName, description: t.description });
      }
      return JSON.stringify({ servers: mcpManager.getConnectedServerNames(), toolsByServer: byServer });
    }
    // P7: MCP resources
    if (serverName === 'mcp__resources') {
      if (toolName === 'list') {
        const all = mcpManager.listAllResources();
        const byServer: Record<string, Array<{ name: string; uri: string; mimeType?: string }>> = {};
        for (const r of all) {
          (byServer[r.serverName] ??= []).push({ name: r.name, uri: r.uri, mimeType: r.mimeType });
        }
        return JSON.stringify({
          servers: mcpManager.getConnectedServerNames(),
          resourceCount: mcpManager.totalResourceCount(),
          resourcesByServer: byServer,
        });
      }
      if (toolName === 'read') {
        const uri = (toolArgs.uri ?? toolArgs.url ?? '') as string;
        if (!uri) {
          return JSON.stringify({ error: 'resource URI required for read. Include arguments.uri.' });
        }
        // Resolve the real MCP server name from the resource URI
        const resource = mcpManager.listAllResources().find(r => r.uri === uri);
        if (!resource) {
          return JSON.stringify({ error: `resource not found for URI "${uri}". Use "list" to see available resources.` });
        }
        return mcpManager.readResource(resource.serverName, uri);
      }
      return JSON.stringify({ error: `unknown mcp__resources action "${toolName}". Use "list" or "read".` });
    }
    // P8: MCP prompts
    if (serverName === 'mcp__prompts') {
      if (toolName === 'list') {
        const all = mcpManager.listAllPrompts();
        const byServer: Record<string, Array<{ name: string; description?: string }>> = {};
        for (const p of all) {
          (byServer[p.serverName] ??= []).push({ name: p.name, description: p.description });
        }
        return JSON.stringify({
          servers: mcpManager.getConnectedServerNames(),
          promptCount: mcpManager.totalPromptCount(),
          promptsByServer: byServer,
        });
      }
      if (toolName === 'get') {
        const promptName = (toolArgs.name ?? toolArgs.promptName ?? '') as string;
        if (!promptName) {
          return JSON.stringify({ error: 'prompt name required for get. Include arguments.name.' });
        }
        // Resolve the real MCP server name from the prompt name
        const prompt = mcpManager.listAllPrompts().find(p => p.name === promptName);
        if (!prompt) {
          return JSON.stringify({ error: `prompt not found for name "${promptName}". Use "list" to see available prompts.` });
        }
        const promptArgs = (toolArgs.args ?? undefined) as Record<string, string> | undefined;
        return mcpManager.getPrompt(prompt.serverName, promptName, promptArgs);
      }
      return JSON.stringify({ error: `unknown mcp__prompts action "${toolName}". Use "list" or "get".` });
    }
        return mcpManager.callTool(serverName, toolName, toolArgs);
  });
}
