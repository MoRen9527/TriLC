// ── Permission Store: persistent allow/deny rules (C9 v2) ──
// Persists user's permission decisions to ~/.trimetaverse/trilc-permissions.json
// so they survive daemon restarts.
//
// CC equivalent: settings.json permissions.allow + permissions.deny arrays.
//
// File format v2:
// {
//   "version": 2,
//   "rules": [
//     { "toolName": "Bash", "behavior": "deny", "createdAt": "2026-08-12T12:00:00.000Z" },
//     { "toolName": "Edit", "behavior": "allow", "createdAt": "2026-08-12T12:30:00.000Z" }
//   ]
// }
//
// Backward compat: auto-migrates v1 format on read.
// v1: { "version": 1, "allow": [{ "toolName": "...", "behavior": "allow" }] }

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/** C9: Extended behavior type — matches agent-core PermissionBehavior. */
export type PersistedBehavior = 'allow' | 'deny';

export interface PersistedPermissionRule {
  toolName: string;
  behavior: PersistedBehavior;
  /** ISO 8601 timestamp of when this rule was created. */
  createdAt: string;
}

interface PermissionFileV2 {
  version: 2;
  rules: PersistedPermissionRule[];
}

interface PermissionFileV1 {
  version: 1;
  allow: Array<{ toolName: string; behavior: 'allow'; createdAt: string }>;
}

type PermissionFile = PermissionFileV2;

/** Path to the TriMetaverse configuration directory. */
function trimetaverseDir(): string {
  return join(homedir(), '.trimetaverse');
}

/** Full path to the persisted permissions file. */
export function getPermissionsFilePath(): string {
  return join(trimetaverseDir(), 'trilc-permissions.json');
}

/** Ensure the config directory exists (idempotent). */
function ensureConfigDir(): void {
  const dir = trimetaverseDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** Read and auto-migrate the permission file. */
function readPermissionFile(): PermissionFile {
  const filePath = getPermissionsFilePath();
  if (!existsSync(filePath)) {
    return { version: 2, rules: [] };
  }
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // v2 format
    if (parsed.version === 2 && Array.isArray(parsed.rules)) {
      return parsed as PermissionFileV2;
    }

    // v1 auto-migration
    if (parsed.version === 1 && Array.isArray((parsed as PermissionFileV1).allow)) {
      const v1 = parsed as PermissionFileV1;
      const rules: PersistedPermissionRule[] = v1.allow.map((r) => ({
        toolName: r.toolName,
        behavior: r.behavior,
        createdAt: r.createdAt,
      }));
      return { version: 2, rules };
    }

    // Unknown format — reset
    return { version: 2, rules: [] };
  } catch {
    return { version: 2, rules: [] };
  }
}

/** Write the permission file. */
function writePermissionFile(data: PermissionFile): void {
  ensureConfigDir();
  const filePath = getPermissionsFilePath();
  writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * C9: Load all persisted permission rules from disk.
 * Returns rules suitable for injecting into AgentLoopOptions.permissionRules.
 * Each rule includes toolName, behavior ('allow'|'deny'), and source='userSettings'.
 */
export function loadPersistedRules(): Array<{
  toolName: string;
  behavior: 'allow' | 'deny';
  source: 'userSettings';
}> {
  const data = readPermissionFile();
  return data.rules.map((r) => ({
    toolName: r.toolName,
    behavior: r.behavior,
    source: 'userSettings' as const,
  }));
}

/**
 * Legacy API: get the set of tool names with persisted 'allow' rules.
 * Kept for backward compat with existing callers.
 */
export function loadPersistedAllowRules(): Set<string> {
  const data = readPermissionFile();
  return new Set(data.rules.filter((r) => r.behavior === 'allow').map((r) => r.toolName));
}

/**
 * C9: Persist a permission rule (allow or deny).
 * Updates existing rule for the same toolName if present.
 */
export function persistRule(toolName: string, behavior: PersistedBehavior): void {
  const data = readPermissionFile();
  const existingIdx = data.rules.findIndex((r) => r.toolName === toolName);
  const rule: PersistedPermissionRule = {
    toolName,
    behavior,
    createdAt: new Date().toISOString(),
  };
  if (existingIdx >= 0) {
    data.rules[existingIdx] = rule;
  } else {
    data.rules.push(rule);
  }
  writePermissionFile(data);
}

/**
 * Legacy API: persist an 'allow' rule.
 */
export function persistAllowRule(toolName: string): void {
  persistRule(toolName, 'allow');
}

/**
 * C9: Remove a persisted rule for a tool.
 */
export function removePersistRule(toolName: string): void {
  const data = readPermissionFile();
  data.rules = data.rules.filter((r) => r.toolName !== toolName);
  writePermissionFile(data);
}

/**
 * Legacy API: remove a persisted 'allow' rule.
 */
export function removePersistAllowRule(toolName: string): void {
  removePersistRule(toolName);
}

/**
 * Get all persisted rules (for display/debugging).
 */
export function listPersistedRules(): PersistedPermissionRule[] {
  return readPermissionFile().rules;
}

/**
 * Legacy: alias for listPersistedRules.
 */
export function listPersistedAllowRules(): PersistedPermissionRule[] {
  return listPersistedRules();
}
