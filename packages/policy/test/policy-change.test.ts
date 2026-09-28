// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { ArchitectureContractSchema, parseBaseline, parseConfig, type ArchitectureContractInput } from "@engintel/config";
import { describe, expect, test } from "vitest";
import {
  classifyBaselineChange,
  classifyConfigChange,
  classifyContractChange,
  classifyIgnoreChange,
  policyChangeViolations,
  toDiagnostic,
  type PolicyChangeItem,
} from "../src/index.js";

const FILE = ".engintel/architecture.json";

const BASE: ArchitectureContractInput = {
  schemaVersion: 1,
  policyVersion: "1.0.0",
  status: "active",
  layers: [
    { id: "controllers", globs: ["src/controllers/**"] },
    { id: "services", globs: ["src/services/**"] },
    { id: "repositories", globs: ["src/repositories/**"] },
  ],
  rules: [
    { id: "no-skip", kind: "forbidden", severity: "error", from: { layer: "controllers" }, to: { layer: "repositories" }, comment: "Use a service." },
    { id: "acyclic", kind: "acyclic", severity: "error", within: { glob: "src/**" }, comment: "No cycles." },
    { id: "svc-allowed", kind: "allowed", severity: "error", from: { layer: "services" }, to: { layer: "repositories" }, comment: "ok" },
  ],
  exceptions: [
    {
      id: "ex-health",
      ruleId: "no-skip",
      source: "src/controllers/health.ts",
      target: "*",
      reason: "Liveness reads the database directly on purpose.",
      owner: "@platform",
      addedAt: "2026-01-01",
      expiresAt: "2026-06-01",
    },
  ],
  unsupportedPaths: [{ glob: "src/legacy/blob.ts", reason: "Vendored binary, replacement tracked.", owner: "@platform" }],
  externals: { allowUnresolved: ["virtual:*"] },
  opaqueImports: "error",
};

const parse = (c: ArchitectureContractInput) => ArchitectureContractSchema.parse(c);
const base = parse(BASE);

function diff(edit: (c: ArchitectureContractInput) => ArchitectureContractInput): [string, string][] {
  return classifyContractChange(FILE, base, parse(edit(structuredClone(BASE)))).map((i) => [i.class, i.summary]);
}
const rule = (c: ArchitectureContractInput, id: string) => c.rules.find((r) => r.id === id) as Record<string, unknown>;

describe("classifyContractChange (ENG-012)", () => {
  test("no change, no items", () => {
    expect(classifyContractChange(FILE, base, parse(BASE))).toEqual([]);
  });

  test.each<[string, (c: ArchitectureContractInput) => ArchitectureContractInput, string, string]>([
    ["removing a forbidden rule", (c) => ({ ...c, rules: c.rules.filter((r) => r.id !== "no-skip"), exceptions: [] }), "weakening", "rule 'no-skip' (forbidden) removed"],
    ["removing an acyclic rule", (c) => ({ ...c, rules: c.rules.filter((r) => r.id !== "acyclic") }), "weakening", "rule 'acyclic' (acyclic) removed"],
    ["removing a non-exclusive allowed rule", (c) => ({ ...c, rules: c.rules.filter((r) => r.id !== "svc-allowed") }), "tightening", "rule 'svc-allowed' (allowed) removed"],
    ["adding a forbidden rule", (c) => ({ ...c, rules: [...c.rules, { id: "new-ban", kind: "forbidden", severity: "error", from: { layer: "services" }, to: { layer: "controllers" }, comment: "x" }] }), "tightening", "rule 'new-ban' (forbidden) added"],
    ["adding an allowed rule", (c) => ({ ...c, rules: [...c.rules, { id: "new-allow", kind: "allowed", severity: "error", from: { layer: "controllers" }, to: { layer: "repositories" }, comment: "x" }] }), "weakening", "rule 'new-allow' (allowed) added"],
    ["disabling a rule", (c) => (rule(c, "no-skip")["enabled"] = false, c), "weakening", "rule 'no-skip': disabled"],
    ["lowering severity", (c) => (rule(c, "no-skip")["severity"] = "warn", c), "weakening", "rule 'no-skip': severity error -> warn"],
    ["ignoring type-only imports", (c) => (rule(c, "no-skip")["ignoreTypeOnly"] = true, c), "weakening", "rule 'no-skip': ignoreTypeOnly false -> true"],
    ["narrowing direction", (c) => (rule(c, "no-skip")["direction"] = "backward", c), "weakening", "rule 'no-skip': direction forward -> backward"],
    ["widening direction", (c) => (rule(c, "no-skip")["direction"] = "both", c), "tightening", "rule 'no-skip': direction forward -> both"],
    ["editing a rule's target", (c) => (rule(c, "no-skip")["to"] = { layer: "services" }, c), "weakening", 'rule \'no-skip\': to changed from {"layer":"repositories"} to {"layer":"services"}'],
    ["editing a comment", (c) => (rule(c, "no-skip")["comment"] = "Please use a service.", c), "neutral", "rule 'no-skip': comment edited"],
    ["setting status to draft", (c) => ({ ...c, status: "draft" }), "weakening", "status active -> draft (the contract is no longer enforced)"],
    ["removing a layer", (c) => ({ ...c, layers: c.layers.filter((l) => l.id !== "services"), rules: c.rules.filter((r) => r.id !== "svc-allowed") }), "weakening", "layer 'services' removed"],
    ["narrowing a layer's globs", (c) => (c.layers[0] = { ...c.layers[0], excludeGlobs: ["src/controllers/legacy/**"] } as never, c), "weakening", "layer 'controllers': globs changed, so different files are governed by its rules"],
    ["allowing intra-layer imports", (c) => (c.layers[0] = { ...c.layers[0], intraAllowed: false } as never, c), "tightening", "layer 'controllers': intraAllowed true -> false"],
    ["adding an exception", (c) => ({ ...c, exceptions: [...(c.exceptions ?? []), { ...(c.exceptions ?? [])[0], id: "ex-new" } as never] }), "weakening", "exception 'ex-new' added for rule 'no-skip' (src/controllers/health.ts -> *, until 2026-06-01)"],
    ["extending an exception", (c) => (((c.exceptions ?? [])[0] as Record<string, unknown>)["expiresAt"] = "2036-06-01", c), "weakening", "exception 'ex-health' extended from 2026-06-01 to 2036-06-01"],
    ["shortening an exception", (c) => (((c.exceptions ?? [])[0] as Record<string, unknown>)["expiresAt"] = "2026-02-01", c), "tightening", "exception 'ex-health' shortened to 2026-02-01"],
    ["removing an exception", (c) => ({ ...c, exceptions: [] }), "tightening", "exception 'ex-health' removed"],
    ["allowlisting an unreadable path", (c) => ({ ...c, unsupportedPaths: [...(c.unsupportedPaths ?? []), { glob: "src/**", reason: "Everything is fine, trust me here.", owner: "@x" }] }), "weakening", "unsupportedPaths allowlists 'src/**'"],
    ["tolerating an unresolved specifier", (c) => ({ ...c, externals: { allowUnresolved: ["virtual:*", "*"] } }), "weakening", "externals.allowUnresolved tolerates '*'"],
    ["relaxing opaque imports", (c) => ({ ...c, opaqueImports: "warn" }), "weakening", "opaqueImports error -> warn"],
    ["enforcing unlayered files", (c) => ({ ...c, unlayered: { severity: "error" } }), "tightening", "unlayered severity advisory -> error"],
  ])("%s", (_, edit, cls, summary) => {
    expect(diff(edit)).toContainEqual([cls, summary]);
  });

  test("raising severity is a tightening", () => {
    const softer = structuredClone(BASE);
    rule(softer, "no-skip")["severity"] = "warn";
    expect(classifyContractChange(FILE, parse(softer), base).map((i) => [i.class, i.summary])).toEqual([["tightening", "rule 'no-skip': severity warn -> error"]]);
  });

  test("a new contract is a tightening when active", () => {
    expect(classifyContractChange(FILE, null, base)).toEqual([{ file: FILE, class: "tightening", subject: "contract", summary: "contract added (status active)" }]);
  });
});

describe("config, ignore, and baseline changes", () => {
  const cfg = (doc: Record<string, unknown>) => parseConfig({ schemaVersion: 1, ...doc }).config;

  test("config: include, exclude, and tsconfig changes that can hide files are weakenings", () => {
    const items = classifyConfigChange(".engintel/config.json", cfg({ exclude: ["a/**"] }), cfg({ include: ["src/**"], exclude: ["src/controllers/**"], tsconfig: "tsconfig.alt.json" }));
    expect(items.map((i) => [i.class, i.summary])).toEqual([
      ["weakening", "include changed, so a different set of files is analyzed"],
      ["weakening", "exclude skips 'src/controllers/**'"],
      ["tightening", "exclude no longer skips 'a/**'"],
      ["weakening", "tsconfig (default) -> tsconfig.alt.json changes how imports resolve"],
    ]);
  });

  test("ignore: added patterns are weakenings, comments do not count", () => {
    expect(classifyIgnoreChange(".engintel/ignore", "# generated\ngen/\n", "# generated, and more\ngen/\nsrc/controllers/\n").map((i) => [i.class, i.summary])).toEqual([
      ["weakening", "ignores 'src/controllers/'"],
    ]);
  });

  test("baseline: growth is a weakening, dropping live debt is an error, dropping fixed debt is a tightening", () => {
    const entry = (identity: string) => ({ identity, ruleId: "r", source: "src/a.ts", target: "src/b.ts", cycleSignature: null, firstSeenAt: "2026-01-01", lastSeenAt: "2026-01-01" });
    const file = (...ids: string[]) =>
      parseBaseline({ schemaVersion: 1, engineIdentityVersion: 1, policyVersionAtWrite: "1.0.0", writtenAt: "2026-01-01", writtenBy: "alice", entries: ids.map(entry) }).baseline;
    const [a, b, c] = ["a", "b", "c"].map((x) => x.repeat(64)) as [string, string, string];
    const change = classifyBaselineChange(".engintel/baseline.json", file(a, b), file(a, c), new Set([a, b, c]));
    expect(change.items.map((i) => i.class)).toEqual(["weakening"]);
    expect(change.dropped.map((e) => e.identity)).toEqual([b]);
    const pruned = classifyBaselineChange(".engintel/baseline.json", file(a, b), file(a), new Set([a]));
    expect(pruned).toEqual({ items: [expect.objectContaining({ class: "tightening" })], dropped: [] });
  });
});

describe("policyChangeViolations", () => {
  const items: PolicyChangeItem[] = [
    { file: FILE, class: "weakening", subject: "rule:no-skip", summary: "rule 'no-skip' (forbidden) removed" },
    { file: FILE, class: "weakening", subject: "exception:ex-new", summary: "exception 'ex-new' added" },
    { file: FILE, class: "tightening", subject: "rule:new-ban", summary: "rule 'new-ban' (forbidden) added" },
    { file: FILE, class: "neutral", subject: "metadata", summary: "policyVersion or description edited" },
  ];

  test("weakenings block unless approved; tightenings are advisory; neutral edits are not diagnostics", () => {
    const blocking = policyChangeViolations(items, () => false).map(toDiagnostic);
    expect(blocking.map((d) => [d.ruleId, d.severity, d.blocking])).toEqual([
      ["engintel.policy-weakening", "error", true],
      ["engintel.policy-weakening", "error", true],
      ["engintel.policy-change", "advisory", false],
    ]);
    expect(blocking[0]?.message).toBe("Policy weakening in .engintel/architecture.json: rule 'no-skip' (forbidden) removed.");
    expect(blocking[0]?.why).toContain("'policy-change' label");
    expect(new Set(blocking.map((d) => d.identity)).size).toBe(3);
    const approved = policyChangeViolations(items, () => true).map(toDiagnostic);
    expect(approved.filter((d) => d.blocking)).toEqual([]);
    expect(approved[0]?.severity).toBe("warning");
  });
});
