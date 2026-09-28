// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { ArchitectureContractSchema, parseBaseline, type BaselineFile } from "@engintel/config";
import type { GraphEdge, ModuleGraph } from "@engintel/graph";
import { describe, expect, test } from "vitest";
import {
  BASELINE_FORBIDDEN_RULES,
  applyBaseline,
  baselineCandidates,
  checkBaselineIntegrity,
  evaluate,
  violationIdentity,
  type EvaluationResult,
  type Finding,
  type SourceFileState,
} from "../src/index.js";

const contract = ArchitectureContractSchema.parse({
  schemaVersion: 1,
  policyVersion: "1.0.0",
  status: "active",
  layers: [
    { id: "controllers", globs: ["src/controllers/**"] },
    { id: "services", globs: ["src/services/**"] },
    { id: "repositories", globs: ["src/repositories/**"] },
  ],
  rules: [
    { id: "no-controller-to-repository", kind: "forbidden", severity: "error", from: { layer: "controllers" }, to: { layer: "repositories" }, comment: "Use a service." },
    { id: "acyclic", kind: "acyclic", severity: "error", within: { glob: "src/**" }, comment: "No cycles." },
  ],
});

const edge = (from: string, to: string): GraphEdge => ({ from, to, kind: "import", specifier: to, isTypeOnly: false, isDynamic: false, isReExport: false });

function run(edges: [string, string][], files: SourceFileState[] = []): EvaluationResult {
  const graph: ModuleGraph = { schemaVersion: 1, nodes: [], edges: edges.map(([a, b]) => edge(a, b)) };
  const paths = [...new Set(edges.flat())].map((path) => ({ path, unanalyzable: null }));
  return evaluate({ contract, graph, files: [...paths, ...files], facts: new Map(), scope: { mode: "full" }, now: "2026-09-01" });
}

const LEGACY: [string, string] = ["src/controllers/legacy.controller.ts", "src/repositories/order.repository.ts"];
const NEW: [string, string] = ["src/controllers/refund.controller.ts", "src/repositories/order.repository.ts"];

function baselineOf(findings: readonly Finding[], extra: Partial<BaselineFile["entries"][number]>[] = []): BaselineFile {
  return parseBaseline({
    schemaVersion: 1,
    engineIdentityVersion: 1,
    policyVersionAtWrite: "1.0.0",
    writtenAt: "2026-09-01",
    writtenBy: "alice",
    entries: [
      ...findings.map((f) => ({ identity: f.identity, ruleId: f.ruleId, source: f.source, target: f.target, cycleSignature: f.cycleSignature, firstSeenAt: "2026-09-01", lastSeenAt: "2026-09-01" })),
      ...extra,
    ],
  }).baseline;
}

describe("findings", () => {
  test("carry exactly the normalized fields their identity is computed from", () => {
    const result = run([LEGACY, ["src/services/a.ts", "src/services/b.ts"], ["src/services/b.ts", "src/services/a.ts"]]);
    expect(result.findings.map((f) => [f.ruleId, f.source, f.target, f.cycleSignature])).toEqual(
      expect.arrayContaining([
        ["no-controller-to-repository", LEGACY[0], LEGACY[1], null],
        ["acyclic", "src/services/a.ts", "src/services/b.ts", "src/services/a.ts -> src/services/b.ts"],
      ]),
    );
    for (const f of result.findings) expect(violationIdentity(f)).toBe(f.identity);
  });
});

describe("applyBaseline (ENG-009)", () => {
  test("baselined debt passes; a new identity still fails, alone", () => {
    const debt = run([LEGACY]);
    const baselined = new Set(baselineCandidates(debt).map((f) => f.identity));
    const same = applyBaseline(run([LEGACY]), baselined);
    expect(same.outcome).toBe("pass");
    expect(same.counts).toMatchObject({ errors: 0, suppressedByBaseline: 1 });
    const grown = applyBaseline(run([LEGACY, NEW]), baselined);
    expect(grown.outcome).toBe("fail");
    expect(grown.diagnostics.map((d) => d.file)).toEqual([NEW[0]]);
    expect(grown.counts.suppressedByBaseline).toBe(1);
  });

  test("fail-closed findings are never suppressed, even if their identity is listed", () => {
    const broken: SourceFileState = { path: "src/services/broken.ts", unanalyzable: { reason: "syntax-error", detail: "x" } };
    const result = run([LEGACY], [broken]);
    const everything = new Set(result.findings.map((f) => f.identity));
    const applied = applyBaseline(result, everything);
    expect(applied.diagnostics.map((d) => d.ruleId)).toEqual(["engintel.unanalyzable"]);
    expect(applied.outcome).toBe("fail");
  });

  test("an empty baseline changes nothing", () => {
    const result = run([LEGACY]);
    expect(applyBaseline(result, new Set())).toBe(result);
  });
});

describe("checkBaselineIntegrity", () => {
  test("a baseline written from findings is intact", () => {
    expect(checkBaselineIntegrity(baselineOf(baselineCandidates(run([LEGACY]))))).toEqual([]);
  });

  test("an entry edited by hand no longer matches its identity", () => {
    const [finding] = baselineCandidates(run([LEGACY]));
    const original = baselineOf([finding as Finding]).entries[0];
    const tampered = baselineOf([], [{ ...original, source: "src/controllers/other.controller.ts" }]);
    expect(checkBaselineIntegrity(tampered)).toEqual([{ path: "entries[0].identity", message: expect.stringContaining("does not match its fields") }]);
  });

  test("fail-closed rules cannot be smuggled into the baseline", () => {
    const identity = violationIdentity({ ruleId: "engintel.unanalyzable", source: "src/a.ts", target: "<unanalyzable>" });
    const smuggled = baselineOf([], [
      { identity, ruleId: "engintel.unanalyzable", source: "src/a.ts", target: "<unanalyzable>", cycleSignature: null, firstSeenAt: "2026-09-01", lastSeenAt: "2026-09-01" },
    ]);
    expect(checkBaselineIntegrity(smuggled)).toEqual([{ path: "entries[0].ruleId", message: expect.stringContaining("can never be baselined") }]);
    expect([...BASELINE_FORBIDDEN_RULES].sort()).toEqual([
      "engintel.baseline-drop",
      "engintel.opaque-import",
      "engintel.overlapping-layers",
      "engintel.policy-change",
      "engintel.policy-weakening",
      "engintel.unanalyzable",
      "engintel.unresolved-import",
    ]);
  });
});
