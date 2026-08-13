// ── C side: tasks/submit weekly-plane hint assembly assertions (r4-1 C) ──
// Gate: app.ts tasks/submit must append buildWeeklyPlaneHint() when the client
// supplies a systemPrompt (which skips defaultSystemPrompt entirely), and must
// NOT double-inject. No model calls needed — tasks/submit only persists the
// session entry; the agent loop runs later on the /stream endpoint.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTriLCApp } from '../../src/server/app.js';

const SAVED_ENV = {
  TRILC_DATA_DIR: process.env.TRILC_DATA_DIR,
  TRILC_WEEKLY_PLANE_ROOT: process.env.TRILC_WEEKLY_PLANE_ROOT,
  TRILC_PORT: process.env.TRILC_PORT,
  TRIMODEL_API_TOKEN: process.env.TRIMODEL_API_TOKEN,
};

const HINT_MARKER = 'Company Weekly Plane';

let tmpDataDir: string;
let planeRoot: string;
let app: ReturnType<typeof createTriLCApp>;
let appPort: number;

async function readSessionPrompt(sessionId: string): Promise<string> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(tmpDataDir, 'sessions.db'), { readOnly: true });
  try {
    const row = db.prepare('SELECT system_prompt FROM sessions WHERE id = ?').get(sessionId) as
      | { system_prompt: string }
      | undefined;
    return row?.system_prompt ?? '';
  } finally {
    db.close();
  }
}

before(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'trilc-hint-'));
  planeRoot = mkdtempSync(join(tmpdir(), 'trilc-plane-'));
  // resolveWeeklyPlaneRoot requires the env root to exist.
  mkdirSync(planeRoot, { recursive: true });

  process.env.TRILC_DATA_DIR = tmpDataDir;
  process.env.TRILC_WEEKLY_PLANE_ROOT = planeRoot;
  process.env.TRILC_PORT = '0';
  delete process.env.TRIMODEL_API_TOKEN;

  const { readEnv } = await import('../../src/config/env.js');
  const env = readEnv();
  env.port = 0;
  env.trimodelApiUrl = 'http://127.0.0.1:1'; // keys degrade fast, no real calls

  app = createTriLCApp(env);
  await app.start();
  appPort = env.port;
  if (!appPort) throw new Error('app did not bind a port');
});

after(async () => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else (process.env as Record<string, string | undefined>)[k] = v;
  }
  try { await app.stop(); } catch { /* swallow */ }
  // app.stop() may leave SQLite handles (cron.db) briefly locked on Windows —
  // retry a few times, then leave the temp dir to the OS tmp cleaner.
  for (const target of [tmpDataDir, planeRoot]) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(target, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
});

async function postJSON(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${appPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { status: res.status, json };
}

describe('C: tasks/submit weekly-plane hint assembly', () => {
  it('client systemPrompt path gets hint appended exactly once', async () => {
    const { status, json } = await postJSON('/internal/v1/tasks/submit', {
      message: 'hello',
      systemPrompt: 'CLIENT-PROMPT-123',
      context: { workspaceRoot: planeRoot },
    });
    assert.equal(status, 201);
    const prompt = await readSessionPrompt(json.sessionId);
    assert.ok(prompt.includes('CLIENT-PROMPT-123'), 'client prompt must be preserved');
    assert.ok(prompt.includes(HINT_MARKER), `hint missing in prompt: ${prompt.slice(-400)}`);
    assert.ok(prompt.includes(planeRoot), `hint must carry plane root: ${prompt.slice(-400)}`);
    const occurrences = prompt.split(HINT_MARKER).length - 1;
    assert.equal(occurrences, 1, `hint injected ${occurrences} times, expected exactly 1`);
  });

  it('no-prompt path keeps defaultSystemPrompt with its internal hint', async () => {
    const { status, json } = await postJSON('/internal/v1/tasks/submit', {
      message: 'hello again',
      context: { workspaceRoot: planeRoot },
    });
    assert.equal(status, 201);
    const prompt = await readSessionPrompt(json.sessionId);
    assert.ok(prompt.includes(HINT_MARKER), 'defaultSystemPrompt must still embed the hint');
    assert.ok(!prompt.includes('CLIENT-PROMPT-123'), 'no-prompt path must not carry the client prompt');
    const occurrences = prompt.split(HINT_MARKER).length - 1;
    assert.equal(occurrences, 1, `hint injected ${occurrences} times, expected exactly 1 (no double injection)`);
  });
});
