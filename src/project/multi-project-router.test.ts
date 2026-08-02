// ── Multi-Project Router Unit Tests ──
// Verifies all 6 isolation guarantees from the verification document.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  resolveProjectPaths,
  ensureProjectDirs,
  isPathInProject,
  enforceProjectIsolation,
  detectLegacyData,
  getSessionDbPath,
  getEventQueueDbPath,
  getCronDbPath,
  getKeyCachePath,
  listActiveProjects,
  _clearProjectRegistry,
} from './multi-project-router.js';

const TEST_BASE = join(tmpdir(), `trilc-mpr-test-${randomUUID().slice(0, 8)}`);
const PROJECT_A = join(TEST_BASE, 'project-a');
const PROJECT_B = join(TEST_BASE, 'project-b');
const GLOBAL_DATA = join(TEST_BASE, 'global-data');

function cleanDir(p: string) {
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

beforeEach(() => {
  _clearProjectRegistry();
  mkdirSync(PROJECT_A, { recursive: true });
  mkdirSync(PROJECT_B, { recursive: true });
});

afterEach(() => {
  _clearProjectRegistry();
  cleanDir(TEST_BASE);
});

// ── G1, G2, G3: Path resolution ──

describe('resolveProjectPaths', () => {
  it('resolves all paths under project root', () => {
    const paths = resolveProjectPaths(PROJECT_A);
    assert.equal(paths.projectRoot, resolve(PROJECT_A));
    assert.equal(paths.cognitionDir, join(resolve(PROJECT_A), '.tricompany-cognition'));
    assert.equal(paths.operatingRecordsDir, join(resolve(PROJECT_A), 'docs', 'execution', 'operating-records'));
    assert.equal(paths.sessionDbPath, join(resolve(PROJECT_A), '.tricompany-cognition', 'sessions.db'));
    assert.equal(paths.eventQueueDbPath, join(resolve(PROJECT_A), '.tricompany-cognition', 'event-queue.db'));
    assert.equal(paths.cronDbPath, join(resolve(PROJECT_A), '.tricompany-cognition', 'cron.db'));
    assert.equal(paths.keyCachePath, join(resolve(PROJECT_A), '.tricompany-cognition', 'key-cache.json'));
  });

  it('defaults to cwd when no project root given', () => {
    const paths = resolveProjectPaths();
    assert.equal(paths.projectRoot, process.cwd());
  });

  it('caches results for same project root', () => {
    const a = resolveProjectPaths(PROJECT_A);
    const b = resolveProjectPaths(PROJECT_A);
    assert.strictEqual(a, b);
  });

  it('returns different results for different project roots', () => {
    const a = resolveProjectPaths(PROJECT_A);
    const b = resolveProjectPaths(PROJECT_B);
    assert.notStrictEqual(a, b);
    assert.notEqual(a.projectRoot, b.projectRoot);
    assert.notEqual(a.cognitionDir, b.cognitionDir);
    assert.notEqual(a.sessionDbPath, b.sessionDbPath);
  });
});

// ── G5: Project ID stability ──

describe('deriveProjectId (via resolveProjectPaths)', () => {
  it('produces stable IDs for the same path', () => {
    const a = resolveProjectPaths(PROJECT_A);
    const b = resolveProjectPaths(PROJECT_A);
    assert.equal(a.projectId, b.projectId);
    assert.equal(a.projectId.length, 12);
  });

  it('produces different IDs for different paths', () => {
    const a = resolveProjectPaths(PROJECT_A);
    const b = resolveProjectPaths(PROJECT_B);
    assert.notEqual(a.projectId, b.projectId);
  });
});

// ── ensureProjectDirs ──

describe('ensureProjectDirs', () => {
  it('creates cognition and operating-records directories', () => {
    const paths = ensureProjectDirs(PROJECT_A);
    assert.ok(existsSync(paths.cognitionDir));
    assert.ok(existsSync(paths.operatingRecordsDir));
  });

  it('is idempotent', () => {
    ensureProjectDirs(PROJECT_A);
    ensureProjectDirs(PROJECT_A);
    const paths = resolveProjectPaths(PROJECT_A);
    assert.ok(existsSync(paths.cognitionDir));
  });
});

// ── isPathInProject ──

describe('isPathInProject', () => {
  it('returns true for paths within project cognition dir', () => {
    const paths = resolveProjectPaths(PROJECT_A);
    assert.ok(isPathInProject(paths.sessionDbPath, PROJECT_A));
    assert.ok(isPathInProject(paths.cronDbPath, PROJECT_A));
  });

  it('returns false for paths outside project cognition dir', () => {
    const bPaths = resolveProjectPaths(PROJECT_B);
    assert.ok(!isPathInProject(bPaths.sessionDbPath, PROJECT_A));
    assert.ok(!isPathInProject(join(tmpdir(), 'random.db'), PROJECT_A));
  });
});

// ── G4: Cross-project isolation enforcement ──

describe('enforceProjectIsolation', () => {
  it('throws on cross-project access', () => {
    const bPaths = resolveProjectPaths(PROJECT_B);
    assert.throws(
      () => enforceProjectIsolation(PROJECT_A, bPaths.sessionDbPath),
      /Cross-project access denied/,
    );
  });

  it('does not throw for valid in-project access', () => {
    const aPaths = resolveProjectPaths(PROJECT_A);
    assert.doesNotThrow(
      () => enforceProjectIsolation(PROJECT_A, aPaths.sessionDbPath),
    );
  });

  it('throws for paths outside any project cognition dir', () => {
    assert.throws(
      () => enforceProjectIsolation(PROJECT_A, join(tmpdir(), 'random.db')),
      /Cross-project access denied/,
    );
  });

  it('includes project and target in error message', () => {
    const bPaths = resolveProjectPaths(PROJECT_B);
    try {
      enforceProjectIsolation(PROJECT_A, bPaths.sessionDbPath);
      assert.fail('should have thrown');
    } catch (e: any) {
      assert.ok(e.message.includes(resolve(PROJECT_A)));
      assert.ok(e.message.includes('outside its cognition directory'));
    }
  });
});

// ── G6: Legacy data detection ──

describe('detectLegacyData', () => {
  it('returns null when project already has data', () => {
    const paths = ensureProjectDirs(PROJECT_A);
    writeFileSync(paths.sessionDbPath, 'mock', 'utf-8');
    const result = detectLegacyData(GLOBAL_DATA, PROJECT_A);
    assert.equal(result, null);
  });

  it('returns null when no project data and no legacy data', () => {
    const result = detectLegacyData(GLOBAL_DATA, PROJECT_A);
    assert.equal(result, null);
  });

  it('returns legacy paths when global data exists and project has none', () => {
    mkdirSync(GLOBAL_DATA, { recursive: true });
    writeFileSync(join(GLOBAL_DATA, 'sessions.db'), 'legacy', 'utf-8');
    const result = detectLegacyData(GLOBAL_DATA, PROJECT_A);
    assert.ok(result !== null);
    if (result) {
      assert.equal(result.legacySessionDb, join(GLOBAL_DATA, 'sessions.db'));
      assert.equal(result.legacyEventDb, join(GLOBAL_DATA, 'event-queue.db'));
      assert.equal(result.legacyCronDir, join(GLOBAL_DATA, 'cron'));
    }
  });

  it('detects legacy cron dir only (no session db)', () => {
    mkdirSync(GLOBAL_DATA, { recursive: true });
    mkdirSync(join(GLOBAL_DATA, 'cron'), { recursive: true });
    const result = detectLegacyData(GLOBAL_DATA, PROJECT_A);
    assert.ok(result !== null);
  });
});

// ── Store factory helpers ──

describe('store factory helpers', () => {
  it('getSessionDbPath delegates to resolveProjectPaths', () => {
    assert.equal(getSessionDbPath(PROJECT_A), resolveProjectPaths(PROJECT_A).sessionDbPath);
  });

  it('getEventQueueDbPath delegates to resolveProjectPaths', () => {
    assert.equal(getEventQueueDbPath(PROJECT_A), resolveProjectPaths(PROJECT_A).eventQueueDbPath);
  });

  it('getCronDbPath delegates to resolveProjectPaths', () => {
    assert.equal(getCronDbPath(PROJECT_A), resolveProjectPaths(PROJECT_A).cronDbPath);
  });

  it('getKeyCachePath delegates to resolveProjectPaths', () => {
    assert.equal(getKeyCachePath(PROJECT_A), resolveProjectPaths(PROJECT_A).keyCachePath);
  });
});

// ── Registry lifecycle ──

describe('project registry lifecycle', () => {
  it('listActiveProjects returns registered projects', () => {
    resolveProjectPaths(PROJECT_A);
    resolveProjectPaths(PROJECT_B);
    const projects = listActiveProjects();
    assert.equal(projects.length, 2);
  });

  it('_clearProjectRegistry clears the registry', () => {
    resolveProjectPaths(PROJECT_A);
    _clearProjectRegistry();
    assert.equal(listActiveProjects().length, 0);
  });
});
