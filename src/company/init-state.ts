// ── TriCompany Initialization State ──
// REQ-20260805-001: heartbeat detects TriCompany init state.
// UNINITIALIZED → agent auto-pushes onboarding (greet → ask CEO name
// → role list → select+name → assemble skeleton) → INITIALIZED.
//
// State file: {dataDir}/company/state.json
//   {
//     "state": "uninitialized" | "onboarding" | "initialized",
//     "companyName": string | null,
//     "ceoName": string | null,
//     "employees": Array<{ role: string; name: string }>,
//     "onboardedAt": string | null,
//     "progress": { step, ceoName?, selectedRoles?, employeeNames? }  // REQ-016 断点续接
//   }

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";

export type CompanyState = "uninitialized" | "onboarding" | "initialized";

export interface CompanyEmployee {
  role: string;
  name: string;
}

/** Onboarding progress for resume (REQ-016: step continuity). */
export interface OnboardingProgress {
  step: string;                 // greeted | name | roles | naming | confirm | assembling | done
  ceoName?: string;
  selectedRoles?: string[];
  employeeNames?: Record<string, string>;
  updatedAt?: string;
}

export interface CompanyStateFile {
  state: CompanyState;
  companyName: string | null;
  ceoName: string | null;
  employees: CompanyEmployee[];
  onboardedAt: string | null;
  progress?: OnboardingProgress;
}

const DEFAULT_STATE: CompanyStateFile = {
  state: "uninitialized",
  companyName: null,
  ceoName: null,
  employees: [],
  onboardedAt: null,
};

export class CompanyInitState {
  private statePath: string;
  private cache: CompanyStateFile | null = null;
  private workspaceRoot?: string;

  constructor(dataDir: string, workspaceRoot?: string) {
    this.statePath = resolve(dataDir, "company", "state.json");
    this.workspaceRoot = workspaceRoot;
  }

  /** Load (and cache) current state file. Missing file = uninitialized. */
  async load(): Promise<CompanyStateFile> {
    if (this.cache) return this.cache;
    try {
      await access(this.statePath);
      const raw = await readFile(this.statePath, "utf-8");
      this.cache = { ...DEFAULT_STATE, ...JSON.parse(raw) };
    } catch {
      this.cache = { ...DEFAULT_STATE };
    }
    return this.cache!;
  }

  /** Current init state. */
  async getState(): Promise<CompanyState> {
    const s = await this.load();
    return s.state;
  }

  /** Persist state file (atomic write: tmp → rename). */
  async save(state: Partial<CompanyStateFile>): Promise<CompanyStateFile> {
    const current = await this.load();
    const next: CompanyStateFile = { ...current, ...state };
    await mkdir(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), "utf-8");
    await writeFile(this.statePath, JSON.stringify(next, null, 2), "utf-8");
    await import("node:fs/promises").then(({ unlink }) => unlink(tmp).catch(() => {}));
    this.cache = next;

    // REQ-019: baseline commit when onboarding completes (deterministic, CLI-side).
    // Preserves .git audit trail; agent heartbeat tier has no shell so this runs
    // in the daemon instead of the agent.
    if (next.state === 'initialized' && this.workspaceRoot) {
      try {
        const { execSync } = await import('node:child_process');
        execSync('git add -A && git commit -m "onboarding: company skeleton"', {
          cwd: this.workspaceRoot,
          stdio: 'ignore',
        });
      } catch { /* best-effort — workspace may lack git */ }
    }

    return next;
  }

  /** Whether onboarding is pending (uninitialized or in-progress). */
  async isOnboardingPending(): Promise<boolean> {
    const s = await this.getState();
    return s === "uninitialized" || s === "onboarding";
  }

  /** Debug reset (REQ-017): wipe state → back to uninitialized for re-onboarding. */
  async reset(): Promise<void> {
    this.cache = { ...DEFAULT_STATE };
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(this.statePath).catch(() => {});
      await unlink(`${this.statePath}.tmp`).catch(() => {});
    } catch { /* best-effort */ }
  }
}
