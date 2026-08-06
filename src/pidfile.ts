// ── PID file + process identity management (REQ-018) ──
// The daemon OWNS its PID file: it registers on successful listen and
// unregisters on graceful shutdown/exit. The CLI (manager side) reads,
// verifies and cleans up, falling back to port-based process discovery
// when the PID file is missing (pre-REQ-018 foreground runs, foreign
// owners like nssm/tricade).
//
// Module is side-effect-free at import time so unit tests can load it
// directly (unlike cli.ts, which executes its command dispatch on import).
import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import { PID_DIR, PID_FILE } from './paths.js';

const execFileAsync = promisify(execFile);

// ── PID file primitives ──

export async function ensurePidDir(): Promise<void> {
  try {
    await access(PID_DIR, constants.F_OK);
  } catch {
    await mkdir(PID_DIR, { recursive: true });
  }
}

export async function readPid(): Promise<number | null> {
  try {
    const content = await readFile(PID_FILE, 'utf-8');
    const pid = parseInt(content.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Atomic PID write: write tmp sibling then rename — readers never observe partial content. */
export async function writePid(pid: number): Promise<void> {
  await ensurePidDir();
  const tmp = `${PID_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, `${pid}\n`, 'utf-8');
  await rename(tmp, PID_FILE);
}

export async function removePidFile(): Promise<void> {
  try {
    await unlink(PID_FILE);
  } catch {
    // ignore — file may not exist
  }
}

// ── Daemon-side registration (owner) ──

/** Daemon startup: register this process's PID (called after server listen succeeds). */
export async function registerPid(): Promise<void> {
  await writePid(process.pid);
}

/** Daemon shutdown: remove the PID file only if it still names this process. */
export async function unregisterPid(): Promise<void> {
  const pid = await readPid();
  if (pid !== null && pid === process.pid) {
    await removePidFile();
  }
}

// ── Process liveness ──

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until the process exits or the timeout elapses. Resolves true when the process is dead. */
export async function waitProcessExit(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !isProcessAlive(pid);
}

// ── Port-based process discovery (fallback when PID file is missing) ──

/**
 * Pure parser for `netstat -ano -p tcp` output. Exported for unit testing.
 * Column-based (robust against greedy-token regex backtracking traps):
 * - Windows: [proto, local, foreign, state, pid]
 * - Linux:   [proto, recv-q, send-q, local, foreign, state, pid]
 */
export function parseNetstatPid(netstatOutput: string, port: number): { pid: number; proto: string } | null {
  for (const rawLine of netstatOutput.split(/\r?\n/)) {
    const cols = rawLine.trim().split(/\s+/);
    if (cols.length < 5) continue;
    if (!/^tcp$/i.test(cols[0])) continue;

    let local = cols[1];
    let stateIdx = 3;
    if (cols.length >= 7 && /^\d+$/.test(cols[1]) && /^\d+$/.test(cols[2])) {
      // Linux style: [tcp, recv-q, send-q, local, foreign, state, pid]
      local = cols[3];
      stateIdx = 5;
    }

    const m = local.match(/^(\S+):(\d+)$/);
    if (!m) continue;
    const state = cols[stateIdx];
    if (state !== 'LISTENING' && state !== 'LISTEN') continue;
    if (m[2] === String(port) && m[1] === '127.0.0.1') {
      const pid = parseInt(cols[stateIdx + 1], 10);
      if (Number.isFinite(pid)) return { pid, proto: state.toUpperCase() };
    }
  }
  return null;
}

/** Locate the process listening on 127.0.0.1:port (Windows netstat / POSIX lsof|ss). */
export async function findProcessByPort(port: number): Promise<{ pid: number; proto: string } | null> {
  if (platform() === 'win32') {
    try {
      const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp']);
      return parseNetstatPid(stdout, port);
    } catch {
      return null;
    }
  }
  // POSIX: lsof first (exact LISTEN filter), then ss fallback
  try {
    const { stdout } = await execFileAsync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN']);
    const first = stdout.trim().split(/\r?\n/)[0];
    const pid = parseInt(first, 10);
    if (Number.isFinite(pid)) return { pid, proto: 'LSOF' };
  } catch { /* lsof unavailable */ }
  try {
    const { stdout } = await execFileAsync('ss', ['-tlnp', `sport = :${port}`]);
    const m = stdout.match(/pid=(\d+)/);
    if (m) return { pid: parseInt(m[1], 10), proto: 'SS' };
  } catch { /* ss unavailable */ }
  return null;
}
