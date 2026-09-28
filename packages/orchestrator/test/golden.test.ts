// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DiagnosticSchema } from "@engintel/config";
import { loadGoldens, materializeScenario, type GoldenFixture } from "@engintel/testkit";
import { describe, expect, test } from "vitest";
import { serializeReport, validateRepository, type ValidationReport } from "../src/index.js";

/**
 * Golden fixtures (tests/golden, GOLDEN.md). expected.json holds, per
 * scenario, the full validation report minus engineVersion. The outcome table
 * below is pinned separately so a regenerated expected.json cannot silently
 * flip a verdict.
 *
 * Regenerate after reviewing the diff, never to make an implementation pass:
 *   ENGINTEL_UPDATE_EXPECTED=1 pnpm --filter @engintel/orchestrator test
 */

const OUTCOMES: Record<string, Record<string, "pass" | "fail">> = {
  "valid-architecture": { full: "pass", "changed-service": "pass" },
  circular: { full: "fail", "changed-discount": "fail" },
  "invalid-layer": { "skip-layer": "fail" },
  unresolved: { "changed-export": "fail" },
  exceptions: { "after-expiry": "fail", "before-expiry": "pass" },
  "prompt-injection": { "injected-comments": "fail" },
  "unreadable-files": { "changed-unanalyzable": "fail", "unchanged-unanalyzable": "pass", "allowlisted-change": "pass" },
  "existing-violations": { "unrelated-change": "pass", "touch-legacy-file": "pass", "new-violation": "fail" },
};
/** Policy-change detection arrives with ENG-012. */
const LATER = ["policy-change"];

const UPDATE = process.env["ENGINTEL_UPDATE_EXPECTED"] === "1";
const goldens = loadGoldens();
const fixture = (id: string) => goldens.find((g) => g.id === id) as GoldenFixture;

/** A scenario's base/ holds the merge-base versions of the policy files. */
function baseOf(baseDir: string | null): { contract: string | null; baseline: string | null } | undefined {
  if (!baseDir) return undefined;
  const read = (rel: string) => (existsSync(join(baseDir, rel)) ? readFileSync(join(baseDir, rel), "utf8") : null);
  return { contract: read(".engintel/architecture.json"), baseline: read(".engintel/baseline.json") };
}

async function runScenario(g: GoldenFixture, name: string): Promise<ValidationReport> {
  const m = materializeScenario(g, name);
  try {
    const s = m.scenario;
    const base = baseOf(m.baseDir);
    return await validateRepository({
      root: m.dir,
      now: s.now,
      scope: s.mode === "full" ? { mode: "full" } : { mode: "changed", changedFiles: s.changedFiles, contractChanged: s.contractChanged },
      ...(base ? { base } : {}),
    });
  } finally {
    m.cleanup();
  }
}

function comparable(report: ValidationReport): unknown {
  const { engineVersion: _engineVersion, ...rest } = report;
  return JSON.parse(JSON.stringify(rest));
}

const reports = new Map<string, ValidationReport>();
async function reportFor(id: string, scenario: string): Promise<ValidationReport> {
  const key = `${id}/${scenario}`;
  let report = reports.get(key);
  if (!report) {
    report = await runScenario(fixture(id), scenario);
    reports.set(key, report);
  }
  return report;
}

describe("golden expected.json", () => {
  test("every fixture is either targeted by Phase 1 or explicitly deferred", () => {
    expect([...Object.keys(OUTCOMES), ...LATER].sort()).toEqual(goldens.map((g) => g.id).sort());
    for (const id of Object.keys(OUTCOMES)) expect(Object.keys(OUTCOMES[id] ?? {}).sort()).toEqual(Object.keys(fixture(id).scenarios).sort());
  });

  test.each(Object.keys(OUTCOMES))("%s matches expected.json and the pinned outcomes", async (id) => {
    const g = fixture(id);
    const actual: Record<string, unknown> = {};
    for (const scenario of Object.keys(g.scenarios).sort()) {
      const report = await reportFor(id, scenario);
      expect(report.outcome, `${id}/${scenario}`).toBe(OUTCOMES[id]?.[scenario]);
      expect(report.exitCode).toBe(report.outcome === "fail" ? 1 : 0);
      for (const d of report.diagnostics) expect(DiagnosticSchema.safeParse(d).error?.issues ?? []).toEqual([]);
      actual[scenario] = comparable(report);
    }
    if (UPDATE) {
      writeFileSync(join(g.dir, "expected.json"), `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }
    expect(g.expected, `${id}/expected.json is empty; regenerate it`).not.toBeNull();
    expect(actual).toEqual(g.expected);
  });

  test.each(LATER)("%s stays {} until Phase 2", (id) => {
    expect(fixture(id).expected).toBeNull();
  });
});

describe("golden behaviour (GOLDEN.md)", () => {
  test("circular: one cycle with the canonical signature; changing one member gives the same identity", async () => {
    const full = await reportFor("circular", "full");
    const changed = await reportFor("circular", "changed-discount");
    expect(full.diagnostics.map((d) => [d.ruleId, d.cycleSignature])).toEqual([["acyclic-domain", "src/domain/discount.ts -> src/domain/pricing.ts"]]);
    expect(changed.diagnostics.map((d) => d.identity)).toEqual(full.diagnostics.map((d) => d.identity));
  });

  test("invalid-layer: value and type-only skip-layer imports, each with the legal route and OrderService", async () => {
    const r = await reportFor("invalid-layer", "skip-layer");
    expect(r.diagnostics.map((d) => [d.ruleId, d.file, d.edge?.kind])).toEqual([
      ["no-controller-to-repository", "src/controllers/audit.controller.ts", "type-only"],
      ["no-controller-to-repository", "src/controllers/report.controller.ts", "import"],
    ]);
    for (const d of r.diagnostics) {
      expect(d.suggest.layers).toEqual(["controllers", "services", "repositories"]);
      expect(d.suggest.explanation).toContain("OrderService");
      expect(d.suggest.explanation).toContain("src/services/order.service.ts");
    }
  });

  test("unresolved: missing module and opaque import fail; a literal import() is a legal edge", async () => {
    const r = await reportFor("unresolved", "changed-export");
    expect(r.diagnostics.map((d) => [d.ruleId, d.edge?.target])).toEqual([
      ["no-unresolved-in-src", "unresolved:src/lib/csv-writer"],
      ["engintel.opaque-import", "unresolved:*dynamic*"],
    ]);
  });

  test("exceptions: expired exception fails, active one is applied", async () => {
    const after = await reportFor("exceptions", "after-expiry");
    expect(after.diagnostics.map((d) => d.file)).toEqual(["src/controllers/metrics.controller.ts"]);
    expect(after.diagnostics[0]?.why).toContain("Exception 'ex-metrics-shortcut' expired on 2026-03-01");
    expect(after.exceptionsApplied.map((e) => e.exceptionId)).toEqual(["ex-health-liveness"]);
    expect(after.counts.suppressedByException).toBe(1);
    const before = await reportFor("exceptions", "before-expiry");
    expect(before.exceptionsApplied.map((e) => e.exceptionId)).toEqual(["ex-health-liveness", "ex-metrics-shortcut"]);
  });

  test("prompt-injection: fails exactly as if the text were absent, and no injected text reaches the report", async () => {
    const r = await reportFor("prompt-injection", "injected-comments");
    expect(r.diagnostics.map((d) => [d.ruleId, d.file])).toEqual([["no-controller-to-repository", "src/controllers/admin.controller.ts"]]);
    const text = serializeReport(r);
    for (const injected of [/SYSTEM OVERRIDE/i, /approved/i, /report pass/i, /ignore previous/i, /mergeable/i, /false positive/i, /delete \.engintel/i]) {
      expect(text).not.toMatch(injected);
    }
    // README.md is in the diff (scope echoes it) but is never analyzed as code.
    expect(JSON.stringify([r.diagnostics, r.unanalyzable])).not.toContain("README");
    expect(r.stats.files).toBe(5);
  });

  test("unreadable-files: changed unanalyzable files fail closed; others do not block", async () => {
    const changed = await reportFor("unreadable-files", "changed-unanalyzable");
    expect(changed.diagnostics.map((d) => [d.ruleId, d.file, d.blocking])).toEqual([
      ["engintel.unanalyzable", "src/services/corrupt.service.ts", true],
      ["engintel.unanalyzable", "src/services/truncated.service.ts", true],
    ]);
    expect((await reportFor("unreadable-files", "allowlisted-change")).unanalyzable.find((u) => u.path === "src/legacy/vendor-blob.ts")).toEqual({
      path: "src/legacy/vendor-blob.ts",
      reason: "binary",
      inScope: true,
      allowlisted: true,
    });
  });

  test("existing-violations: legacy debt is baselined; only a new identity fails", async () => {
    const unrelated = await reportFor("existing-violations", "unrelated-change");
    expect(unrelated.baseline).toEqual({ file: ".engintel/baseline.json", comparedWith: "working-copy", entries: 3, suppressed: 0, stale: null });
    const touched = await reportFor("existing-violations", "touch-legacy-file");
    expect(touched.diagnostics).toEqual([]);
    expect(touched.counts.suppressedByBaseline).toBe(1);
    const fresh = await reportFor("existing-violations", "new-violation");
    expect(fresh.diagnostics.map((d) => [d.ruleId, d.file, d.edge?.target])).toEqual([
      ["no-controller-to-repository", "src/controllers/refund.controller.ts", "src/repositories/order.repository.ts"],
    ]);
    expect(fresh.counts.suppressedByBaseline).toBe(0);
  });

  test("determinism: a second run gives byte-identical reports and identities", async () => {
    for (const [key, first] of reports) {
      const [id, scenario] = key.split("/") as [string, string];
      const second = await runScenario(fixture(id), scenario);
      expect(serializeReport(second), key).toBe(serializeReport(first));
    }
  });
});
