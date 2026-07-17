// ── Work-Tree Safety Check ──
// Post-recovery safety inspection:
//   1. git diff --stat → detect uncommitted changes
//   2. Basic type check → detect build errors from incomplete edits
//   3. Risk level classification
//
// This runs after session recovery to answer W29 第3问:
//   "长会话异常中断后，如何把会话恢复与工作树恢复组合成可自动执行的安全检查？"

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkTreeSafetyReport } from './types.js';

export function runSafetyCheck(cwd: string): WorkTreeSafetyReport {
  const report: WorkTreeSafetyReport = {
    cwd,
    hasUncommittedChanges: false,
    changedFiles: [],
    typeCheckPassed: null,
    riskLevel: 'low',
  };

  // 1. Check git status
  try {
    const diffStat = execSync('git diff --stat', {
      cwd,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

    if (diffStat) {
      report.hasUncommittedChanges = true;
      const lines = diffStat.split('\n');
      // Extract file paths from git diff --stat output (format: " file.ts | 5 +++--")
      for (const line of lines) {
        const match = line.match(/^\s*(.+?)\s+\|/);
        if (match) {
          report.changedFiles.push(match[1].trim());
        }
      }
    }

    // Also check untracked files
    const untracked = execSync('git ls-files --others --exclude-standard', {
      cwd,
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (untracked) {
      report.changedFiles.push(...untracked.split('\n').filter(Boolean).map((f) => `[untracked] ${f}`));
      report.hasUncommittedChanges = true;
    }
  } catch {
    // Not a git repo or git not available — skip
  }

  // 2. Basic type check (tsc --noEmit if tsconfig.json exists)
  try {
    if (existsSync(join(cwd, 'tsconfig.json'))) {
      execSync('npx tsc --noEmit', {
        cwd,
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      report.typeCheckPassed = true;
    }
  } catch (err) {
    const msg = err instanceof Error ? (err as unknown as { stdout?: string; stderr?: string }).stderr || err.message : String(err);
    // Only mark as failed if there are actual type errors (not config/missing dep issues)
    if (msg.includes('error TS')) {
      report.typeCheckPassed = false;
    }
  }

  // 3. Risk classification
  if (report.typeCheckPassed === false) {
    report.riskLevel = 'high';
  } else if (report.hasUncommittedChanges && report.changedFiles.length > 3) {
    report.riskLevel = 'medium';
  } else if (report.hasUncommittedChanges) {
    report.riskLevel = 'low';
  }

  return report;
}
