#!/usr/bin/env node
// ── TriLC CLI ──
// Provides start/stop/status/run commands for the TriLC daemon.
// CTO-008-P P.1: CLI entry point for PC desktop packaging.

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, unlink, access, mkdir } from 'node:fs/promises';
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
const DEFAULT_SERVICE_NAME = 'TriLC';
const REGRUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const REGRUN_VALUE = 'TriLC';

// ── Help ──
function printHelp(): void {
  console.log(`TriLC (Local Controller) — TriMetaverse Desktop Daemon

Usage: trilc <command> [options]

Commands:
  start              Start daemon in background       trilc start [--port 8711]
  stop               Stop background daemon           trilc stop
  status             Show daemon status               trilc status [--port 8711]
  run                Run daemon in foreground         trilc run [--port 8711]
  chat               Start TUI chat (auto-starts daemon) trilc chat [--port 8711] [--agent &lt;id&gt;] [--resume &lt;id&gt;] [--list-sessions]
  list-sessions      List all saved sessions            trilc list-sessions [--port 8711]
  install-service    Register as Windows Service       trilc install-service [--name TriLC] [--displayName "..."]
  uninstall-service  Unregister Windows Service        trilc uninstall-service [--name TriLC]
  install-regrun     Register to Registry Run (no-admin) trilc install-regrun
  uninstall-regrun   Remove from Registry Run           trilc uninstall-regrun

Options:
  --port <n>          Port for HTTP server (default: ${DEFAULT_PORT})
  --name <s>          Windows Service name (default: ${DEFAULT_SERVICE_NAME})
  --displayName <s>   Windows Service display name
  --agent <id>        Agent contract ID for chat (e.g. ceo-chief-of-staff)
  --resume <id>       Resume a previous session by ID
  --list-sessions     List all saved sessions`);
}

// ── Argument parsing ──
function parseArgs(args: string[]): { command: string; port: number; serviceName: string; displayName: string; agent?: string; resume?: string; listSessions?: boolean } {
  const command = args[0] ?? 'help';
  let port = DEFAULT_PORT;
  let serviceName = DEFAULT_SERVICE_NAME;
  let displayName = 'TriMetaverse Local Controller';
  let agent: string | undefined;
  let resume: string | undefined;
  let listSessions = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--name' && args[i + 1]) {
      serviceName = args[i + 1];
      i++;
    } else if (args[i] === '--displayName' && args[i + 1]) {
      displayName = args[i + 1];
      i++;
    } else if (args[i] === '--agent' && args[i + 1]) {
      agent = args[i + 1];
      i++;
    } else if (args[i] === '--resume' && args[i + 1]) {
      resume = args[i + 1];
      i++;
    } else if (args[i] === '--list-sessions') {
      listSessions = true;
    }
  }

  return { command, port, serviceName, displayName, agent, resume, listSessions };
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

  // Port-in-use guard: if daemon was started by another path (nssm service, tricade),
  // the PID file won't match but the port is already occupied.
  if (await isPortInUse(port)) {
    console.log(`[trilc] daemon already running on port ${port}.`);
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

async function cmdStop(port: number = DEFAULT_PORT): Promise<void> {
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

  // Try graceful HTTP shutdown first (Windows-compatible)
  const shutdownOk = await gracefulShutdown(port);
  if (shutdownOk) {
    console.log(`[trilc] daemon stopped gracefully (pid=${pid})`);
    await removePidFile();
    return;
  }

  // Fallback: SIGTERM (Linux) / TerminateProcess (Windows)
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`[trilc] daemon stopped via signal (pid=${pid})`);
  } catch (err) {
    console.error(`[trilc] failed to stop daemon (pid=${pid}):`, (err as Error).message);
  }

  await removePidFile();
}

async function gracefulShutdown(port: number): Promise<boolean> {
  try {
    const url = `http://127.0.0.1:${port}/shutdown`;
    await new Promise<void>((resolve, reject) => {
      import('node:http').then((http) => {
        const req = http.request(url, { method: 'POST', timeout: 3000 }, (res) => {
          res.resume();
          res.on('end', resolve);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });
    });
    return true;
  } catch {
    return false;
  }
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
  // Port-in-use guard: if another daemon (nssm service / tricade / previous cmdStart)
  // is already listening, exit cleanly instead of conflicting.
  if (await isPortInUse(port)) {
    console.log(`[trilc] port ${port} already in use — daemon is already running.`);
    return;
  }

  // Foreground mode: set env port and run main
  process.env.TRILC_PORT = String(port);

  // index.ts runs main() at top level when imported
  await import('./index.js');
}

// ── TUI Chat command ──

async function cmdChat(port: number, agent?: string, resume?: string): Promise<void> {
  // Step 1: healthz check
  const health = await healthCheck(port);

  if (!health.ok) {
    console.log('[trilc] daemon not running, auto-starting...');
    // Kill any stale daemon occupying the port but not responding
    const existingPid = await readPid();
    if (existingPid && isProcessAlive(existingPid)) {
      console.log(`[trilc] stale daemon detected (pid=${existingPid}), killing...`);
      try { process.kill(existingPid, 'SIGTERM'); } catch {}
      await new Promise((r) => setTimeout(r, 1000));
      await removePidFile();
    }
  }

  // Step 2: ensure daemon is running
  await cmdStart(port);

  // Step 3: wait for daemon to be ready (poll up to 30s)
  const startTime = Date.now();
  const maxWaitMs = 30000;
  const pollIntervalMs = 5000;

  while (Date.now() - startTime < maxWaitMs) {
    const check = await healthCheck(port);
    if (check.ok) {
      console.log('[trilc] daemon ready, starting TUI...');
      break;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  // Step 4: final healthz check
  const finalCheck = await healthCheck(port);
  if (!finalCheck.ok) {
    console.error(`[trilc] daemon failed to start within ${maxWaitMs / 1000}s`);
    process.exit(1);
  }

  // Step 5: if resume, fetch session from daemon
  let resumeOpts: { sessionId?: string; messages?: Array<{ role: 'user' | 'assistant'; content: string }> } | undefined;
  if (resume) {
    try {
      const fetchUrl = `http://127.0.0.1:${port}/internal/v1/sessions/${resume}`;
      const res = await fetch(fetchUrl);
      const json = await res.json() as { ok: boolean; session?: { id: string }; messages?: Array<{ role: string; content: string | null }> };
      if (json.ok && json.messages) {
        const msgs = json.messages
          .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
          .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content! }));
        resumeOpts = { sessionId: resume, messages: msgs };
        console.log(`[trilc] resumed session ${resume} with ${msgs.length} messages`);
      } else {
        console.error(`[trilc] session ${resume} not found or has no messages`);
        process.exit(1);
      }
    } catch (err) {
      console.error(`[trilc] failed to fetch session ${resume}:`, (err as Error).message);
      process.exit(1);
    }
  }

  // Step 6: start TUI
  if (agent) console.log(`[trilc] agent: ${agent}`);
  try {
    const { startTUI } = await import('./tui/render.js');
    const root = await startTUI(resumeOpts);
    await root.waitUntilExit();
    console.log('[trilc] TUI closed.');
  } catch (err) {
    console.error('[trilc] TUI error:', (err as Error).message);
  }
  process.exit(0);
}

// ── Windows Service commands (admin required) ──

/** Check if a TCP port is already in use (another daemon / nssm service). */
async function isPortInUse(port: number): Promise<boolean> {
  try {
    const { createServer } = await import('node:net');
    return await new Promise<boolean>((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(true));   // EADDRINUSE
      s.once('listening', () => { s.close(); resolve(false); });
      s.listen(port, '127.0.0.1');
    });
  } catch {
    return true; // assume occupied on error
  }
}

async function checkAdminPrivilege(): Promise<boolean> {
  if (platform() !== 'win32') return false;
  try {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    // net session requires admin; will fail with access denied for non-admin
    await execAsync('net session');
    return true;
  } catch {
    return false;
  }
}

async function checkServiceExists(name: string): Promise<boolean> {
  try {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    await execAsync(`sc query ${name}`);
    return true;
  } catch {
    return false;
  }
}

async function checkRegRunExists(): Promise<boolean> {
  if (platform() !== 'win32') return false;
  try {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    await execAsync(`reg query "${REGRUN_KEY}" /v ${REGRUN_VALUE}`);
    return true;
  } catch {
    return false;
  }
}

// ── install-service / uninstall-service ──
// DEPRECATED after architecture review (2026-07-27):
//   nssm SYSTEM service cannot access user API keys and introduced port-conflict
//   complexity.  Delegate to install-regrun / uninstall-regrun instead.
//   RegRun auto-starts TriLC at user login — no admin, users own keys, zero external
//   dependencies.  The old CLI names are kept so existing MSI CustomActions and
//   install scripts do not break — they transparently map to RegRun now.

async function cmdInstallService(_name: string, _displayName: string): Promise<void> {
  console.log('[trilc] install-service → install-regrun (nssm/SYSTEM service deprecated).');
  await cmdInstallRegRun();
}

async function cmdUninstallService(_name: string): Promise<void> {
  console.log('[trilc] uninstall-service → uninstall-regrun.');
  await cmdUninstallRegRun();
}

// ── Registry Run commands (no admin required) ──

async function cmdInstallRegRun(): Promise<void> {
  if (platform() !== 'win32') {
    console.error('ERROR: Registry Run registration is only available on Windows.');
    process.exit(1);
  }

  // Check mutual exclusion: if Service already registered
  if (await checkServiceExists(DEFAULT_SERVICE_NAME)) {
    console.error('ERROR: TriLC already registered as Windows Service.');
    console.error('Run trilc uninstall-service first, then retry install-regrun.');
    process.exit(1);
  }

  if (await checkRegRunExists()) {
    console.log('[trilc] TriLC already registered in Registry Run.');
    return;
  }

  const nodePath = process.execPath;
  const cliPath = resolve(__dirname, 'cli.js');

  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  try {
    const cmd = `reg add "${REGRUN_KEY}" /v ${REGRUN_VALUE} /t REG_SZ /d "\\"${nodePath}\\" \\"${cliPath}\\" start" /f`;
    await execAsync(cmd);
    console.log('[OK] TriLC registered in Registry Run (auto-start on login).');
  } catch (err) {
    console.error(`ERROR: Registry Run registration failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function cmdUninstallRegRun(): Promise<void> {
  if (platform() !== 'win32') return;

  const exists = await checkRegRunExists();
  if (!exists) {
    console.log('[trilc] TriLC not found in Registry Run.');
    return;
  }

  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  try {
    await execAsync(`reg delete "${REGRUN_KEY}" /v ${REGRUN_VALUE} /f`);
    console.log('[OK] TriLC 已从 Registry Run 移除。');
  } catch (err) {
    console.error(`ERROR: Registry Run 移除失败: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ── List Sessions ──

async function cmdListSessions(port: number): Promise<void> {
  const health = await healthCheck(port);
  if (!health.ok) {
    console.log('[trilc] daemon not running. Start with: trilc start');
    return;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/internal/v1/sessions?limit=50`);
    const json = await res.json() as { ok: boolean; sessions?: Array<{ id: string; title?: string; status: string; createdAt: string }> };
    if (json.ok && json.sessions) {
      if (json.sessions.length === 0) {
        console.log('No saved sessions.');
      } else {
        console.log(`\n${'SESSION ID'.padEnd(28)} STATUS     CREATED`);
        console.log('-'.repeat(60));
        for (const s of json.sessions) {
          console.log(`${s.id.padEnd(28)} ${s.status.padEnd(10)} ${s.createdAt}`);
        }
        console.log(`\nResume a session: trilc chat --resume <id>`);
      }
    } else {
      console.log('No sessions available.');
    }
  } catch (err) {
    console.error('[trilc] failed to list sessions:', (err as Error).message);
  }
}

// ── Entry ──
const { command, port, serviceName, displayName, agent, resume, listSessions } = parseArgs(process.argv.slice(2));

(async () => {
  switch (command) {
    case 'start':
      await cmdStart(port);
      break;
    case 'stop':
      await cmdStop(port);
      break;
    case 'status':
      await cmdStatus(port);
      break;
    case 'run':
      await cmdRun(port);
      break;
    case 'chat':
      await cmdChat(port, agent, resume);
      break;
    case 'list-sessions':
      await cmdListSessions(port);
      break;
    case 'install-service':
      await cmdInstallService(serviceName, displayName);
      break;
    case 'uninstall-service':
      await cmdUninstallService(serviceName);
      break;
    case 'install-regrun':
      await cmdInstallRegRun();
      break;
    case 'uninstall-regrun':
      await cmdUninstallRegRun();
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
