// ── Weekly Plane Root Resolver + Router Two-Track Tests (r2-2) ──
// Covers: env override / env nonexistent / env empty → sibling / sibling
// conditional, plus router two-track semantics (injected companyWeeklyPlaneDir,
// undefined fallback, ensureProjectDirs never creates the company track).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { resolveWeeklyPlaneRoot } from './weekly-plane-root.js';
import {
  resolveProjectPaths,
  ensureProjectDirs,
  _clearProjectRegistry,
} from './multi-project-router.js';

const ORIG_ENV = process.env.TRILC_WEEKLY_PLANE_ROOT;

/**
 * Hardcoded workspace fact anchor (r2-3 重验口径): the sibling expectation
 * is an INDEPENDENT fact — the absolute path of the local workspace layout —
 * deliberately NOT derived from the implementation's hop-count logic. If the
 * implementation regresses its depth, this forced assertion goes red instead
 * of silently passing through a false-negative else branch.
 */
const WORKSPACE_SIBLING_FACT = resolve(
  'D:/Code/ai',
  'TriMetaverse',
  'docs',
  'workflow',
  'operating-records',
);

function siblingFactExists(): boolean {
  return existsSync(WORKSPACE_SIBLING_FACT);
}

/**
 * Relaxed fallback (non-fact-anchor environments only): the resolver may
 * legitimately return undefined (no discovery) OR an existing directory
 * discovered via hop-count derivation on a non-standard workspace layout.
 * The strict forced-hit branch is reserved for hosts where the fact anchor
 * exists — no false reds on CI runners.
 */
function assertRelaxedFallback(result: string | undefined): void {
  assert.ok(
    result === undefined || (typeof result === 'string' && existsSync(result)),
    `fallback must be undefined or an existing discovered directory, got: ${result}`,
  );
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
    const result = resolveWeeklyPlaneRoot();
    // Workspace present → MUST hit the hardcoded fact; absent → relaxed fallback.
    if (siblingFactExists()) {
      assert.equal(result, WORKSPACE_SIBLING_FACT);
    } else {
      assertRelaxedFallback(result);
    }
  });

  it('no env + workspace sibling exists → MUST hit (forced assertion)', () => {
    if (!siblingFactExists()) {
      // Non-standard workspace (CI runner / server): relaxed fallback only.
      assertRelaxedFallback(resolveWeeklyPlaneRoot());
      return;
    }
    // Forced hit: independent fact anchor, no else-branch escape hatch.
    assert.equal(resolveWeeklyPlaneRoot(), WORKSPACE_SIBLING_FACT);
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
        paths.companyWeeklyPlaneDir === WORKSPACE_SIBLING_FACT,
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
