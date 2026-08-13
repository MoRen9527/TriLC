// ── TriLC AgentTool (P1 A级复制 - 子代理能力跃升) ──
// A级直接复制 from CC: src/tools/AgentTool/AgentTool.tsx
// 适配说明：
// - CC 使用复杂的 teammate/bridge 系统 → TriLC 使用 agent-core spawnAgent 进程内递归
// - CC 支持 worktree/remote isolation → TriLC 简化为基础进程内隔离
// - CC 有复杂的 agent 加载系统 → TriLC 使用 agent-core built-in agents

import { register as registerTool } from '@tricompany/agent-core';
import { spawnAgent, getBuiltInAgent, listBuiltInAgents } from '@tricompany/agent-core';
import type { AgentDefinition, SpawnConfig } from '@tricompany/agent-core';

// ── Helper: List agents for /agents command ──
// Fetches built-in agents from agent-core + company agents from the TriMC
// company endpoint (装后验收③：chat /agents 需接 company 视图——TriMC
// /internal/v1/agents 返回员工注册表，count 14 已实证）。
export async function listAgentsForDisplay(): Promise<string> {
  const builtIn = listBuiltInAgents().map(a => ({ name: a.name, description: a.description }));
  let contractAgents: Array<{ name: string; description: string }> = [];

  try {
    const trimcBase = process.env.TRIMC_BASE_URL ?? 'http://127.0.0.1:8710';
    const res = await fetch(`${trimcBase}/internal/v1/agents`);
    const json = await res.json() as {
      ok: boolean;
      agents?: Array<{ agentId?: string; name?: string; sessionId?: string }>;
    };
    if (json.ok && json.agents) {
      contractAgents = json.agents.map(a => ({
        name: a.agentId ?? a.name ?? 'unknown',
        description: a.name || a.agentId || 'company agent',
      }));
    }
  } catch { /* company endpoint unreachable — built-in only */ }

  const all = [...builtIn, ...contractAgents];
  if (all.length === 0) return 'No agents available.';

  const header = 'Available Sub-Agents:\n';
  const lines = all.map(a => `  • ${a.name} — ${a.description}`);
  return header + lines.join('\n');
}

// ── AgentTool ──
// CC-equivalent sub-agent spawning tool - enables AI to delegate tasks to specialized sub-agents
// This is the core capability leap: "派一个子代理去完成子任务"
export function registerAgentTool(): void {
  registerTool(
    {
      type: 'function',
      function: {
        name: 'AgentTool',
        description: 'Spawn a sub-agent to complete a task. The sub-agent runs with its own context window and tool access, then returns the result to the main conversation.\n\n## When to Use\n\n- Delegate complex sub-tasks to specialized agents (e.g., "search codebase", "implement function")\n- Parallelize independent work streams\n- Isolate context for focused problem-solving\n\n## Parameters\n\n- `description`: Brief task description (3-5 words)\n- `prompt`: The detailed task for the agent\n- `subagent_type`: Type of specialized agent (optional, defaults to "code_explorer")\n- `model`: Model override (optional: "sonnet", "opus", "haiku")\n\n## Available Sub-agent Types\n\n' + listBuiltInAgents().map(a => `- \`${a.name}\`: ${a.description}`).join('\n'),
        parameters: {
          type: 'object',
          properties: {
            description: {
              type: 'string',
              description: 'A short (3-5 word) description of the task',
            },
            prompt: {
              type: 'string',
              description: 'The task for the agent to perform',
            },
            subagent_type: {
              type: 'string',
              description: 'The type of specialized agent to use (optional, defaults to "code_explorer")',
            },
            model: {
              type: 'string',
              enum: ['sonnet', 'opus', 'haiku'],
              description: 'Optional model override',
            },
          },
          required: ['description', 'prompt'],
        },
      },
    },
    async (args: Record<string, unknown>) => {
      const description = args.description as string;
      const prompt = args.prompt as string;
      const subagentType = args.subagent_type as string | undefined;
      const model = args.model as string | undefined;

      if (!description || !description.trim()) {
        return JSON.stringify({ error: 'description is required' });
      }
      if (!prompt || !prompt.trim()) {
        return JSON.stringify({ error: 'prompt is required' });
      }

      // Get agent definition by type or default to code_explorer.
      // First try built-in agents, then fall back to daemon contract agents.
      const agentType = subagentType || 'code_explorer';
      let agentDef = getBuiltInAgent(agentType);

      if (!agentDef) {
        // Try contract-resolver agents loaded by the daemon (12 TriCompany employees)
        try {
          const res = await fetch('http://localhost:8711/internal/v1/agents');
          const json = await res.json() as { ok: boolean; agents?: Array<{ id: string; name?: string; systemPrompt?: string }> };
          if (json.ok && json.agents) {
            const match = json.agents.find(a => a.id === agentType);
            if (match) {
              // Synthesize a basic AgentDefinition for the contract agent
              agentDef = {
                name: match.id,
                description: match.name || match.id,
                systemPrompt: match.systemPrompt,
              } as AgentDefinition;
            }
          }
        } catch { /* daemon unreachable — will fall through to error */ }

        if (!agentDef) {
          const builtIn = listBuiltInAgents().map(a => a.name).join(', ');
          return JSON.stringify({
            error: `Unknown agent type: ${agentType}. Available built-in: ${builtIn}. Daemon agents available via /agents.`,
          });
        }
      }

      // Build spawn config
      const config: SpawnConfig = {
        agent: {
          ...agentDef,
          model: model || agentDef.model,
        },
        task: prompt,
        maxTurns: agentDef.maxTurns || 10,
      };

      // Run sub-agent and collect results
      let finalResult = '';
      let toolCalls: string[] = [];
      let status: 'running' | 'completed' | 'error' = 'running';

      try {
        for await (const event of spawnAgent(config)) {
          switch (event.type) {
            case 'start':
              status = 'running';
              break;
            case 'message':
              if (event.data && typeof event.data === 'object' && 'content' in event.data) {
                finalResult = String((event.data as { content: string }).content);
              }
              break;
            case 'tool_call':
              if (event.data && typeof event.data === 'object' && 'tool' in event.data) {
                toolCalls.push(String((event.data as { tool: string }).tool));
              }
              break;
            case 'done':
              status = 'completed';
              break;
            case 'error':
              status = 'error';
              finalResult = event.data && typeof event.data === 'object' && 'message' in event.data
                ? String((event.data as { message: string }).message)
                : 'Unknown error';
              break;
          }
        }
      } catch (err) {
        status = 'error';
        finalResult = err instanceof Error ? err.message : String(err);
      }

      return JSON.stringify({
        status,
        description,
        prompt,
        result: finalResult,
        toolCalls,
        agentUsed: agentType,
      });
    },
  );
}

// Export for testing and /agents command
export { spawnAgent, getBuiltInAgent, listBuiltInAgents };
