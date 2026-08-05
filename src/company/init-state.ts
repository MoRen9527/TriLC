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
//     "onboardedAt": string | null
//   }

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";

export type CompanyState = "uninitialized" | "onboarding" | "initialized";

export interface CompanyEmployee {
  role: string;
  name: string;
}

export interface CompanyStateFile {
  state: CompanyState;
  companyName: string | null;
  ceoName: string | null;
  employees: CompanyEmployee[];
  onboardedAt: string | null;
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

  constructor(dataDir: string) {
    this.statePath = resolve(dataDir, "company", "state.json");
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
    return next;
  }

  /** Whether onboarding is pending (uninitialized or in-progress). */
  async isOnboardingPending(): Promise<boolean> {
    const s = await this.getState();
    return s === "uninitialized" || s === "onboarding";
  }
}
