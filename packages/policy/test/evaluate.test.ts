// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { ArchitectureContractSchema, DiagnosticSchema, type ArchitectureContractInput } from "@engintel/config";
import type { GraphEdge, ModuleGraph } from "@engintel/graph";
import { describe, expect, test } from "vitest";
import { evaluate, type EvaluationInput, type FileFacts, type Scope, type SourceFileState } from "../src/index.js";

// Table-driven rule engine tests (ENG-007). The contract mirrors the golden
// fixtures: controllers -> services -> repositories, everything -> domain.

const LAYERS: ArchitectureContractInput["layers"] = [
  { id: "controllers", globs: ["src/controllers/**"] },
  { id: "services", globs: ["src/services/**"] },
  { id: "repositories", globs: ["src/repositories/**"] },
  { id: "domain", globs: ["src/domain/**"] },
];

const RULES: ArchitectureContractInput["rules"] = [
  {
    id: "no-controller-to-repository",
    kind: "forbidden",
    severity: "error",
    from: { layer: "controllers" },
    to: { layer: "repositories" },
    comment: "Do not skip the service layer.",
  },
  { id: "no-service-to-controller", kind: "forbidden", severity: "error", from: { layer: "services" }, to: { layer: "controllers" }, comment: "No HTTP in services." },
  {
    id: "no-repository-upward",
    kind: "forbidden",
    severity: "error",
    from: { layer: "repositories" },
    to: { layers: ["services", "controllers"] },
    comment: "Repositories depend on nothing above them.",
  },
  {
    id: "no-upward-from-domain",
    kind: "forbidden",
    severity: "error",
    from: { layer: "domain" },
    to: { layers: ["controllers", "services", "repositories"] },
    comment: "Domain stays pure.",
  },
  { id: "acyclic-domain", kind: "acyclic", severity: "error", within: { layer: "domain" }, comment: "Break domain cycles." },
  { id: "no-unresolved-in-src", kind: "forbidden", severity: "error", from: { glob: "src/**" }, to: { unresolved: true }, comment: "Imports must resolve." },
];

function contractOf(overrides: Partial<ArchitectureContractInput> = {}) {
  return ArchitectureContractSchema.parse({ schemaVersion: 1, policyVersion: "1.0.0", status: "active", layers: LAYERS, rules: RULES, ...overrides });
}

type E = [from: string, to: string, kind?: GraphEdge["kind"], specifier?: string];

function graphOf(edges: E[], extraNodes: string[] = []): ModuleGraph {
  const graphEdges: GraphEdge[] = edges.map(([from, to, kind = "import", specifier]) => ({
    from,
    to,
    kind,
    specifier: specifier ?? to,
    isTypeOnly: kind === "type-only",
    isDynamic: kind === "dynamic",
    isReExport: kind === "re-export",
  }));
  const ids = [...new Set([...graphEdges.flatMap((e) => [e.from, e.to]), ...extraNodes])].sort();
  return {
    schemaVersion: 1,
    nodes: ids.map((id) => ({ id, kind: id.startsWith("unresolved:") ? "unresolved" : id.startsWith("external:") ? "external" : "module" })),
    edges: graphEdges,
  };
}

const APP = [
  "src/controllers/order.controller.ts",
  "src/services/order.service.ts",
  "src/repositories/order.repository.ts",
  "src/domain/order.ts",
];
const CLEAN: E[] = [
  ["src/controllers/order.controller.ts", "src/services/order.service.ts"],
  ["src/controllers/order.controller.ts", "src/domain/order.ts", "type-only"],
  ["src/services/order.service.ts", "src/repositories/order.repository.ts"],
  ["src/services/order.service.ts", "src/domain/order.ts", "type-only"],
  ["src/repositories/order.repository.ts", "src/domain/order.ts", "type-only"],
];
const SERVICE_FACTS: FileFacts = { imports: [], exports: [{ name: "OrderService", kind: "class" }] };

function run(opts: {
  edges: E[];
  files?: (string | SourceFileState)[];
  contract?: Partial<ArchitectureContractInput>;
  facts?: Record<string, FileFacts>;
  scope?: Scope;
  now?: string;
}) {
  const extra = (opts.files ?? []).map((f) => (typeof f === "string" ? f : f.path));
  const allPaths = [...new Set([...APP, ...extra, ...opts.edges.flatMap(([a, b]) => [a, b]).filter((p) => p.startsWith("src/"))])];
  const states = new Map<string, SourceFileState>(allPaths.map((p) => [p, { path: p, unanalyzable: null }]));
  for (const f of opts.files ?? []) if (typeof f !== "string") states.set(f.path, f);
  const input: EvaluationInput = {
    contract: contractOf(opts.contract),
    graph: graphOf(opts.edges),
    files: [...states.values()],
    facts: new Map(Object.entries({ "src/services/order.service.ts": SERVICE_FACTS, ...opts.facts })),
    scope: opts.scope ?? { mode: "full" },
    now: opts.now ?? "2026-09-01",
  };
  const result = evaluate(input);
  for (const d of result.diagnostics) expect(DiagnosticSchema.safeParse(d).error?.issues ?? []).toEqual([]);
  return result;
}

const rulesOf = (r: ReturnType<typeof run>) => r.diagnostics.map((d) => `${d.ruleId} ${d.file}`);

describe("forbidden edges", () => {
  test("a clean layered app passes with no diagnostics", () => {
    const r = run({ edges: CLEAN });
    expect(r.outcome).toBe("pass");
    expect(r.diagnostics).toEqual([]);
    expect(r.stats).toEqual({ files: 4, filesInScope: 4, edges: 5, edgesEvaluated: 5 });
  });

  test("a skip-layer import fails with what, why, where, edge, and a legal route naming a real export", () => {
    const r = run({
      edges: [...CLEAN, ["src/controllers/report.controller.ts", "src/repositories/order.repository.ts", "import", "../repositories/order.repository"]],
      facts: {
        "src/controllers/report.controller.ts": {
          imports: [{ specifier: "../repositories/order.repository", kind: "import", line: 3, column: 1 }],
          exports: [],
        },
      },
    });
    expect(r.outcome).toBe("fail");
    expect(r.diagnostics).toHaveLength(1);
    const d = r.diagnostics[0];
    expect(d).toMatchObject({
      ruleId: "no-controller-to-repository",
      severity: "error",
      blocking: true,
      adapter: "architecture",
      file: "src/controllers/report.controller.ts",
      range: { start: { line: 3, column: 1 }, end: { line: 3, column: 1 } },
      edge: { source: "src/controllers/report.controller.ts", target: "src/repositories/order.repository.ts", kind: "import" },
      suggest: { kind: "use-layer", layers: ["controllers", "services", "repositories"] },
    });
    expect(d?.message).toBe(
      "Forbidden dependency from layer 'controllers' to layer 'repositories': src/controllers/report.controller.ts imports src/repositories/order.repository.ts.",
    );
    expect(d?.why).toBe(
      "Layer 'controllers' is not allowed to depend on layer 'repositories' under rule 'no-controller-to-repository'. Do not skip the service layer.",
    );
    expect(d?.suggest.explanation).toBe(
      "Depend on layer 'services' instead, following the legal route controllers -> services -> repositories. For example, use OrderService (class) from src/services/order.service.ts.",
    );
  });

  test("type-only imports count unless ignoreTypeOnly", () => {
    const edges: E[] = [...CLEAN, ["src/controllers/audit.controller.ts", "src/repositories/order.repository.ts", "type-only"]];
    const r = run({ edges });
    expect(rulesOf(r)).toEqual(["no-controller-to-repository src/controllers/audit.controller.ts"]);
    expect(r.diagnostics[0]?.message).toContain("imports types from");
    const ignoring = RULES.map((rule) => (rule.id === "no-controller-to-repository" ? { ...rule, ignoreTypeOnly: true } : rule));
    expect(run({ edges, contract: { rules: ignoring } }).outcome).toBe("pass");
  });

  test("dynamic imports count unless ignoreDynamic", () => {
    const edges: E[] = [...CLEAN, ["src/controllers/lazy.controller.ts", "src/repositories/order.repository.ts", "dynamic"]];
    expect(rulesOf(run({ edges }))).toEqual(["no-controller-to-repository src/controllers/lazy.controller.ts"]);
    const ignoring = RULES.map((rule) => (rule.id === "no-controller-to-repository" ? { ...rule, ignoreDynamic: true } : rule));
    expect(run({ edges, contract: { rules: ignoring } }).outcome).toBe("pass");
  });

  test("direction backward and both", () => {
    const rule = (direction: "forward" | "backward" | "both") => [
      { id: "ui-data", kind: "forbidden" as const, severity: "error" as const, from: { layer: "controllers" }, to: { layer: "domain" }, direction, comment: "c" },
    ];
    const down: E[] = [["src/controllers/a.ts", "src/domain/b.ts"]];
    const up: E[] = [["src/domain/b.ts", "src/controllers/a.ts"]];
    expect(run({ edges: down, contract: { rules: rule("forward") } }).outcome).toBe("fail");
    expect(run({ edges: up, contract: { rules: rule("forward") } }).outcome).toBe("pass");
    expect(run({ edges: down, contract: { rules: rule("backward") } }).outcome).toBe("pass");
    expect(run({ edges: up, contract: { rules: rule("backward") } }).outcome).toBe("fail");
    expect(run({ edges: [...down, ...up], contract: { rules: rule("both") } }).diagnostics).toHaveLength(2);
  });

  test("warn and advisory rules report without blocking", () => {
    const soft = RULES.map((rule) => (rule.id === "no-controller-to-repository" ? { ...rule, severity: "warn" as const } : rule));
    const r = run({ edges: [...CLEAN, ["src/controllers/x.ts", "src/repositories/order.repository.ts"]], contract: { rules: soft } });
    expect(r.outcome).toBe("pass");
    expect(r.diagnostics[0]).toMatchObject({ severity: "warning", blocking: false });
    expect(r.counts).toMatchObject({ errors: 0, warnings: 1 });
  });

  test("disabled rules do not run", () => {
    const off = RULES.map((rule) => (rule.id === "no-controller-to-repository" ? { ...rule, enabled: false } : rule));
    expect(run({ edges: [...CLEAN, ["src/controllers/x.ts", "src/repositories/order.repository.ts"]], contract: { rules: off } }).outcome).toBe("pass");
  });

  test("external and core targets match only external refs", () => {
    const rules = [...RULES, { id: "no-orm-in-domain", kind: "forbidden" as const, severity: "error" as const, from: { layer: "domain" }, to: { external: "typeorm" }, comment: "No ORM." }];
    const r = run({ edges: [...CLEAN, ["src/domain/order.ts", "external:typeorm"], ["src/domain/order.ts", "external:lodash"]], contract: { rules } });
    expect(rulesOf(r)).toEqual(["no-orm-in-domain src/domain/order.ts"]);
    expect(r.diagnostics[0]?.suggest).toEqual({
      kind: "none",
      explanation: "Remove the dependency on external:typeorm from this file, or move the code that needs it to a layer that may use it.",
    });
  });
});

describe("routes", () => {
  test("several shortest routes are listed, never picked silently (domain -> repositories is banned)", () => {
    const layers = [...LAYERS, { id: "facade", globs: ["src/facade/**"] }];
    const r = run({ edges: [...CLEAN, ["src/controllers/x.ts", "src/repositories/order.repository.ts"]], contract: { layers } });
    expect(r.diagnostics[0]?.suggest).toEqual({
      kind: "none",
      explanation:
        "No unique legal layer route. Candidates: controllers -> facade -> repositories; controllers -> services -> repositories. See the rule comment.",
    });
  });

  test("an exclusive allowed rule narrows the layer graph", () => {
    const rules = [
      ...RULES,
      { id: "controllers-allowed", kind: "allowed" as const, severity: "error" as const, from: { layer: "controllers" }, to: { layers: ["services", "domain"] }, exclusive: true, comment: "Controllers call services." },
    ];
    const r = run({ edges: [...CLEAN, ["src/controllers/x.ts", "src/repositories/order.repository.ts"]], contract: { rules } });
    // Both the forbidden rule and the exclusive allow complement fire; both suggest the same unique route.
    expect(rulesOf(r)).toEqual(["controllers-allowed src/controllers/x.ts", "no-controller-to-repository src/controllers/x.ts"]);
    for (const d of r.diagnostics) expect(d.suggest.layers).toEqual(["controllers", "services", "repositories"]);
    const allowed = r.diagnostics.find((d) => d.ruleId === "controllers-allowed");
    expect(allowed?.why).toBe(
      "Layer 'controllers' may depend only on 'domain', 'services' (and its own layer). 'repositories' is not in that set. Rule 'controllers-allowed'. Controllers call services.",
    );
  });
});

describe("exclusive allowed and intra-layer", () => {
  const exclusive = [
    ...RULES,
    { id: "services-allowed", kind: "allowed" as const, severity: "error" as const, from: { layer: "services" }, to: { layers: ["repositories"] }, exclusive: true, comment: "Services use repositories." },
    { id: "services-domain", kind: "allowed" as const, severity: "error" as const, from: { layer: "services" }, to: { layer: "domain" }, comment: "And domain." },
  ];

  test("other allowed rules from the same layer extend the exclusive set", () => {
    expect(run({ edges: CLEAN, contract: { rules: exclusive } }).outcome).toBe("pass");
  });

  test("intra-layer is allowed by default and refused when intraAllowed is false", () => {
    const edges: E[] = [...CLEAN, ["src/services/a.service.ts", "src/services/order.service.ts"]];
    expect(run({ edges, contract: { rules: exclusive } }).outcome).toBe("pass");
    const layers = LAYERS.map((l) => (l.id === "services" ? { ...l, intraAllowed: false } : l));
    expect(rulesOf(run({ edges, contract: { rules: exclusive, layers } }))).toEqual(["services-allowed src/services/a.service.ts"]);
    expect(rulesOf(run({ edges, contract: { layers } }))).toEqual(["engintel.intra-layer src/services/a.service.ts"]);
  });

  test("unlayered and non-module targets are outside the exclusive set's reach", () => {
    const edges: E[] = [...CLEAN, ["src/services/order.service.ts", "src/util/x.ts"], ["src/services/order.service.ts", "external:lodash"]];
    const r = run({ edges, contract: { rules: exclusive } });
    expect(rulesOf(r)).toEqual(["engintel.unlayered src/util/x.ts"]);
    expect(r.outcome).toBe("pass");
  });
});

describe("cycles", () => {
  const cyclic: E[] = [...CLEAN, ["src/domain/discount.ts", "src/domain/pricing.ts"], ["src/domain/pricing.ts", "src/domain/discount.ts"]];

  test("one violation per elementary cycle, with the canonical signature", () => {
    const r = run({ edges: cyclic });
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({
      ruleId: "acyclic-domain",
      file: "src/domain/discount.ts",
      cycleSignature: "src/domain/discount.ts -> src/domain/pricing.ts",
      message: "Import cycle in layer 'domain': src/domain/discount.ts -> src/domain/pricing.ts -> src/domain/discount.ts.",
      suggest: { kind: "split-module" },
    });
  });

  test("changing any member brings the whole cycle into scope with the same identity", () => {
    const full = run({ edges: cyclic }).diagnostics[0]?.identity;
    const changed = run({ edges: cyclic, scope: { mode: "changed", changedFiles: ["src/domain/pricing.ts"], contractChanged: false } });
    expect(changed.diagnostics.map((d) => d.identity)).toEqual([full]);
    expect(run({ edges: cyclic, scope: { mode: "changed", changedFiles: ["src/domain/order.ts"], contractChanged: false } }).diagnostics).toEqual([]);
  });

  test("cycles outside `within` are not this rule's business", () => {
    const r = run({ edges: [...CLEAN, ["src/services/a.ts", "src/services/b.ts"], ["src/services/b.ts", "src/services/a.ts"]] });
    expect(r.outcome).toBe("pass");
  });
});

describe("unresolved and opaque imports", () => {
  const facts = {
    "src/services/export.service.ts": {
      imports: [
        { specifier: "../lib/csv-writer", kind: "import" as const, line: 1, column: 1 },
        { specifier: "../domain/order", kind: "dynamic" as const, line: 4, column: 24 },
        { specifier: null, kind: "dynamic" as const, line: 5, column: 45 },
      ],
      exports: [],
    },
  };
  const edges: E[] = [
    ...CLEAN,
    ["src/services/export.service.ts", "unresolved:src/lib/csv-writer", "import", "../lib/csv-writer"],
    ["src/services/export.service.ts", "src/domain/order.ts", "dynamic", "../domain/order"],
  ];

  test("an unresolved import fails its contract rule once; a non-literal import() is opaque; a literal import() is an edge", () => {
    const r = run({ edges, facts });
    expect(r.diagnostics.map((d) => [d.ruleId, d.range?.start.line, d.edge?.target])).toEqual([
      ["no-unresolved-in-src", 1, "unresolved:src/lib/csv-writer"],
      ["engintel.opaque-import", 5, "unresolved:*dynamic*"],
    ]);
    expect(r.outcome).toBe("fail");
  });

  test("opaqueImports: warn reports without blocking", () => {
    const r = run({ edges: CLEAN.concat([["src/services/export.service.ts", "src/domain/order.ts", "dynamic", "../domain/order"]]), facts, contract: { opaqueImports: "warn" } });
    expect(r.diagnostics.map((d) => [d.ruleId, d.severity, d.blocking])).toEqual([["engintel.opaque-import", "warning", false]]);
    expect(r.outcome).toBe("pass");
  });

  test("with no rule about unresolved imports, the built-in fails closed", () => {
    const rules = RULES.filter((rule) => rule.id !== "no-unresolved-in-src");
    const r = run({ edges, facts, contract: { rules } });
    expect(r.diagnostics.map((d) => d.ruleId)).toEqual(["engintel.unresolved-import", "engintel.opaque-import"]);
    expect(r.diagnostics[0]?.message).toBe(
      "Unresolved import: src/services/export.service.ts imports '../lib/csv-writer', which does not resolve to a file or an installed package.",
    );
  });

  test("externals.allowUnresolved tolerates listed specifiers for rules and the built-in", () => {
    const r = run({ edges, facts, contract: { externals: { allowUnresolved: ["../lib/*"] } } });
    expect(r.diagnostics.map((d) => d.ruleId)).toEqual(["engintel.opaque-import"]);
    const noRule = run({ edges, facts, contract: { externals: { allowUnresolved: ["../lib/*"] }, rules: RULES.filter((x) => x.id !== "no-unresolved-in-src") } });
    expect(noRule.diagnostics.map((d) => d.ruleId)).toEqual(["engintel.opaque-import"]);
  });
});

describe("fail closed on unanalyzable files (D-009)", () => {
  const files: SourceFileState[] = [
    { path: "src/services/corrupt.service.ts", unanalyzable: { reason: "binary", detail: "The file contains NUL bytes." } },
    { path: "src/services/truncated.service.ts", unanalyzable: { reason: "syntax-error", detail: "First syntax error: TS1005 at line 4, column 40." } },
    { path: "src/legacy/vendor-blob.ts", unanalyzable: { reason: "binary", detail: "The file contains NUL bytes." } },
  ];
  const unsupportedPaths = [{ glob: "src/legacy/vendor-blob.ts", reason: "Vendored binary blob; replacement tracked in PLAT-88.", owner: "@platform-api" }];

  test("full scope: every unanalyzable file blocks unless allowlisted", () => {
    const r = run({ edges: CLEAN, files, contract: { unsupportedPaths } });
    expect(rulesOf(r)).toEqual(["engintel.unanalyzable src/services/corrupt.service.ts", "engintel.unanalyzable src/services/truncated.service.ts"]);
    expect(r.outcome).toBe("fail");
    expect(r.counts.unanalyzable).toBe(2);
    expect(r.unanalyzable).toEqual([
      { path: "src/legacy/vendor-blob.ts", reason: "binary", inScope: true, allowlisted: true },
      { path: "src/services/corrupt.service.ts", reason: "binary", inScope: true, allowlisted: false },
      { path: "src/services/truncated.service.ts", reason: "syntax-error", inScope: true, allowlisted: false },
    ]);
    expect(r.diagnostics[0]).toMatchObject({ adapter: "analyzer", severity: "error", blocking: true, suggest: { kind: "none" } });
  });

  test("changed scope: only changed unanalyzable files block", () => {
    const scope = (changedFiles: string[]): Scope => ({ mode: "changed", changedFiles, contractChanged: false });
    expect(run({ edges: CLEAN, files, contract: { unsupportedPaths }, scope: scope(["src/domain/order.ts"]) }).outcome).toBe("pass");
    expect(run({ edges: CLEAN, files, contract: { unsupportedPaths }, scope: scope(["src/legacy/vendor-blob.ts"]) }).outcome).toBe("pass");
    expect(rulesOf(run({ edges: CLEAN, files, contract: { unsupportedPaths }, scope: scope(["src/services/truncated.service.ts"]) }))).toEqual([
      "engintel.unanalyzable src/services/truncated.service.ts",
    ]);
  });

  test("no exception can waive an unanalyzable file: built-in rule ids are not contract ids", () => {
    const bad = {
      id: "ex-unanalyzable",
      ruleId: "engintel.unanalyzable",
      source: "src/**",
      target: "*",
      reason: "Trying to waive the fail-closed rule entirely.",
      owner: "@x",
      addedAt: "2026-01-01",
      expiresAt: "2026-12-01",
    };
    expect(ArchitectureContractSchema.safeParse({ schemaVersion: 1, policyVersion: "1.0.0", status: "active", layers: LAYERS, rules: RULES, exceptions: [bad] }).success).toBe(false);
  });
});

describe("exceptions", () => {
  const exception = (expiresAt: string) => ({
    id: "ex-metrics",
    ruleId: "no-controller-to-repository",
    source: "src/controllers/metrics.controller.ts",
    target: "src/repositories/*.ts",
    reason: "Temporary shortcut until MetricsService lands.",
    owner: "@platform-api",
    addedAt: "2026-01-10",
    expiresAt,
  });
  const edges: E[] = [...CLEAN, ["src/controllers/metrics.controller.ts", "src/repositories/metrics.repository.ts"]];

  test("an active exception suppresses and is recorded", () => {
    const r = run({ edges, contract: { exceptions: [exception("2026-09-01")] }, now: "2026-09-01" });
    expect(r.outcome).toBe("pass");
    expect(r.exceptionsApplied).toEqual([
      {
        exceptionId: "ex-metrics",
        ruleId: "no-controller-to-repository",
        source: "src/controllers/metrics.controller.ts",
        target: "src/repositories/metrics.repository.ts",
        expiresAt: "2026-09-01",
      },
    ]);
    expect(r.counts.suppressedByException).toBe(1);
  });

  test("an expired exception stops applying and the message says so; identity is the rule's", () => {
    const expired = run({ edges, contract: { exceptions: [exception("2026-08-31")] }, now: "2026-09-01" });
    const none = run({ edges });
    expect(expired.outcome).toBe("fail");
    expect(expired.diagnostics[0]?.why).toContain("Exception 'ex-metrics' expired on 2026-08-31 and no longer applies.");
    expect(expired.diagnostics[0]?.identity).toBe(none.diagnostics[0]?.identity);
  });

  test("target '*' matches any target", () => {
    const r = run({ edges, contract: { exceptions: [{ ...exception("2027-01-01"), target: "*" }] } });
    expect(r.outcome).toBe("pass");
  });
});

describe("layers", () => {
  test("a file in two layers is a blocking contract error, not a specificity contest", () => {
    const layers = [...LAYERS, { id: "shared", globs: ["src/services/shared/**"] }];
    const r = run({ edges: [...CLEAN, ["src/services/shared/x.ts", "src/domain/order.ts"]], contract: { layers } });
    expect(rulesOf(r)).toEqual(["engintel.overlapping-layers src/services/shared/x.ts"]);
    expect(r.diagnostics[0]?.message).toBe("src/services/shared/x.ts matches more than one layer: 'services', 'shared'.");
    expect(r.outcome).toBe("fail");
    const excluded = LAYERS.map((l) => (l.id === "services" ? { ...l, excludeGlobs: ["src/services/shared/**"] } : l));
    expect(run({ edges: [...CLEAN, ["src/services/shared/x.ts", "src/domain/order.ts"]], contract: { layers: [...excluded, { id: "shared", globs: ["src/services/shared/**"] }] } }).outcome).toBe("pass");
  });

  test("unlayered files are advisory by default and follow contract.unlayered", () => {
    const edges: E[] = [...CLEAN, ["src/util/x.ts", "src/domain/order.ts"]];
    expect(run({ edges }).diagnostics[0]).toMatchObject({ ruleId: "engintel.unlayered", severity: "advisory", blocking: false });
    expect(run({ edges, contract: { unlayered: { severity: "error" } } }).outcome).toBe("fail");
  });
});

describe("required and reachable", () => {
  test("required: a service without a repository dependency", () => {
    const rules = [...RULES, { id: "services-use-repositories", kind: "required" as const, severity: "error" as const, from: { layer: "services" }, to: { layer: "repositories" }, comment: "Services own persistence calls." }];
    const r = run({ edges: [...CLEAN, ["src/services/pure.service.ts", "src/domain/order.ts"]], contract: { rules } });
    expect(rulesOf(r)).toEqual(["services-use-repositories src/services/pure.service.ts"]);
    expect(r.diagnostics[0]?.suggest).toEqual({ kind: "use-layer", explanation: "Depend on layer 'repositories' from this file.", layers: ["services", "repositories"] });
  });

  test("reachable: a repository no controller reaches", () => {
    const rules = [...RULES, { id: "repos-reachable", kind: "reachable" as const, severity: "warn" as const, from: { layer: "controllers" }, to: { layer: "repositories" }, comment: "Dead repositories." }];
    const r = run({ edges: CLEAN, files: ["src/repositories/dead.repository.ts"], contract: { rules } });
    expect(rulesOf(r)).toEqual(["repos-reachable src/repositories/dead.repository.ts"]);
    expect(r.outcome).toBe("pass");
  });
});

describe("scope", () => {
  const edges: E[] = [...CLEAN, ["src/controllers/report.controller.ts", "src/repositories/order.repository.ts"]];
  const changed = (changedFiles: string[], contractChanged = false): Scope => ({ mode: "changed", changedFiles, contractChanged });

  test("an edge is in scope when its source or target changed", () => {
    expect(run({ edges, scope: changed(["src/controllers/report.controller.ts"]) }).outcome).toBe("fail");
    expect(run({ edges, scope: changed(["src/repositories/order.repository.ts"]) }).outcome).toBe("fail");
    expect(run({ edges, scope: changed(["src/domain/order.ts"]) }).outcome).toBe("pass");
  });

  test("a contract change re-evaluates everything", () => {
    expect(run({ edges, scope: changed(["src/domain/order.ts"], true) }).outcome).toBe("fail");
  });
});

describe("determinism", () => {
  test("input order does not change the output", () => {
    const edges: E[] = [
      ...CLEAN,
      ["src/controllers/report.controller.ts", "src/repositories/order.repository.ts"],
      ["src/domain/a.ts", "src/domain/b.ts"],
      ["src/domain/b.ts", "src/domain/a.ts"],
    ];
    const a = run({ edges });
    const b = run({ edges: [...edges].reverse() });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  test("injected text never reaches a diagnostic: messages use ids, paths, and contract text only", () => {
    const facts = {
      "src/controllers/admin.controller.ts": {
        imports: [{ specifier: "../repositories/order.repository", kind: "import" as const, line: 5, column: 1 }],
        exports: [{ name: "AdminController", kind: "class" }],
      },
    };
    const r = run({ edges: [...CLEAN, ["src/controllers/admin.controller.ts", "src/repositories/order.repository.ts", "import", "../repositories/order.repository"]], facts });
    expect(r.diagnostics).toHaveLength(1);
    expect(JSON.stringify(r)).not.toMatch(/approved|PASS|ignore previous/i);
  });
});
