// ── Skills Directory Loader (CC-equivalent)
// Loads skills from .claude/skills/ directories.
// Supports directory format: skill-name/SKILL.md

import { mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, sep as pathSep } from 'node:path';
import { parseFrontmatter } from '../utils/frontmatter.js';

export interface SkillCommand {
  type: 'prompt';
  name: string;
  description: string;
  hasUserSpecifiedDescription: boolean;
  allowedTools: string[];
  argumentHint?: string;
  argNames?: string[];
  whenToUse?: string;
  version?: string;
  model?: string;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  source: 'skills' | 'commands_DEPRECATED' | 'bundled' | 'plugin';
  loadedFrom: 'skills' | 'commands_DEPRECATED' | 'bundled' | 'mcp' | 'plugin' | 'managed';
  isHidden: boolean;
  progressMessage: string;
  contentLength: number;
  skillRoot?: string;
  context?: 'inline' | 'fork';
  agent?: string;
  getPromptForCommand: (args: string) => Promise<string>;
}

export type LoadedFrom =
  | 'commands_DEPRECATED'
  | 'skills'
  | 'plugin'
  | 'managed'
  | 'bundled'
  | 'mcp';

/**
 * Get the skills directory path for a given source.
 */
export function getSkillsPath(
  source: LoadedFrom | 'plugin',
  cwd: string,
): string {
  switch (source) {
    case 'managed':
      return join(cwd, '.claude', 'skills');
    case 'skills':
      return join(cwd, '.claude', 'skills');
    case 'plugin':
      return 'plugin';
    default:
      return '';
  }
}

/**
 * Parse frontmatter fields from a skill markdown file.
 */
function parseSkillFrontmatterFields(
  frontmatter: Record<string, unknown>,
  markdownContent: string,
  resolvedName: string,
  descriptionFallbackLabel: 'Skill' | 'Custom command' = 'Skill',
): {
  displayName: string | undefined;
  description: string;
  hasUserSpecifiedDescription: boolean;
  allowedTools: string[];
  argumentHint: string | undefined;
  argumentNames: string[];
  whenToUse: string | undefined;
  version: string | undefined;
  model: string | undefined;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  executionContext: 'fork' | undefined;
  agent: string | undefined;
} {
  const description = (frontmatter.description as string | undefined) ||
    extractDescriptionFromMarkdown(markdownContent, descriptionFallbackLabel);

  const userInvocable = frontmatter['user-invocable'] === undefined
    ? true
    : parseBooleanFrontmatter(frontmatter['user-invocable']);

  const model = frontmatter.model === 'inherit'
    ? undefined
    : typeof frontmatter.model === 'string'
      ? frontmatter.model
      : undefined;

  return {
    displayName: typeof frontmatter.name === 'string' ? frontmatter.name : undefined,
    description,
    hasUserSpecifiedDescription: typeof frontmatter.description === 'string',
    allowedTools: parseSlashCommandToolsFromFrontmatter(
      frontmatter['allowed-tools'],
    ),
    argumentHint: typeof frontmatter['argument-hint'] === 'string'
      ? frontmatter['argument-hint']
      : undefined,
    argumentNames: parseArgumentNames(
      frontmatter.arguments as string | string[] | undefined,
    ),
    whenToUse: frontmatter.when_to_use as string | undefined,
    version: frontmatter.version as string | undefined,
    model,
    disableModelInvocation: parseBooleanFrontmatter(
      frontmatter['disable-model-invocation'],
    ),
    userInvocable,
    executionContext: frontmatter.context === 'fork' ? 'fork' : undefined,
    agent: frontmatter.agent as string | undefined,
  };
}

/**
 * Creates a skill command from parsed data.
 */
function createSkillCommand({
  skillName,
  displayName,
  description,
  hasUserSpecifiedDescription,
  markdownContent,
  allowedTools,
  argumentHint,
  argumentNames,
  whenToUse,
  version,
  model,
  disableModelInvocation,
  userInvocable,
  source,
  baseDir,
  loadedFrom,
  executionContext,
  agent,
}: {
  skillName: string;
  displayName: string | undefined;
  description: string;
  hasUserSpecifiedDescription: boolean;
  markdownContent: string;
  allowedTools: string[];
  argumentHint: string | undefined;
  argumentNames: string[];
  whenToUse: string | undefined;
  version: string | undefined;
  model: string | undefined;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  source: 'skills' | 'commands_DEPRECATED' | 'bundled' | 'plugin';
  baseDir: string | undefined;
  loadedFrom: LoadedFrom;
  executionContext: 'inline' | 'fork' | undefined;
  agent: string | undefined;
}): SkillCommand {
  return {
    type: 'prompt',
    name: skillName,
    description,
    hasUserSpecifiedDescription,
    allowedTools,
    argumentHint,
    argNames: argumentNames.length > 0 ? argumentNames : undefined,
    whenToUse,
    version,
    model,
    disableModelInvocation,
    userInvocable,
    context: executionContext,
    agent,
    contentLength: markdownContent.length,
    isHidden: !userInvocable,
    progressMessage: 'running',
    source,
    loadedFrom,
    skillRoot: baseDir,
    async getPromptForCommand(args: string) {
      let finalContent = baseDir
        ? `Base directory for this skill: ${baseDir}\n\n${markdownContent}`
        : markdownContent;

      // Substitute arguments (simple $ARGUMENTS replacement)
      if (args) {
        finalContent = finalContent.replace(/\$ARGUMENTS/g, args);
      }

      // Replace ${CLAUDE_SKILL_DIR} with skill directory
      if (baseDir) {
        const skillDir =
          process.platform === 'win32' ? baseDir.replace(/\\/g, '/') : baseDir;
        finalContent = finalContent.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir);
      }

      return finalContent;
    },
  };
}

/**
 * Loads skills from a /skills/ directory path.
 * Only supports directory format: skill-name/SKILL.md
 */
async function loadSkillsFromSkillsDir(
  basePath: string,
  source: LoadedFrom,
): Promise<SkillCommand[]> {
  if (!existsSync(basePath)) {
    return [];
  }

  const results: SkillCommand[] = [];

  try {
    const entries = await readdir(basePath, { withFileTypes: true });

    for (const entry of entries) {
      try {
        // Only support directory format: skill-name/SKILL.md
        if (!entry.isDirectory()) {
          continue;
        }

        const skillDirPath = join(basePath, entry.name);
        const skillFilePath = join(skillDirPath, 'SKILL.md');

        if (!existsSync(skillFilePath)) {
          continue;
        }

        const content = await readFile(skillFilePath, { encoding: 'utf-8' });
        const { frontmatter, content: markdownContent } = parseFrontmatter(
          content,
          skillFilePath,
        );

        const skillName = entry.name;
        const parsed = parseSkillFrontmatterFields(
          frontmatter,
          markdownContent,
          skillName,
        );

        const skill = createSkillCommand({
          ...parsed,
          skillName,
          markdownContent,
          source: 'skills',
          baseDir: skillDirPath,
          loadedFrom: 'skills',
          executionContext: parsed.executionContext,
          agent: parsed.agent,
        });

        results.push(skill);
      } catch (error) {
        console.error(`[skills] failed to load skill from ${entry.name}:`, error);
      }
    }
  } catch (error) {
    console.error(`[skills] failed to read directory ${basePath}:`, error);
  }

  return results;
}

/**
 * Load all skills from the current working directory.
 */
export async function loadSkills(cwd: string = process.cwd()): Promise<SkillCommand[]> {
  const skillsDir = join(cwd, '.claude', 'skills');
  const skills = await loadSkillsFromSkillsDir(skillsDir, 'skills');
  console.log(`[skills] loaded ${skills.length} skills from ${skillsDir}`);
  return skills;
}

// ── Helper functions (simplified from CC) ──

function extractDescriptionFromMarkdown(
  content: string,
  label: string,
): string {
  // Try to extract from first paragraph
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      return trimmed.slice(0, 200) + (trimmed.length > 200 ? '...' : '');
    }
  }
  return `${label} (no description)`;
}

function parseBooleanFrontmatter(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value === 'true' || value === 'yes' || value === '1';
  }
  return false;
}

function parseSlashCommandToolsFromFrontmatter(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.map((v) => String(v)).filter(Boolean);
  }
  return [];
}

function parseArgumentNames(value: string | string[] | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}
