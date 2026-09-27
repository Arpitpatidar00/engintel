// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { goldenRoot } from "@engintel/testkit";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  buildModuleGraph,
  canonicalRotation,
  cycleSignature,
  cyclicComponents,
  findCycles,
  type GraphEdge,
  type ModuleGraph,
} from "../src/index.js";

const edge = (from: string, to: string, kind: GraphEdge["kind"] = "import"): GraphEdge => ({
  from,
  to,
  kind,
  specifier: to,
  isTypeOnly: kind === "type-only",
  isDynamic: false,
  isReExport: false,
});

function graphOf(pairs: readonly (readonly [string, string])[], extra: GraphEdge[] = []): ModuleGraph {
  const edges = [...pairs.map(([a, b]) => edge(a, b)), ...extra];
  const ids = [...new Set(edges.flatMap((e) => [e.from, e.to]))].sort();
  return { schemaVersion: 1, nodes: ids.map((id) => ({ id, kind: "module" })), edges };
}

const signatures = (g: ModuleGraph, options = {}) => findCycles(g, options).map((c) => c.signature);

describe("canonical rotation", () => {
  test("smallest id first, order preserved", () => {
    expect(canonicalRotation(["c", "a", "b"])).toEqual(["a", "b", "c"]);
    expect(canonicalRotation(["b", "c", "a"])).toEqual(["a", "b", "c"]);
    expect(cycleSignature(["src/domain/pricing.ts", "src/domain/discount.ts"])).toBe("src/domain/discount.ts -> src/domain/pricing.ts");
  });

  test("a repeated smallest id picks the smallest rotation", () => {
    expect(canonicalRotation(["a", "c", "a", "b"])).toEqual(["a", "b", "a", "c"]);
  });

  test("property: every rotation of a ring has the same signature", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.stringMatching(/^[a-z]{1,3}(\/[a-z]{1,3}){0,2}\.ts$/), { minLength: 1, maxLength: 8 }), fc.nat(), (ring, k) => {
        const i = k % ring.length;
        const rotated = [...ring.slice(i), ...ring.slice(0, i)];
        expect(cycleSignature(rotated)).toBe(cycleSignature(ring));
        const canonical = canonicalRotation(ring);
        expect(canonical[0]).toBe([...ring].sort()[0]);
        expect([...canonical].sort()).toEqual([...ring].sort());
      }),
    );
  });

  test("property: the same cycle drawn from any start node yields one identical cycle", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.stringMatching(/^[a-z]{1,4}$/), { minLength: 2, maxLength: 7 }), fc.nat(), (ring, k) => {
        const i = k % ring.length;
        const rotated = [...ring.slice(i), ...ring.slice(0, i)];
        const pairs = rotated.map((id, j) => [id, rotated[(j + 1) % rotated.length] as string] as const);
        const cycles = findCycles(graphOf(pairs));
        expect(cycles).toHaveLength(1);
        expect(cycles[0]?.signature).toBe(cycleSignature(ring));
      }),
    );
  });
});

describe("findCycles", () => {
  test("acyclic graphs have no cycles", () => {
    expect(findCycles(graphOf([["a", "b"], ["b", "c"], ["a", "c"]]))).toEqual([]);
  });

  test("a self-import is a cycle of one", () => {
    expect(findCycles(graphOf([["a", "a"]]))).toEqual([{ nodes: ["a"], signature: "a", exact: true }]);
  });

  test("overlapping cycles are distinct: A->B->A is not A->B->C->A", () => {
    const g = graphOf([["a", "b"], ["b", "a"], ["b", "c"], ["c", "a"]]);
    expect(signatures(g)).toEqual(["a -> b", "a -> b -> c"]);
  });

  test("every elementary cycle of a complete graph on 4 nodes (20 cycles)", () => {
    const ids = ["a", "b", "c", "d"];
    const g = graphOf(ids.flatMap((x) => ids.filter((y) => y !== x).map((y) => [x, y] as const)));
    const found = findCycles(g);
    // 6 two-cycles + 8 three-cycles + 6 four-cycles
    expect(found).toHaveLength(20);
    expect(new Set(found.map((c) => c.signature)).size).toBe(20);
    for (const c of found) expect(c.nodes[0]).toBe([...c.nodes].sort()[0]);
  });

  test("include restricts to the induced subgraph", () => {
    const g = graphOf([["d/a", "d/b"], ["d/b", "x/c"], ["x/c", "d/a"], ["d/b", "d/a"]]);
    expect(signatures(g)).toEqual(["d/a -> d/b", "d/a -> d/b -> x/c"]);
    expect(signatures(g, { include: (id: string) => id.startsWith("d/") })).toEqual(["d/a -> d/b"]);
  });

  test("edgeFilter can drop type-only edges", () => {
    const g = graphOf([["a", "b"]], [edge("b", "a", "type-only")]);
    expect(signatures(g)).toEqual(["a -> b"]);
    expect(signatures(g, { edgeFilter: (e: GraphEdge) => !e.isTypeOnly })).toEqual([]);
  });

  test("a component over the cycle cap is one coarse cycle over its sorted node set", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const g = graphOf(ids.flatMap((x) => ids.filter((y) => y !== x).map((y) => [x, y] as const)));
    expect(findCycles(g, { maxCyclesPerComponent: 10 })).toEqual([{ nodes: ids, signature: "{a, b, c, d, e}", exact: false }]);
    expect(findCycles(g, { maxComponentSize: 4 })).toEqual([{ nodes: ids, signature: "{a, b, c, d, e}", exact: false }]);
  });

  test("a 50 000-node chain closing on itself does not overflow the stack in Tarjan", () => {
    const n = 50_000;
    const ids = Array.from({ length: n }, (_, i) => `m${String(i).padStart(6, "0")}`);
    const g = graphOf(ids.map((id, i) => [id, ids[(i + 1) % n] as string] as const));
    expect(cyclicComponents(g)).toEqual([ids]);
    expect(findCycles(g, { maxComponentSize: 2_000 })[0]?.exact).toBe(false);
  });

  test("output is independent of edge order", () => {
    const pairs: [string, string][] = [["a", "b"], ["b", "c"], ["c", "a"], ["c", "b"], ["b", "d"], ["d", "a"]];
    const forward = findCycles(graphOf(pairs));
    const backward = findCycles(graphOf([...pairs].reverse()));
    expect(backward).toEqual(forward);
  });
});

describe("golden: circular", () => {
  test("one cycle, canonical signature pinned", async () => {
    const root = join(goldenRoot(), "circular", "repo");
    const list = (dir: string): string[] =>
      readdirSync(join(root, dir)).flatMap((n) => (statSync(join(root, dir, n)).isDirectory() ? list(`${dir}/${n}`) : [`${dir}/${n}`]));
    const g = await buildModuleGraph({ root, files: list("src") });
    expect(findCycles(g)).toEqual([
      { nodes: ["src/domain/discount.ts", "src/domain/pricing.ts"], signature: "src/domain/discount.ts -> src/domain/pricing.ts", exact: true },
    ]);
  });
});
