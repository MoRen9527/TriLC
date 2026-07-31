// ── SkillTool (CC-equivalent)
// Tool that allows AI to invoke skills (slash commands).
// Based on Claude Code's SkillTool implementation.
// Uses agent-core tool registration (ToolDefinition + ToolHandler).

import type { ToolDefinition } from 'trimodel';
import { register as registerTool } from '@trimetaverse/agent-core';

export interface SkillToolInput {
  skill: string;
  args?: string;
}

// In-memory skill registry (populated by CLI/TUI)
const skillRegistry: Map<string, {
  getPromptForCommand: (args: string) => Promise<string>;
  description: string;
  allowedTools: string[];
  model?: string;
}> = new Map();

/**
 * Register a skill for use by SkillTool.
 */
export function registerSkillForTool(
  name: string,
  skill: {
    getPromptForCommand: (args: string) => Promise<string>;
    description: string;
    allowedTools: string[];
    model?: string;
  },
): void {
  skillRegistry.set(name, skill);
}

/**
 * Unregister a skill.
 */
export function unregisterSkillForTool(name: string): void {
  skillRegistry.delete(name);
}

/**
 * Get all registered skill names.
 */
export function getRegisteredSkillNames(): string[] {
  return Array.from(skillRegistry.keys());
}

/**
 * Clear all registered skills.
 */
export function clearRegisteredSkills(): void {
  skillRegistry.clear();
}

/**
 * Create the SkillTool definition for agent-core.
 */
function createSkillToolDef(): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'skill',
      description: 'Execute a skill (slash command) by name. Skills are pre-built instruction sets that guide the AI through specific workflows.',
      parameters: {
        type: 'object',
        properties: {
          skill: {
            type: 'string',
            description: 'The skill name to execute (e.g., "commit", "review-pr", "pdf"). Do not include the leading slash.',
          },
          args: {
            type: 'string',
            description: 'Optional arguments to pass to the skill.',
          },
        },
        required: ['skill'],
      },
    },
  };
}

/**
 * Execute a skill by name.
 */
async function executeSkillHandler(
  args: Record<string, unknown>,
): Promise<string> {
  const { skill, args: skillArgs } = args as { skill?: string; args?: string };

  if (!skill) {
    return JSON.stringify({ error: 'Missing required parameter: skill' });
  }

  // Remove leading slash if present
  const skillName = skill.startsWith('/') ? skill.slice(1) : skill;

  const skillImpl = skillRegistry.get(skillName);

  if (!skillImpl) {
    return JSON.stringify({
      error: `Unknown skill: ${skillName}`,
      available: getRegisteredSkillNames(),
    });
  }

  const prompt = await skillImpl.getPromptForCommand(skillArgs ?? '');

  // P3-fix: guard against allowedTools being undefined (third-party registry
  // callers may omit it; daemon path uses `?? []` but this is defense-in-depth).
  const allowed = skillImpl.allowedTools ?? [];

  return JSON.stringify({
    success: true,
    commandName: skillName,
    allowedTools: allowed.length > 0 ? allowed : undefined,
    model: skillImpl.model,
    status: 'inline',
    result: prompt,
  });
}

/**
 * Register SkillTool with agent-core.
 */
export function registerSkillTool(): void {
  registerTool(createSkillToolDef(), executeSkillHandler);
}
