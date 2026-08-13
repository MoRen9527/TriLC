// ── Weekly Plane Root Resolver + Router Two-Track Tests (r2-2) ──
// Covers: env override / env nonexistent / env empty → sibling / sibling
// conditional, plus router two-track semantics (injected companyWeeklyPlaneDir,
// undefined fallback, ensureProjectDirs never creates the company track).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { resolveWeeklyPlaneRoot } from './weekly-plane-root.js';
import {
  resolveProjectPaths,
  ensureProjectDirs,
  _clearProjectRegistry,
} from './multi-project-router.js';

const ORIG_ENV = process.env.TRILC_WEEKLY_PLANE_ROOT;

function expectedSiblingPath(): string {
  // Independently derived expectation — NOT copy-pasted from the implementation.
  // This test file lives at src/project/ → three hops up = the workspace root
  // D:/Code/ai, then into the sibling TriMetaverse checkout.
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  return resolve(scriptDir, '..', '..', '..', 'TriMetaverse', 'docs', 'workflow', 'operating-records');
}

describe('resolveWeeklyPlaneRoot', () => {
  beforeEach(() => {
    _clearProjectRegistry();
    delete process.env.TRILC_WEEKLY_PLANE_ROOT;
  });

  afterEach(() => {
    if (ORIG_ENV === undefined) delete process.env.TRILC_WEEKLY_PLANE_ROOT;
    else process.env.TRILC_WEEKLY_PLANE_ROOT = ORIG_ENV;
    _clearProjectRegistry();
  });

  it('env explicit → returns that root', () => {
    const dir = join(tmpdir(), `trilc-wpr-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    process.env.TRILC_WEEKLY_PLANE_ROOT = dir;
    try {
      assert.equal(resolveWeeklyPlaneRoot(), resolve(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('env explicit but nonexistent → undefined (no phantom root)', () => {
    process.env.TRILC_WEEKLY_PLANE_ROOT = join(tmpdir(), `trilc-wpr-missing-${randomUUID()}`);
    assert.equal(resolveWeeklyPlaneRoot(), undefined);
  });

  it('env empty string → falls through to sibling discovery', () => {
    process.env.TRILC_WEEKLY_PLANE_ROOT = '';
    const expected = expectedSiblingPath();
    const result = resolveWeeklyPlaneRoot();
    // Source-state workspace: sibling exists → hit; otherwise → undefined.
    if (existsSync(expected)) {
      assert.equal(result, expected);
    } else {
      assert.equal(result, undefined);
    }
  });

  it('no env → sibling hit when workspace present, else undefined', () => {
    const expected = expectedSiblingPath();
    const result = resolveWeeklyPlaneRoot();
    if (existsSync(expected)) {
      assert.equal(result, expected, 'source-state workspace should discover the sibling');
    } else {
      assert.equal(result, undefined, 'no sibling and no env → legacy fallback');
    }
  });
});

describe('router two-track semantics (r2-2)', () => {
  const fakeCompanyRoot = join(tmpdir(), `trilc-company-${randomUUID()}`);

  beforeEach(() => {
    _clearProjectRegistry();
    mkdirSync(fakeCompanyRoot, { recursive: true });
    delete process.env.TRILC_WEEKLY_PLANE_ROOT;
  });

  afterEach(() => {
    rmSync(fakeCompanyRoot, { recursive: true, force: true });
    _clearProjectRegistry();
  });

  it('resolveProjectPaths with injected weeklyPlaneRoot sets companyWeeklyPlaneDir', () => {
    const paths = resolveProjectPaths(tmpdir(), fakeCompanyRoot);
    assert.equal(paths.companyWeeklyPlaneDir, resolve(fakeCompanyRoot));
    // Legacy fields unchanged
    assert.equal(
      paths.operatingRecordsDir,
      join(resolve(tmpdir()), 'docs', 'execution', 'operating-records'),
    );
  });

  it('resolveProjectPaths without config → companyWeeklyPlaneDir undefined or discovered', () => {
    const paths = resolveProjectPaths(tmpdir());
    // In source-state workspace discovery may hit; both are valid.
    assert.ok(
      paths.companyWeeklyPlaneDir === undefined ||
        paths.companyWeeklyPlaneDir === expectedSiblingPath(),
    );
  });

  it('ensureProjectDirs never creates the company track', () => {
    const fakeRoot = join(tmpdir(), `trilc-company-missing-${randomUUID()}`);
    // Inject a company root that does NOT exist — ensureProjectDirs must not create it.
    const paths = ensureProjectDirs(undefined, fakeRoot);
    assert.equal(paths.companyWeeklyPlaneDir, fakeRoot);
    assert.equal(existsSync(fakeRoot), false, 'company weekly plane dir must never be auto-created');
    // Project track still created as before
    assert.ok(existsSync(paths.operatingRecordsDir));
  });
});
