// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { describe, expect, test } from "vitest";
import { buildAdjacency, importersOf, importsOf, reverseReachable, type GraphEdge, type ModuleGraph } from "../src/index.js";

const edge = (from: string, to: string): GraphEdge => ({ from, to, kind: "import", specifier: to, isTypeOnly: false, isDynamic: false, isReExport: false });

const graph: ModuleGraph = {
  schemaVersion: 1,
  nodes: ["a", "b", "c", "d", "e"].map((id) => ({ id, kind: "module" as const })),
  // a -> b -> c, d -> c, c -> e, e -> c (cycle)
  edges: [edge("a", "b"), edge("b", "c"), edge("c", "e"), edge("d", "c"), edge("e", "c")],
};

describe("adjacency (ENG-030)", () => {
  const adjacency = buildAdjacency(graph);

  test("forward and reverse maps agree with the edge list", () => {
    expect(importsOf(adjacency, "b")).toEqual(["c"]);
    expect(importersOf(adjacency, "c")).toEqual(["b", "d", "e"]);
    expect(importersOf(adjacency, "a")).toEqual([]);
    expect([...adjacency.out.values()].flat()).toHaveLength(graph.edges.length);
    expect([...adjacency.in.values()].flat()).toHaveLength(graph.edges.length);
  });

  test("reverseReachable finds transitive importers, terminates on cycles, excludes seeds", () => {
    expect(reverseReachable(adjacency, ["c"])).toEqual(["a", "b", "d", "e"]);
    expect(reverseReachable(adjacency, ["b"])).toEqual(["a"]);
    expect(reverseReachable(adjacency, ["a"])).toEqual([]);
    expect(reverseReachable(adjacency, ["b", "a"])).toEqual([]);
  });
});
