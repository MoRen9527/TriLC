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
import type { TriLCDaemonServiceConfig } from './daemon/service.js';

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
  restart            Restart daemon (stop → start)    trilc restart [--port 8711]
  status             Show daemon status               trilc status [--port 8711]
  run                Run daemon in foreground         trilc run [--port 8711]
  chat               Start TUI chat (auto-starts daemon) trilc chat [--port 8711] [--agent &lt;id&gt;] [--resume &lt;id&gt;] [--list-sessions]
  list-sessions      List all saved sessions            trilc list-sessions [--port 8711]
  install-service    Register as Windows Service       trilc install-service [--name TriLC] [--displayName "..."]
  uninstall-service  Unregister Windows Service        trilc uninstall-service [--name TriLC]
  install-regrun     Register to Registry Run (no-admin) trilc install-regrun
  uninstall-regrun   Remove from Registry Run           trilc uninstall-regrun
  daemon             OS-level daemon management         trilc daemon <install|uninstall|stage|status>
  cron               Cron job management                trilc cron <add|list|update|remove|run|log|status>
  watchdog           Start watchdog supervisor process   trilc watchdog [--port 8711] [--data-dir <path>]

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

async function cmdRestart(port: number): Promise<void> {
  console.log('[trilc] restarting daemon...');
  await cmdStop(port);
  // brief pause to allow port release
  await new Promise((r) => setTimeout(r, 1000));
  await cmdStart(port);
  console.log('[trilc] daemon restarted');
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
  let resumeOpts: { sessionId?: string; messages?: Array<{ role: 'user' | 'assistant'; content: string }>; systemPrompt?: string } | undefined;
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

  // REQ-20260805-005 (part 1): auto-resume pending onboarding session.
  // If TriCompany is uninitialized and user opens chat without --resume,
  // resume the latest company-onboarding heartbeat session so the CEO
  // sees the agent's guidance immediately (no manual resume needed).
  if (!resume && !resumeOpts) {
    try {
      const listUrl = `http://127.0.0.1:${port}/internal/v1/sessions`;
      const res = await fetch(listUrl);
      const json = await res.json() as { ok: boolean; sessions?: Array<{ id: string; title?: string }> };
      if (json.ok && json.sessions) {
        const onboarding = json.sessions.find((s) => s.id.startsWith('hb_company-onboarding_'));
        if (onboarding) {
          const fetchUrl = `http://127.0.0.1:${port}/internal/v1/sessions/${onboarding.id}`;
          const res2 = await fetch(fetchUrl);
          const json2 = await res2.json() as { ok: boolean; session?: { id: string; model: string; systemPrompt?: string }; messages?: Array<{ role: string; content: string | null }> };
          if (json2.ok && json2.messages) {
            const msgs = json2.messages
              .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
              .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content! }));
            // REQ-013: carry the session's systemPrompt (onboarding persona)
            // through the resume path.
            resumeOpts = { sessionId: onboarding.id, messages: msgs, systemPrompt: json2.session?.systemPrompt };
            console.log(`[trilc] onboarding pending — auto-resumed ${onboarding.id} (${msgs.length} messages)`);
          }
        }
      }
    } catch (err) {
      console.warn('[trilc] onboarding auto-resume failed:', (err as Error).message);
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

// ── Daemon subcommands ──

function resolveDaemonConfig(port: number): TriLCDaemonServiceConfig {
  const entryScript = resolve(__dirname, 'cli.js');
  return {
    nodeBin: process.execPath,
    entryScript,
    programArgs: ['start', '--port', String(port)],
    cwd: process.cwd(),
    dataDir: process.env.TRILC_DATA_DIR ?? `${process.env.LOCALAPPDATA ?? process.env.HOME ?? '/tmp'}/trilc`,
    port,
  };
}

// ── Cron subcommands ──

async function cronRequest(port: number, method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `http://127.0.0.1:${port}${path}`;
  const options: RequestInit = {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(url, options);
  const json = await res.json();
  if (!res.ok) {
    const err = json && typeof json === 'object' && 'error' in json ? String(json.error) : `HTTP ${res.status}`;
    throw new Error(err);
  }
  return json;
}

async function cmdCron(subcommand: string, args: string[], port: number): Promise<void> {
  switch (subcommand) {
    case 'add': {
      // Interactive or flagged add: name, schedule, prompt
      let name = '';
      let scheduleExpr = '';
      let scheduleKind: 'every' | 'cron' = 'every';
      let scheduleEveryMs = 0;
      let scheduleCron = '';
      let systemPrompt = '';
      let enabled = true;

      // Parse flags
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--name' && args[i + 1]) { name = args[++i]; }
        else if (args[i] === '--every' && args[i + 1]) { scheduleKind = 'every'; scheduleEveryMs = parseInt(args[++i], 10); }
        else if (args[i] === '--cron' && args[i + 1]) { scheduleKind = 'cron'; scheduleCron = args[++i]; }
        else if (args[i] === '--prompt' && args[i + 1]) { systemPrompt = args[++i]; }
        else if (args[i] === '--disabled') { enabled = false; }
      }

      if (!name) {
        // Interactive prompt
        const { createInterface } = await import('node:readline');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));
        name = await ask('Job name: ');
        if (!name.trim()) { console.error('ERROR: name is required.'); rl.close(); process.exit(1); }
        const scheduleInput = await ask('Schedule (e.g. "5m", "1h", or cron expr): ');
        scheduleExpr = scheduleInput.trim();
        if (!scheduleExpr) { console.error('ERROR: schedule is required.'); rl.close(); process.exit(1); }
        const promptInput = await ask('System prompt (optional, press Enter to skip): ');
        systemPrompt = promptInput.trim();
        rl.close();
      }

      // Parse schedule expression if interactive
      if (scheduleExpr && !scheduleEveryMs && !scheduleCron) {
        const parsed = parseHumanSchedule(scheduleExpr);
        if (parsed) {
          scheduleKind = 'every';
          scheduleEveryMs = parsed.everyMs;
        } else {
          // Assume cron expression
          scheduleKind = 'cron';
          scheduleCron = scheduleExpr;
        }
      }

      const schedule = scheduleKind === 'every'
        ? { kind: 'every' as const, everyMs: scheduleEveryMs || 3600000 }
        : { kind: 'cron' as const, expr: scheduleCron || '0 9 * * *' };

      const body = { name: name || 'Unnamed job', schedule, systemPrompt: systemPrompt || '', enabled };
      const result = await cronRequest(port, 'POST', '/internal/v1/cron/jobs', body);
      const job = (result as Record<string, unknown>).job;
      console.log('[OK] job created:', JSON.stringify(job, null, 2));
      break;
    }

    case 'list': {
      const result = await cronRequest(port, 'GET', '/internal/v1/cron/jobs');
      const data = result as { ok: boolean; jobs: Array<Record<string, unknown>>; count: number };
      if (data.jobs.length === 0) {
        console.log('No cron jobs.');
      } else {
        console.log(`\n${'ID'.padEnd(24)} ${'NAME'.padEnd(20)} ${'SCHEDULE'.padEnd(24)} ${'STATE'.padEnd(10)} ${'LAST RUN'}`);
        console.log('-'.repeat(100));
        for (const j of data.jobs) {
          const scheduleStr = typeof j.schedule === 'object' && j.schedule
            ? ((j.schedule as Record<string, unknown>).kind === 'every'
              ? `every ${(j.schedule as Record<string, unknown>).everyMs}ms`
              : (j.schedule as Record<string, unknown>).expr)
            : '?';
          console.log(`${String(j.id).slice(0, 22).padEnd(24)} ${String(j.name).slice(0, 18).padEnd(20)} ${String(scheduleStr).slice(0, 22).padEnd(24)} ${String(j.state).padEnd(10)} ${String(j.lastRunAt ?? '-').slice(0, 19)}`);
        }
        console.log(`\n${data.count} job(s)`);
      }
      break;
    }

    case 'update': {
      const jobId = args[0];
      if (!jobId) { console.error('ERROR: job ID required. Usage: trilc cron update <id> [--enable|--disable] [--prompt ...] [--schedule ...]'); process.exit(1); }
      const patch: Record<string, unknown> = {};
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--enable') { patch.enabled = true; }
        else if (args[i] === '--disable') { patch.enabled = false; }
        else if (args[i] === '--name' && args[i + 1]) { patch.name = args[++i]; }
        else if (args[i] === '--prompt' && args[i + 1]) { patch.systemPrompt = args[++i]; }
        else if (args[i] === '--every' && args[i + 1]) { patch.schedule = { kind: 'every', everyMs: parseInt(args[++i], 10) }; }
        else if (args[i] === '--cron' && args[i + 1]) { patch.schedule = { kind: 'cron', expr: args[++i] }; }
      }
      if (Object.keys(patch).length === 0) { console.error('ERROR: no patch fields. Use --enable, --disable, --name, --prompt, --every, or --cron.'); process.exit(1); }
      const result = await cronRequest(port, 'PATCH', `/internal/v1/cron/jobs/${encodeURIComponent(jobId)}`, patch);
      console.log('[OK] job updated:', JSON.stringify((result as Record<string, unknown>).job, null, 2));
      break;
    }

    case 'remove': {
      const jobId = args[0];
      if (!jobId) { console.error('ERROR: job ID required. Usage: trilc cron remove <id>'); process.exit(1); }
      await cronRequest(port, 'DELETE', `/internal/v1/cron/jobs/${encodeURIComponent(jobId)}`);
      console.log(`[OK] job removed: ${jobId}`);
      break;
    }

    case 'run': {
      const jobId = args[0];
      if (!jobId) { console.error('ERROR: job ID required. Usage: trilc cron run <id> [--force]'); process.exit(1); }
      const force = args.includes('--force');
      const result = await cronRequest(port, 'POST', `/internal/v1/cron/jobs/${encodeURIComponent(jobId)}/run`, { force });
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'log': {
      const jobId = args.find((a, i) => a === '--job' && args[i + 1]) ? args[args.indexOf('--job') + 1] : undefined;
      const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1] || '20', 10) : 20;
      const queryString = jobId ? `?jobId=${encodeURIComponent(jobId)}&limit=${limit}` : `?limit=${limit}`;
      const result = await cronRequest(port, 'GET', `/internal/v1/cron/log${queryString}`);
      const data = result as { ok: boolean; logs: Array<Record<string, unknown>>; count: number };
      if (data.logs.length === 0) {
        console.log('No execution logs.');
      } else {
        console.log(`\n${'ID'.padEnd(6)} ${'JOB ID'.padEnd(24)} ${'STATUS'.padEnd(10)} ${'STARTED AT'.padEnd(22)} ${'DURATION'.padEnd(10)} ${'ERROR'}`);
        console.log('-'.repeat(100));
        for (const l of data.logs) {
          const duration = typeof l.durationMs === 'number' ? `${l.durationMs}ms` : '-';
          console.log(`${String(l.id).padEnd(6)} ${String(l.jobId).slice(0, 22).padEnd(24)} ${String(l.status).padEnd(10)} ${String(l.startedAt).slice(0, 20).padEnd(22)} ${duration.padEnd(10)} ${String(l.errorMessage ?? '-').slice(0, 30)}`);
        }
        console.log(`\n${data.count} log entry(s)`);
      }
      break;
    }

    case 'status': {
      const result = await cronRequest(port, 'GET', '/internal/v1/cron/status');
      const data = result as { ok: boolean; status: { running: boolean; degraded: boolean; consecutiveFailures: number; jobCount: number } };
      if (!data.ok) {
        console.error('[trilc] cron status: failed to retrieve status');
        process.exit(1);
      }
      const s = data.status;
      console.log(`Cron Engine Status:`);
      console.log(`  Running:              ${s.running ? 'yes' : 'no'}`);
      console.log(`  Degraded:             ${s.degraded ? 'YES (3+ consecutive failures)' : 'no'}`);
      console.log(`  Consecutive Failures: ${s.consecutiveFailures}`);
      console.log(`  Job Count:            ${s.jobCount}`);
      break;
    }

    default:
      console.error(`[trilc] cron: unknown subcommand: ${subcommand}`);
      console.error('Usage: trilc cron <add|list|update|remove|run|log|status>');
      process.exit(1);
  }
}

/** Parse human-readable schedule expressions like "5m", "1h", "30s" */
function parseHumanSchedule(input: string): { kind: 'every'; everyMs: number } | null {
  const match = input.match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return { kind: 'every', everyMs: value * (multipliers[unit] || 60000) };
}

async function cmdDaemon(subcommand: string, port: number): Promise<void> {
  const { resolveDaemonService } = await import('./daemon/service.js');
  const service = await resolveDaemonService();
  const config = resolveDaemonConfig(port);

  switch (subcommand) {
    case 'install': {
      console.log('[trilc] daemon: installing...');
      await service.install(config);
      console.log('[OK] daemon installed.');
      break;
    }
    case 'uninstall': {
      console.log('[trilc] daemon: uninstalling...');
      await service.uninstall(config);
      console.log('[OK] daemon uninstalled.');
      break;
    }
    case 'stage': {
      const path = await service.stage(config);
      console.log(`[OK] daemon staged: ${path}`);
      break;
    }
    case 'status': {
      const state = await service.status(config);
      console.log(JSON.stringify(state, null, 2));
      break;
    }
    default:
      console.error(`[trilc] daemon: unknown subcommand: ${subcommand}`);
      console.error('Usage: trilc daemon <install|uninstall|stage|status>');
      process.exit(1);
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
    case 'restart':
      await cmdRestart(port);
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
    case 'company': {
      // REQ-017: debug reset — wipe company state for re-onboarding
      const sub = process.argv[3];
      if (sub === 'reset') {
        const { CompanyInitState } = await import('./company/init-state.js');
        const dataDir = process.env.TRILC_DATA_DIR ?? `${process.env.LOCALAPPDATA ?? process.env.HOME ?? '/tmp'}/trilc`;
        const init = new CompanyInitState(dataDir);
        await init.reset();
        console.log('[trilc] company state reset — re-onboarding will start');
      } else {
        console.error('Usage: trilc company reset');
        process.exit(1);
      }
      break;
    }
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
    case 'daemon': {
      const subcommand = process.argv[3] ?? 'status';
      await cmdDaemon(subcommand, port);
      break;
    }
    case 'cron': {
      const subcommand = process.argv[3] ?? 'list';
      const subArgs = process.argv.slice(4);
      await cmdCron(subcommand, subArgs, port);
      break;
    }
    case 'watchdog': {
      const { resolveWatchdogConfig, createWatchdog } = await import('./daemon/watchdog.js');
      const dataDir = process.env.TRILC_DATA_DIR ?? `${process.env.LOCALAPPDATA ?? process.env.HOME ?? '/tmp'}/trilc`;
      const wdConfig = resolveWatchdogConfig(port, dataDir);
      const watchdog = createWatchdog(wdConfig);

      console.log(`[trilc] watchdog starting (port=${wdConfig.port}, dataDir=${wdConfig.dataDir})`);
      console.log(`[trilc] watchdog will restart the daemon up to 5 times per 10-minute window`);
      console.log(`[trilc] backoff: 1s→2s→4s→8s→16s→32s cap, reset after 60s stable uptime`);
      console.log(`[trilc] child entry: ${wdConfig.entryScript}`);

      // Handle parent process signals
      const cleanup = () => {
        watchdog.stop();
        process.exit(0);
      };
      process.on('SIGTERM', cleanup);
      process.on('SIGINT', cleanup);

      const started = watchdog.start();
      if (!started) {
        console.error('[trilc] watchdog failed to start child process');
        process.exit(1);
      }

      // Keep the watchdog process alive; it monitors the child via event handlers
      // The process stays alive because child process events keep the event loop active
      break;
    }
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
