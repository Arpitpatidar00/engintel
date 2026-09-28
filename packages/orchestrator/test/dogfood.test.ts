// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { loadContract } from "@engintel/config";
import type { GraphEdge, ModuleGraph } from "@engintel/graph";
import { evaluate } from "@engintel/policy";
import { findWorkspaceRoot } from "@engintel/testkit";
import { describe, expect, test } from "vitest";
import { validateRepository } from "../src/index.js";

/**
 * EngIntel's own draft contract (.engintel/architecture.json). The draft is
 * not enforced by `engintel validate`; this test previews it so the codebase
 * keeps conforming until the owners review it and set it active.
 */

const root = findWorkspaceRoot();

describe("dogfood: EngIntel's own contract", () => {
  test("the repository conforms to its draft contract", async () => {
    const report = await validateRepository({ root, now: "2026-09-28", allowDraft: true });
    expect(report.contract.status).toBe("draft");
    expect(report.diagnostics.map((d) => `${d.ruleId} ${d.file ?? ""}: ${d.message}`)).toEqual([]);
    expect(report.outcome).toBe("pass");
    expect(report.stats.files).toBeGreaterThan(50);
  });

  test("the rules bite: each forbidden dependency fails", () => {
    const { contract } = loadContract(root);
    const edge = (from: string, to: string): GraphEdge => ({ from, to, kind: "import", specifier: to, isTypeOnly: false, isDynamic: false, isReExport: false });
    const check = (from: string, to: string) => {
      const graph: ModuleGraph = { schemaVersion: 1, nodes: [], edges: [edge(from, to)] };
      const files = [from, to].filter((p) => p.startsWith("packages/")).map((path) => ({ path, unanalyzable: null }));
      return evaluate({ contract, graph, files, facts: new Map(), scope: { mode: "full" }, now: "2026-09-28" }).diagnostics.map((d) => d.ruleId);
    };
    expect(check("packages/config/src/a.ts", "packages/graph/src/index.ts")).toEqual(["foundation-is-a-leaf"]);
    expect(check("packages/graph/src/a.ts", "packages/policy/src/index.ts")).toEqual(["readers-and-graph-below-policy"]);
    expect(check("packages/policy/src/a.ts", "packages/scanner/src/index.ts")).toEqual(["policy-is-pure"]);
    expect(check("packages/orchestrator/src/a.ts", "packages/cli/src/index.ts")).toEqual(["orchestrator-below-surfaces"]);
    expect(check("packages/mcp/src/a.ts", "packages/action/src/index.ts")).toEqual(["action-and-mcp-stay-apart"]);
    expect(check("packages/cli/src/a.ts", "packages/testkit/src/index.ts")).toEqual(["no-testkit-in-production"]);
    expect(check("packages/policy/src/a.ts", "external:dependency-cruiser")).toEqual(["dependency-cruiser-only-in-graph"]);
    expect(check("packages/policy/src/a.ts", "external:commander")).toEqual(["commander-only-in-surfaces"]);
    expect(check("packages/cli/src/a.ts", "external:@anthropic-ai/sdk")).toEqual(["no-llm-sdks"]);
    expect(check("packages/cli/test/a.test.ts", "external:openai")).toEqual(["no-llm-sdks"]);
    expect(check("packages/cli/src/a.ts", "unresolved:left-pad")).toEqual(["imports-resolve"]);
    // Allowed directions stay allowed.
    expect(check("packages/cli/src/a.ts", "packages/orchestrator/src/index.ts")).toEqual([]);
    expect(check("packages/graph/src/a.ts", "external:dependency-cruiser")).toEqual([]);
    expect(check("packages/policy/src/a.ts", "packages/graph/src/index.ts")).toEqual([]);
  });
});
