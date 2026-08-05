// ── CompanyInitState tests (REQ-001) ──
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanyInitState } from "../src/company/init-state.js";

test("uninitialized when state file missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tricompany-test-"));
  const s = new CompanyInitState(dir);
  assert.equal(await s.getState(), "uninitialized");
  assert.equal(await s.isOnboardingPending(), true);
  await rm(dir, { recursive: true, force: true });
});

test("save transitions state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tricompany-test-"));
  const s = new CompanyInitState(dir);

  await s.save({ state: "onboarding", companyName: "Test Co", ceoName: "Alice" });
  assert.equal(await s.getState(), "onboarding");
  assert.equal(await s.isOnboardingPending(), true);

  await s.save({
    state: "initialized",
    employees: [{ role: "full-stack-developer", name: "Bob" }],
    onboardedAt: new Date().toISOString(),
  });
  assert.equal(await s.getState(), "initialized");
  assert.equal(await s.isOnboardingPending(), false);

  // Verify persisted file
  const raw = await readFile(join(dir, "company", "state.json"), "utf-8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.state, "initialized");
  assert.equal(parsed.employees[0].name, "Bob");
  await rm(dir, { recursive: true, force: true });
});

test("load existing state file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tricompany-test-"));
  const s1 = new CompanyInitState(dir);
  await s1.save({ state: "initialized", companyName: "Persisted" });

  const s2 = new CompanyInitState(dir);
  assert.equal(await s2.getState(), "initialized");
  assert.equal((await s2.load()).companyName, "Persisted");
  await rm(dir, { recursive: true, force: true });
});
