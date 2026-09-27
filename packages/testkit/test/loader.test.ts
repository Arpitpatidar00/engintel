// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { E_NOT_IMPLEMENTED, GOLDEN_IDS, loadGoldens, materializeScenario, runCli } from "../src/index.js";

const goldens = loadGoldens();

describe("loadGoldens", () => {
  test("finds all nine fixtures, in reserved order", () => {
    expect(goldens.map((g) => g.id)).toEqual([...GOLDEN_IDS]);
  });

  test.each(goldens.map((g) => [g.id, g] as const))("%s has scenarios and a manifest hash", (_id, golden) => {
    expect(Object.keys(golden.scenarios).length).toBeGreaterThan(0);
    expect(golden.treeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(golden.repoDir, ".engintel", "architecture.json"))).toBe(true);
  });

  test("expected is null exactly when expected.json is {}", () => {
    for (const golden of goldens) {
      const raw = JSON.parse(readFileSync(join(golden.dir, "expected.json"), "utf8")) as object;
      expect(golden.expected === null).toBe(Object.keys(raw).length === 0);
    }
  });
});

describe("materializeScenario", () => {
  const fixture = goldens.find((g) => g.id === "existing-violations")!;

  test("copies repo/ and applies the overlay without touching the fixture", () => {
    const run = materializeScenario(fixture, "new-violation");
    try {
      expect(existsSync(join(run.dir, "src/controllers/refund.controller.ts"))).toBe(true);
      expect(existsSync(join(run.dir, ".engintel/architecture.json"))).toBe(true);
      expect(existsSync(join(fixture.repoDir, "src/controllers/refund.controller.ts"))).toBe(false);
      for (const changed of run.scenario.changedFiles) expect(existsSync(join(run.dir, changed))).toBe(true);
    } finally {
      run.cleanup();
    }
    expect(existsSync(run.dir)).toBe(false);
  });

  test("exposes base/ for policy-change scenarios", () => {
    const policy = goldens.find((g) => g.id === "policy-change")!;
    const run = materializeScenario(policy, "remove-forbidden-rule");
    try {
      expect(run.baseDir).not.toBeNull();
      expect(existsSync(join(run.baseDir!, ".engintel/architecture.json"))).toBe(true);
    } finally {
      run.cleanup();
    }
  });

  test("rejects an unknown scenario", () => {
    expect(() => materializeScenario(fixture, "no-such-scenario")).toThrow(/no scenario/);
  });
});

describe("runCli (Phase 0 stub)", () => {
  test("returns a coded not-implemented tool error", async () => {
    const result = await runCli(["validate", "--changed"], { cwd: goldens[0]!.repoDir });
    expect(result.exitCode).toBe(2);
    expect(result.errorCode).toBe(E_NOT_IMPLEMENTED);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("validate --changed");
  });
});
