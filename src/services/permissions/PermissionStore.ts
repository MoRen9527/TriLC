// ── Permission Store: persistent allow rules ──
// P6: Persists user's "Always allow" decisions to
// ~/.trimetaverse/trilc-permissions.json so they survive daemon restarts.
//
// CC equivalent: settings.json permissions.allow array — but simplified:
// TriLC uses tool-name-level matching (no regex matchers in MVP).
//
// File format:
// {
//   "version": 1,
//   "allow": [
//     { "toolName": "Bash", "createdAt": "2026-07-29T12:00:00.000Z" },
//     { "toolName": "Write", "createdAt": "2026-07-29T12:30:00.000Z" }
//   ]
// }

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export interface PermissionRule {
  toolName: string;
  behavior: 'allow';
  /** ISO 8601 timestamp of when this rule was created. */
  createdAt: string;
}

interface PermissionFile {
  version: number;
  allow: PermissionRule[];
}

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

/** Read the persisted permission file. Returns empty if file doesn't exist. */
function readPermissionFile(): PermissionFile {
  const filePath = getPermissionsFilePath();
  if (!existsSync(filePath)) {
    return { version: 1, allow: [] };
  }
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as PermissionFile;
    if (!parsed.version || !Array.isArray(parsed.allow)) {
      // Corrupted or old format — reset
      return { version: 1, allow: [] };
    }
    return parsed;
  } catch {
    return { version: 1, allow: [] };
  }
}

/** Write the permission file atomically (write to temp then rename). */
function writePermissionFile(data: PermissionFile): void {
  ensureConfigDir();
  const filePath = getPermissionsFilePath();
  writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Load persisted allow rules from disk.
 * Returns the set of tool names that the user has permanently allowed.
 */
export function loadPersistedAllowRules(): Set<string> {
  const data = readPermissionFile();
  const rules = data.allow.filter(r => r.behavior === 'allow');
  return new Set(rules.map(r => r.toolName));
}

/**
 * Persist an "always allow" rule for a tool.
 * If the tool already has a persisted rule, this is a no-op.
 */
export function persistAllowRule(toolName: string): void {
  const data = readPermissionFile();
  // Deduplicate: if a rule for this toolName already exists, skip
  if (data.allow.some(r => r.toolName === toolName && r.behavior === 'allow')) {
    return;
  }
  data.allow.push({
    toolName,
    behavior: 'allow',
    createdAt: new Date().toISOString(),
  });
  writePermissionFile(data);
}

/**
 * Remove a persisted allow rule for a tool.
 */
export function removePersistAllowRule(toolName: string): void {
  const data = readPermissionFile();
  data.allow = data.allow.filter(r => !(r.toolName === toolName && r.behavior === 'allow'));
  writePermissionFile(data);
}

/**
 * Get all persisted allow rules (for display/debugging).
 */
export function listPersistedAllowRules(): PermissionRule[] {
  return readPermissionFile().allow;
}
