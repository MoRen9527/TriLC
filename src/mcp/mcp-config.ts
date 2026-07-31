// ── MCP Configuration Loader (P6) ──
// Reads MCP server definitions from .claude/mcp.json (CC-compatible format)
// and project-local .trilc/mcp.json (TriLC-specific).
//
// CC format (.claude/mcp.json):
// {
//   "mcpServers": {
//     "server-name": {
//       "type": "stdio" | "sse" | "streamableHttp",
//       "command": "npx",
//       "args": ["-y", "@anthropic/mcp-server-filesystem"],
//       "env": { "KEY": "value" },
//       "url": "http://..."  // for SSE type
//     }
//   }
// }

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type MCPServerType = 'stdio' | 'sse' | 'streamableHttp';

export interface MCPServerConfig {
  name: string;
  type: MCPServerType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  cwd?: string;
  disabled?: boolean;
}

interface McpConfigFile {
  mcpServers?: Record<string, {
    type?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    cwd?: string;
    disabled?: boolean;
  }>;
}

function normalizeType(raw?: string): MCPServerType {
  if (raw === 'sse') return 'sse';
  if (raw === 'streamableHttp' || raw === 'streamable_http') return 'streamableHttp';
  return 'stdio'; // default
}

function parseConfigFile(filepath: string): McpConfigFile | null {
  try {
    if (!existsSync(filepath)) return null;
    const raw = readFileSync(filepath, 'utf-8');
    return JSON.parse(raw) as McpConfigFile;
  } catch {
    return null;
  }
}

/**
 * Load MCP server configurations from all standard locations.
 * Priority: project-local takes precedence over user-global.
 */
export function loadMCPServerConfigs(cwd?: string): MCPServerConfig[] {
  const configs: MCPServerConfig[] = [];
  const seen = new Set<string>();

  // 1. User-global config: ~/.claude/mcp.json
  const globalPath = join(homedir(), '.claude', 'mcp.json');
  const globalConfig = parseConfigFile(globalPath);

  // 2. Project-local config: {cwd}/.claude/mcp.json
  const projectPath = cwd ? join(cwd, '.claude', 'mcp.json') : null;
  const projectConfig = projectPath ? parseConfigFile(projectPath) : null;

  // 3. TriLC-specific: {cwd}/.trilc/mcp.json (highest priority)
  const trilcPath = cwd ? join(cwd, '.trilc', 'mcp.json') : null;
  const trilcConfig = trilcPath ? parseConfigFile(trilcPath) : null;

  // Merge: trilc > project > global
  const sources: Array<McpConfigFile | null> = [trilcConfig, projectConfig, globalConfig];
  for (const config of sources) {
    if (!config?.mcpServers) continue;
    for (const [name, serverDef] of Object.entries(config.mcpServers)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const sd = serverDef as Record<string, unknown>;
      if (sd.disabled) continue;
      configs.push({
        name,
        type: normalizeType(sd.type as string | undefined),
        command: sd.command as string | undefined,
        args: sd.args as string[] | undefined,
        env: sd.env as Record<string, string> | undefined,
        url: sd.url as string | undefined,
        cwd: sd.cwd as string | undefined,
      });
    }
  }

  return configs;
}
