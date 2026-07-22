// ── Session Store Unit Tests ──
// Covers: schema creation, migration v1→v2, session CRUD, sync state machine,
// message CRUD, recovery helpers, and row mapping correctness.
// Test scope: arch-trilc-daemon td-4 §10.1 session-store
//
// Run: npx tsx --test test/session-store.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { createSessionStore } from '../src/session-store/store.js';
import type { SessionRecord, SyncStatus } from '../src/session-store/types.js';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_DB = join(tmpdir(), `trilc-test-sessions-${Date.now()}.db`);

function cleanup() {
  try { unlinkSync(TEST_DB); } catch { /* ok */ }
  try { unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
  try { unlinkSync(TEST_DB + '-shm'); } catch { /* ok */ }
}

// ── Helpers ──

function makeSessionId(suffix = 'test'): string {
  return `sess_${Date.now().toString(36)}_${suffix}`;
}

// ═══════════════════════════════════════════════════════════════════
// Schema & Migration
// ═══════════════════════════════════════════════════════════════════

describe('SessionStore — Schema & Migration', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('initializes a new database with schema v2', () => {
    const store = createSessionStore(TEST_DB);

    // Verify base tables exist
    const tables = (store as any)._rawDb
      ? undefined // encapsulated; verify via functional tests
      : undefined;

    // Functional verification: create and retrieve session
    const sid = makeSessionId('schema-v2');
    const session = store.createSession({ id: sid, model: 'deepseek-v4-pro' });

    assert.ok(session, 'session created');
    assert.strictEqual(session.id, sid);
    // v2 fields should have defaults
    assert.strictEqual(session.syncStatus, 'local',
      'sync_status defaults to "local" per implementation');
    assert.strictEqual(session.lastSyncedAt, null);
    assert.strictEqual(session.cloudSessionId, null);

    store.close();
  });

  it('re-opens existing database without data loss', () => {
    const sid = makeSessionId('reopen');
    const store1 = createSessionStore(TEST_DB);
    store1.createSession({ id: sid, model: 'deepseek-v4-pro', title: 'Test Reopen' });
    store1.close();

    const store2 = createSessionStore(TEST_DB);
    const session = store2.getSession(sid);
    assert.ok(session, 'session survives re-open');
    assert.strictEqual(session!.title, 'Test Reopen');
    assert.strictEqual(session!.syncStatus, 'local');
    store2.close();
  });

  it('creates sessions and messages tables with expected columns', () => {
    const store = createSessionStore(TEST_DB);

    // We verify by creating a full session + messages then reading back
    const sid = makeSessionId('full');
    store.createSession({
      id: sid,
      model: 'deepseek-v4-pro',
      systemPrompt: 'You are helpful',
      cwd: '/test',
      title: 'Full Session',
    });

    store.saveMessages(sid, [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: 'Hi there!',
        toolCalls: [{ id: 'tc1', type: 'function' as const, function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', content: 'file content', toolCallId: 'tc1' },
    ]);

    const session = store.getSession(sid);
    assert.ok(session);
    assert.strictEqual(session!.model, 'deepseek-v4-pro');
    assert.strictEqual(session!.systemPrompt, 'You are helpful');
    assert.strictEqual(session!.cwd, '/test');
    assert.strictEqual(session!.title, 'Full Session');
    assert.strictEqual(session!.messageCount, 3);

    const msgs = store.getMessages(sid);
    assert.strictEqual(msgs.length, 3);
    assert.strictEqual(msgs[0].role, 'user');
    assert.strictEqual(msgs[0].seq, 1);
    assert.strictEqual(msgs[1].role, 'assistant');
    assert.ok(msgs[1].toolCalls, 'tool_calls JSON preserved');
    assert.strictEqual(msgs[2].role, 'tool');
    assert.strictEqual(msgs[2].toolCallId, 'tc1');

    store.close();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Session CRUD
// ═══════════════════════════════════════════════════════════════════

describe('SessionStore — Session CRUD', () => {
  let store: ReturnType<typeof createSessionStore>;

  beforeEach(() => {
    cleanup();
    store = createSessionStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    cleanup();
  });

  it('createSession returns full SessionRecord', () => {
    const sid = makeSessionId('crud-1');
    const session = store.createSession({
      id: sid,
      model: 'deepseek-v4-pro',
      systemPrompt: 'test prompt',
      cwd: '/home/test',
      title: 'My Session',
    });

    assert.strictEqual(session.id, sid);
    assert.strictEqual(session.status, 'active');
    assert.strictEqual(session.model, 'deepseek-v4-pro');
    assert.strictEqual(session.systemPrompt, 'test prompt');
    assert.strictEqual(session.cwd, '/home/test');
    assert.strictEqual(session.title, 'My Session');
    assert.strictEqual(session.messageCount, 0);
    assert.ok(session.createdAt, 'createdAt set');
    assert.ok(session.updatedAt, 'updatedAt set');
    assert.strictEqual(session.closedAt, null);
    assert.strictEqual(session.syncStatus, 'local');
  });

  it('getSession returns null for non-existent id', () => {
    const result = store.getSession('non-existent-id');
    assert.strictEqual(result, null);
  });

  it('getSession returns exact match by id', () => {
    const sid = makeSessionId('get');
    store.createSession({ id: sid, model: 'gpt-5' });
    // Create a second session to verify no cross-contamination
    store.createSession({ id: makeSessionId('other'), model: 'claude-4' });

    const session = store.getSession(sid);
    assert.ok(session);
    assert.strictEqual(session!.id, sid);
    assert.strictEqual(session!.model, 'gpt-5');
  });

  it('listSessions returns all sessions ordered by updated_at DESC', () => {
    store.createSession({ id: makeSessionId('a'), model: 'm1' });
    // Small delay to ensure different timestamps
    const sidB = makeSessionId('b');
    store.createSession({ id: sidB, model: 'm2' });
    // Update session B to bump its updated_at
    store.saveMessages(sidB, [{ role: 'user', content: 'msg' }]);

    const all = store.listSessions();
    assert.ok(all.length >= 2);
    // Most recently updated should be first
    assert.strictEqual(all[0].id, sidB);
  });

  it('listSessions filters by status', () => {
    const sidActive = makeSessionId('active');
    store.createSession({ id: sidActive, model: 'm1' });
    const sidCompleted = makeSessionId('completed');
    store.createSession({ id: sidCompleted, model: 'm2' });
    store.updateSessionStatus(sidCompleted, 'completed');

    const active = store.listSessions({ status: 'active' });
    assert.ok(active.every((s) => s.status === 'active'));
    assert.ok(active.some((s) => s.id === sidActive));

    const completed = store.listSessions({ status: 'completed' });
    assert.ok(completed.every((s) => s.status === 'completed'));
    assert.ok(completed.some((s) => s.id === sidCompleted));
  });

  it('listSessions respects limit and offset', () => {
    for (let i = 0; i < 5; i++) {
      store.createSession({ id: makeSessionId(`list-${i}`), model: 'm' });
    }

    const page1 = store.listSessions({ limit: 3, offset: 0 });
    assert.strictEqual(page1.length, 3);

    const page2 = store.listSessions({ limit: 3, offset: 3 });
    assert.strictEqual(page2.length, 2);
    // No overlap
    const ids1 = new Set(page1.map((s) => s.id));
    const ids2 = new Set(page2.map((s) => s.id));
    for (const id of ids1) assert.ok(!ids2.has(id), `id ${id} should not appear in both pages`);
  });

  it('updateSessionStatus sets closedAt for terminal statuses', () => {
    const sid = makeSessionId('terminal');
    store.createSession({ id: sid, model: 'm' });
    store.saveMessages(sid, [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);

    store.updateSessionStatus(sid, 'completed');
    const session = store.getSession(sid);
    assert.strictEqual(session!.status, 'completed');
    assert.ok(session!.closedAt, 'closedAt set for completed');
    assert.strictEqual(session!.messageCount, 2);
  });

  it('updateSessionStatus sets closedAt for interrupted status', () => {
    const sid = makeSessionId('interrupted');
    store.createSession({ id: sid, model: 'm' });
    store.updateSessionStatus(sid, 'interrupted');
    const session = store.getSession(sid);
    assert.strictEqual(session!.status, 'interrupted');
    assert.ok(session!.closedAt, 'closedAt set for interrupted');
  });

  it('updateSessionStatus does NOT set closedAt for active status', () => {
    const sid = makeSessionId('still-active');
    store.createSession({ id: sid, model: 'm' });
    store.updateSessionStatus(sid, 'active');
    const session = store.getSession(sid);
    assert.strictEqual(session!.status, 'active');
    assert.strictEqual(session!.closedAt, null);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Sync Status State Machine (§10.1)
// ═══════════════════════════════════════════════════════════════════

describe('SessionStore — Sync Status State Machine', () => {
  let store: ReturnType<typeof createSessionStore>;

  beforeEach(() => {
    cleanup();
    store = createSessionStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    cleanup();
  });

  // 10.1: sync_status field default value
  it('new sessions default sync_status to "local"', () => {
    const sid = makeSessionId('sync-default');
    const session = store.createSession({ id: sid, model: 'm' });
    assert.strictEqual(session.syncStatus, 'local',
      'default sync_status must be "local" (implementation uses "local" not "never")');
  });

  // 10.1: state transition local → pending → syncing → synced
  it('transitions local → synced via updateSyncStatus (happy path)', () => {
    const sid = makeSessionId('sync-happy');
    store.createSession({ id: sid, model: 'm' });

    // local → syncing
    store.updateSyncStatus(sid, 'syncing');
    assert.strictEqual(store.getSession(sid)!.syncStatus, 'syncing');

    // syncing → synced (with cloudSessionId)
    store.updateSyncStatus(sid, 'synced', 'cloud-sess-abc');
    const session = store.getSession(sid)!;
    assert.strictEqual(session.syncStatus, 'synced');
    assert.strictEqual(session.cloudSessionId, 'cloud-sess-abc');
    assert.ok(session.lastSyncedAt, 'lastSyncedAt set when synced');
  });

  // 10.1: error recovery
  it('transitions to error and recovers to synced', () => {
    const sid = makeSessionId('sync-error');
    store.createSession({ id: sid, model: 'm' });

    // local → error (simulated sync failure)
    store.updateSyncStatus(sid, 'error');
    assert.strictEqual(store.getSession(sid)!.syncStatus, 'error');
    assert.strictEqual(store.getSession(sid)!.lastSyncedAt, null,
      'lastSyncedAt NOT set on error');

    // error → syncing (retry)
    store.updateSyncStatus(sid, 'syncing');
    assert.strictEqual(store.getSession(sid)!.syncStatus, 'syncing');

    // syncing → synced (recovery success)
    store.updateSyncStatus(sid, 'synced', 'cloud-sess-xyz');
    assert.strictEqual(store.getSession(sid)!.syncStatus, 'synced');
    assert.ok(store.getSession(sid)!.lastSyncedAt);
  });

  // 10.1: lastSyncedAt only set on 'synced'
  it('lastSyncedAt is only set when syncStatus is "synced"', () => {
    const sid = makeSessionId('sync-last');
    store.createSession({ id: sid, model: 'm' });

    // All non-synced states should leave lastSyncedAt null
    const nonSyncedStates: SyncStatus[] = ['local', 'pending', 'syncing', 'error'];
    for (const status of nonSyncedStates) {
      store.updateSyncStatus(sid, status);
      assert.strictEqual(store.getSession(sid)!.lastSyncedAt, null,
        `lastSyncedAt must be null for status "${status}"`);
    }

    // synced sets it
    store.updateSyncStatus(sid, 'synced');
    assert.ok(store.getSession(sid)!.lastSyncedAt, 'lastSyncedAt set for "synced"');
  });

  // markPendingSync behavior
  it('markPendingSync transitions from "local" to "pending"', () => {
    const sid = makeSessionId('mps-local');
    store.createSession({ id: sid, model: 'm' }); // default 'local'
    store.markPendingSync(sid);
    assert.strictEqual(store.getSession(sid)!.syncStatus, 'pending');
  });

  it('markPendingSync transitions from "synced" to "pending"', () => {
    const sid = makeSessionId('mps-synced');
    store.createSession({ id: sid, model: 'm' });
    store.updateSyncStatus(sid, 'synced', 'cloud-1');
    store.markPendingSync(sid);
    assert.strictEqual(store.getSession(sid)!.syncStatus, 'pending');
  });

  it('markPendingSync does NOT transition from "syncing" to "pending"', () => {
    const sid = makeSessionId('mps-syncing');
    store.createSession({ id: sid, model: 'm' });
    store.updateSyncStatus(sid, 'syncing');
    store.markPendingSync(sid);
    // Should remain 'syncing' because WHERE clause excludes it
    assert.strictEqual(store.getSession(sid)!.syncStatus, 'syncing');
  });

  it('markPendingSync does NOT transition from "error" to "pending"', () => {
    const sid = makeSessionId('mps-error');
    store.createSession({ id: sid, model: 'm' });
    store.updateSyncStatus(sid, 'error');
    store.markPendingSync(sid);
    // Should remain 'error' because WHERE clause excludes it
    assert.strictEqual(store.getSession(sid)!.syncStatus, 'error');
  });

  // getPendingSyncSessions
  it('getPendingSyncSessions returns only pending sessions', () => {
    // Create sessions in various sync states
    const sidPending1 = makeSessionId('gps-p1');
    const sidPending2 = makeSessionId('gps-p2');
    const sidLocal = makeSessionId('gps-local');
    const sidSynced = makeSessionId('gps-synced');

    store.createSession({ id: sidLocal, model: 'm' }); // default 'local'
    store.createSession({ id: sidSynced, model: 'm' });
    store.updateSyncStatus(sidSynced, 'synced', 'cloud-1');

    store.createSession({ id: sidPending1, model: 'm' });
    store.updateSyncStatus(sidPending1, 'pending');
    store.createSession({ id: sidPending2, model: 'm' });
    store.updateSyncStatus(sidPending2, 'pending');

    const pending = store.getPendingSyncSessions();
    assert.strictEqual(pending.length, 2, 'exactly 2 pending sessions');
    const pendingIds = pending.map((s) => s.id);
    assert.ok(pendingIds.includes(sidPending1));
    assert.ok(pendingIds.includes(sidPending2));
    assert.ok(!pendingIds.includes(sidLocal));
    assert.ok(!pendingIds.includes(sidSynced));
  });

  it('getPendingSyncSessions respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      const sid = makeSessionId(`gps-limit-${i}`);
      store.createSession({ id: sid, model: 'm' });
      store.updateSyncStatus(sid, 'pending');
    }

    const limited = store.getPendingSyncSessions(3);
    assert.strictEqual(limited.length, 3);
  });

  // getSessionByCloudId
  it('getSessionByCloudId finds session by cloud_session_id', () => {
    const sid = makeSessionId('cloud-lookup');
    store.createSession({ id: sid, model: 'm' });
    store.updateSyncStatus(sid, 'synced', 'cloud-sess-unique');

    const found = store.getSessionByCloudId('cloud-sess-unique');
    assert.ok(found);
    assert.strictEqual(found!.id, sid);

    const notFound = store.getSessionByCloudId('non-existent-cloud-id');
    assert.strictEqual(notFound, null);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Message CRUD
// ═══════════════════════════════════════════════════════════════════

describe('SessionStore — Message CRUD', () => {
  let store: ReturnType<typeof createSessionStore>;

  beforeEach(() => {
    cleanup();
    store = createSessionStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    cleanup();
  });

  it('saveMessages appends messages with sequential seq numbers', () => {
    const sid = makeSessionId('msg-seq');
    store.createSession({ id: sid, model: 'm' });

    store.saveMessages(sid, [
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'reply1' },
    ]);
    store.saveMessages(sid, [
      { role: 'user', content: 'msg2' },
      { role: 'assistant', content: 'reply2' },
    ]);

    const msgs = store.getMessages(sid);
    assert.strictEqual(msgs.length, 4);
    assert.strictEqual(msgs[0].seq, 1);
    assert.strictEqual(msgs[1].seq, 2);
    assert.strictEqual(msgs[2].seq, 3);
    assert.strictEqual(msgs[3].seq, 4);
    assert.strictEqual(msgs[3].content, 'reply2');
  });

  it('saveMessages preserves tool_calls as JSON string', () => {
    const sid = makeSessionId('msg-tools');
    store.createSession({ id: sid, model: 'm' });

    const toolCalls = [
      { id: 'tc-1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"/test"}' } },
      { id: 'tc-2', type: 'function' as const, function: { name: 'write_file', arguments: '{"path":"/out"}' } },
    ];
    store.saveMessages(sid, [
      { role: 'assistant', content: null, toolCalls },
    ]);

    const msgs = store.getMessages(sid);
    assert.strictEqual(msgs.length, 1);
    const parsed = JSON.parse(msgs[0].toolCalls!);
    assert.strictEqual(parsed.length, 2);
    assert.strictEqual(parsed[0].id, 'tc-1');
    assert.strictEqual(parsed[1].id, 'tc-2');
    assert.strictEqual(parsed[1].function.name, 'write_file');
  });

  it('saveMessages preserves reasoning_content', () => {
    const sid = makeSessionId('msg-reason');
    store.createSession({ id: sid, model: 'deepseek-r1' });

    store.saveMessages(sid, [
      { role: 'assistant', content: 'answer', reasoningContent: 'step-by-step reasoning...' },
    ]);

    const msgs = store.getMessages(sid);
    assert.strictEqual(msgs[0].reasoningContent, 'step-by-step reasoning...');
  });

  it('getMessageCount returns accurate count', () => {
    const sid = makeSessionId('msg-count');
    store.createSession({ id: sid, model: 'm' });

    assert.strictEqual(store.getMessageCount(sid), 0);
    store.saveMessages(sid, [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
    assert.strictEqual(store.getMessageCount(sid), 2);
    store.saveMessages(sid, [
      { role: 'user', content: 'c' },
    ]);
    assert.strictEqual(store.getMessageCount(sid), 3);
  });

  it('saveMessages detects empty assistant messages and marks interrupted', () => {
    const sid = makeSessionId('msg-empty');
    store.createSession({ id: sid, model: 'm' });

    store.saveMessages(sid, [
      { role: 'user', content: 'do something' },
      { role: 'assistant', content: null, toolCalls: null }, // empty assistant = interrupted
    ]);

    const session = store.getSession(sid);
    assert.strictEqual(session!.status, 'interrupted',
      'empty assistant message triggers interrupted status');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Recovery Helpers
// ═══════════════════════════════════════════════════════════════════

describe('SessionStore — Recovery Helpers', () => {
  let store: ReturnType<typeof createSessionStore>;

  beforeEach(() => {
    cleanup();
    store = createSessionStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    cleanup();
  });

  it('findInterruptedSessions returns active and interrupted sessions', () => {
    const sidActive = makeSessionId('find-active');
    store.createSession({ id: sidActive, model: 'm' }); // default 'active'

    const sidInterrupted = makeSessionId('find-int');
    store.createSession({ id: sidInterrupted, model: 'm' });
    store.updateSessionStatus(sidInterrupted, 'interrupted');

    const sidCompleted = makeSessionId('find-comp');
    store.createSession({ id: sidCompleted, model: 'm' });
    store.updateSessionStatus(sidCompleted, 'completed');

    const interrupted = store.findInterruptedSessions();
    const ids = interrupted.map((s) => s.id);
    assert.ok(ids.includes(sidActive), 'active sessions included');
    assert.ok(ids.includes(sidInterrupted), 'interrupted sessions included');
    assert.ok(!ids.includes(sidCompleted), 'completed sessions excluded');
  });

  it('getSessionSummary returns full summary for existing session', () => {
    const sid = makeSessionId('summary');
    store.createSession({ id: sid, model: 'gpt-5', title: 'Summary Test' });
    store.saveMessages(sid, [
      { role: 'user', content: 'First question' },
      {
        role: 'assistant',
        content: 'Answer',
        toolCalls: [{ id: 'tc1', type: 'function' as const, function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'user', content: 'Follow up' },
    ]);

    const summary = store.getSessionSummary(sid);
    assert.ok(summary);
    assert.strictEqual(summary!.session.id, sid);
    assert.strictEqual(summary!.messageCount, 3);
    assert.strictEqual(summary!.lastUserMessage, 'Follow up');
    assert.strictEqual(summary!.hasToolCalls, true);
    assert.strictEqual(summary!.hasEmptyAssistant, false);
  });

  it('getSessionSummary returns null for non-existent session', () => {
    const summary = store.getSessionSummary('non-existent');
    assert.strictEqual(summary, null);
  });

  it('expireOldSessions marks old sessions as expired', async () => {
    const sid = makeSessionId('expire');
    store.createSession({ id: sid, model: 'm' });

    // Wait >1s so that updated_at is strictly before datetime('now')
    await new Promise((r) => setTimeout(r, 1100));

    // Expire with maxAgeHours=0 — everything older than 0 seconds should expire
    const expired = store.expireOldSessions(0);
    assert.ok(expired >= 1, 'at least one session expired');

    const session = store.getSession(sid);
    assert.strictEqual(session!.status, 'expired');
  });

  it('expireOldSessions does not affect already completed sessions', () => {
    const sidCompleted = makeSessionId('exp-comp');
    store.createSession({ id: sidCompleted, model: 'm' });
    store.updateSessionStatus(sidCompleted, 'completed');

    const expired = store.expireOldSessions(0);
    // completed sessions are NOT in the WHERE clause, so they should stay completed
    const session = store.getSession(sidCompleted);
    assert.strictEqual(session!.status, 'completed');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Edge Cases
// ═══════════════════════════════════════════════════════════════════

describe('SessionStore — Edge Cases', () => {
  let store: ReturnType<typeof createSessionStore>;

  beforeEach(() => {
    cleanup();
    store = createSessionStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    cleanup();
  });

  it('handles session with empty content (null message)', () => {
    const sid = makeSessionId('null-content');
    store.createSession({ id: sid, model: 'm' });
    store.saveMessages(sid, [
      { role: 'user', content: null },
    ]);

    const msgs = store.getMessages(sid);
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].content, null);
    assert.strictEqual(msgs[0].role, 'user');
  });

  it('handles tool message with tool_call_id', () => {
    const sid = makeSessionId('tool-msg');
    store.createSession({ id: sid, model: 'm' });
    store.saveMessages(sid, [
      { role: 'tool', content: 'result', toolCallId: 'call_abc123' },
    ]);

    const msgs = store.getMessages(sid);
    assert.strictEqual(msgs[0].toolCallId, 'call_abc123');
    assert.strictEqual(msgs[0].role, 'tool');
  });

  it('createSession with optional fields omitted uses defaults', () => {
    const sid = makeSessionId('minimal');
    const session = store.createSession({ id: sid, model: 'm' });
    assert.strictEqual(session.systemPrompt, '');
    assert.strictEqual(session.cwd, '');
    assert.strictEqual(session.messageCount, 0);
    assert.strictEqual(session.status, 'active');
  });

  it('getMessages for session with no messages returns empty array', () => {
    const sid = makeSessionId('no-msgs');
    store.createSession({ id: sid, model: 'm' });
    const msgs = store.getMessages(sid);
    assert.ok(Array.isArray(msgs));
    assert.strictEqual(msgs.length, 0);
  });
});
