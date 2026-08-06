// ── REQ-018 integration tests ──
// 1) A foreground-style daemon self-registers its PID after listen and
//    cleans it up on graceful shutdown.
// 2) `trilc stop` locates a healthy daemon by port when the PID file is
//    missing (pre-REQ-018 foreground run / foreign start path).
//
// Uses a lightweight fixture (test/fixtures/pid-daemon.ts) that shares the
// real registerPid/unregisterPid primitives with src/index.ts, and runs the
// real CLI (src/cli.ts) for the stop flow.
import { describe, it, after } from 'node:test';
import * as assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';

const tmpDir = mkdtempSync(join(tmpdir(), 'trilc-pidflow-'));
process.env.TRILC_PID_DIR = tmpDir;

// paths.ts evaluates TRILC_PID_DIR at import time — dynamic import after env setup.
const pidfile = await import('../../src/pidfile.js');

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = join(REPO_ROOT, 'test', 'fixtures', 'pid-daemon.ts');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── helpers ──

function spawnTsx(args: string[], env: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', ...args], {
    env: { ...process.env, TRILC_PID_DIR: tmpDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function collectOutput(child: ChildProcess): { get: () => string; waitFor: (re: RegExp, timeoutMs: number) => Promise<boolean> } {
  let out = '';
  child.stdout?.on('data', (d) => { out += d.toString(); });
  child.stderr?.on('data', (d) => { out += d.toString(); });
  return {
    get: () => out,
    waitFor: async (re, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (re.test(out)) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return re.test(out);
    },
  };
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(null), timeoutMs);
    child.once('exit', (code) => { clearTimeout(timer); resolveExit(code); });
  });
}

function postShutdown(port: number): Promise<boolean> {
  return new Promise((resolvePost) => {
    const req = request(
      { hostname: '127.0.0.1', port, path: '/shutdown', method: 'POST', timeout: 3000 },
      (res) => { res.resume(); res.on('end', () => resolvePost(true)); },
    );
    req.on('error', () => resolvePost(false));
    req.on('timeout', () => { req.destroy(); resolvePost(false); });
    req.end();
  });
}

// ── tests ──

describe('REQ-018 daemon PID self-registration', () => {
  it('foreground-style daemon registers PID on listen and unregisters on graceful shutdown', async () => {
    const port = 18731;
    const child = spawnTsx([FIXTURE], { TEST_PORT: String(port) });
    // Register the exit listener immediately after spawn — on Windows the
    // 'exit' event can fire while later awaits are pending, and a listener
    // attached afterwards would permanently miss it.
    const childExit = waitExit(child, 8000);
    const output = collectOutput(child);

    const registered = await output.waitFor(/PID-REGISTERED/, 10000);
    assert.equal(registered, true, `fixture did not register: ${output.get()}`);

    // PID file names the daemon process
    assert.equal(await pidfile.readPid(), child.pid);
    assert.equal(existsSync(join(tmpDir, 'trilc.pid')), true);

    // Graceful shutdown → PID file cleaned up
    const shutdownOk = await postShutdown(port);
    assert.equal(shutdownOk, true);

    const code = await childExit;
    assert.equal(code, 0, `fixture exit code: ${code} (out: ${output.get()})`);
    assert.equal(await pidfile.readPid(), null, 'PID file must be removed on daemon exit');
    assert.equal(existsSync(join(tmpDir, 'trilc.pid')), false);
  });

  it('trilc stop stops a healthy daemon by port when the PID file is missing', async () => {
    const port = 18732;
    const child = spawnTsx([FIXTURE], { TEST_PORT: String(port) });
    // Exit listener registered immediately after spawn (see note above).
    const childExit = waitExit(child, 8000);
    const output = collectOutput(child);

    const registered = await output.waitFor(/PID-REGISTERED/, 10000);
    assert.equal(registered, true, `fixture did not register: ${output.get()}`);

    // Simulate pre-REQ-018 state: daemon running but no PID record
    await pidfile.removePidFile();
    assert.equal(await pidfile.readPid(), null);

    // Real CLI: stop --port must locate the daemon via netstat/lsof
    const cli = spawnTsx([CLI, 'stop', '--port', String(port)]);
    const cliOut = collectOutput(cli);
    const cliCode = await waitExit(cli, 15000);
    assert.equal(cliCode, 0, `trilc stop exited ${cliCode} (out: ${cliOut.get()})`);
    assert.match(cliOut.get(), /stopped via port lookup/, `stop message: ${cliOut.get()}`);

    // Daemon must actually be gone
    const code = await childExit;
    assert.equal(code, 0, `daemon exit code: ${code} (out: ${output.get()})`);
    assert.equal(await pidfile.readPid(), null);
  });
});
