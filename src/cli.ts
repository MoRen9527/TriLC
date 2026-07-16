#!/usr/bin/env node
// ── TriLC CLI ──
// Provides start/stop/status/run commands for the TriLC daemon.
// CTO-008-P P.1: CLI entry point for PC desktop packaging.

import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, unlink, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──
const DEFAULT_PORT = 8711;
const PID_DIR = resolve(homedir(), '.trimetaverse');
const PID_FILE = resolve(PID_DIR, 'trilc.pid');
const HEALTHZ_TIMEOUT_MS = 3000;

// ── Help ──
function printHelp(): void {
  console.log(`TriLC (Local Controller) — TriMetaverse Desktop Daemon

Usage: trilc <command> [options]

Commands:
  start   Start daemon in background       trilc start [--port 8711]
  stop    Stop background daemon           trilc stop
  status  Show daemon status               trilc status [--port 8711]
  run     Run daemon in foreground         trilc run [--port 8711]

Options:
  --port <n>   Port for HTTP server (default: ${DEFAULT_PORT})`);
}

// ── Argument parsing ──
function parseArgs(args: string[]): { command: string; port: number } {
  const command = args[0] ?? 'help';
  let port = DEFAULT_PORT;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    }
  }

  return { command, port };
}

// ── PID file management ──
async function ensurePidDir(): Promise<void> {
  try {
    await access(PID_DIR, constants.F_OK);
  } catch {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(PID_DIR, { recursive: true });
  }
}

async function readPid(): Promise<number | null> {
  try {
    const content = await readFile(PID_FILE, 'utf-8');
    return parseInt(content.trim(), 10);
  } catch {
    return null;
  }
}

async function writePid(pid: number): Promise<void> {
  await ensurePidDir();
  await writeFile(PID_FILE, String(pid), 'utf-8');
}

async function removePidFile(): Promise<void> {
  try {
    await unlink(PID_FILE);
  } catch {
    // ignore — file may not exist
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── HTTP health check ──
async function healthCheck(port: number): Promise<{ ok: boolean; data?: unknown }> {
  const url = `http://127.0.0.1:${port}/healthz`;

  return new Promise((resolve) => {
    import('node:http').then((http) => {
      const req = http.get(url, { timeout: HEALTHZ_TIMEOUT_MS }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            resolve({ ok: true, data: JSON.parse(body) });
          } catch {
            resolve({ ok: true, data: { raw: body } });
          }
        });
      });
      req.on('error', () => resolve({ ok: false }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false });
      });
    });
  });
}

// ── Commands ──

async function cmdStart(port: number): Promise<void> {
  const existingPid = await readPid();
  if (existingPid && isProcessAlive(existingPid)) {
    console.log(`[trilc] daemon already running (pid=${existingPid})`);
    return;
  }

  // Clean up stale PID file
  await removePidFile();

  const entryPoint = resolve(__dirname, 'index.js');
  const child: ChildProcess = spawn(
    process.execPath,
    [entryPoint],
    {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, TRILC_PORT: String(port) },
    },
  );

  child.unref();

  if (!child.pid) {
    console.error('[trilc] failed to spawn daemon');
    process.exit(1);
  }

  await writePid(child.pid);
  console.log(`[trilc] daemon started (pid=${child.pid} port=${port})`);

  // Give it a moment to bind
  await new Promise((r) => setTimeout(r, 500));
}

async function cmdStop(): Promise<void> {
  const pid = await readPid();
  if (!pid) {
    console.log('[trilc] no daemon running (no PID file)');
    return;
  }

  if (!isProcessAlive(pid)) {
    console.log(`[trilc] daemon not running (stale pid=${pid})`);
    await removePidFile();
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
    console.log(`[trilc] daemon stopped (pid=${pid})`);
  } catch (err) {
    console.error(`[trilc] failed to stop daemon (pid=${pid}):`, (err as Error).message);
  }

  await removePidFile();
}

async function cmdStatus(port: number): Promise<void> {
  const pid = await readPid();
  const alive = pid ? isProcessAlive(pid) : false;
  const health = alive ? await healthCheck(port) : { ok: false };

  const status = {
    running: alive,
    pid: pid ?? null,
    port,
    healthz: health.ok,
    healthData: health.data ?? null,
  };

  console.log(JSON.stringify(status, null, 2));
}

async function cmdRun(port: number): Promise<void> {
  // Foreground mode: set env port and run main
  process.env.TRILC_PORT = String(port);

  // index.ts runs main() at top level when imported
  await import('./index.js');
}

// ── Entry ──
const { command, port } = parseArgs(process.argv.slice(2));

(async () => {
  switch (command) {
    case 'start':
      await cmdStart(port);
      break;
    case 'stop':
      await cmdStop();
      break;
    case 'status':
      await cmdStatus(port);
      break;
    case 'run':
      await cmdRun(port);
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`[trilc] unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
})().catch((err) => {
  console.error('[trilc] CLI error:', err);
  process.exit(1);
});
