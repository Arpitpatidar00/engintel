// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import type { EdgeKind } from "@engintel/config";

/**
 * EngIntel's module graph (research doc 05, section 5). This is the adapter
 * boundary: dependency-cruiser's JSON never leaves this package, so the
 * extractor can be replaced without touching the validator.
 *
 * Node ids:
 *   <repo path>              a local module, e.g. "src/services/order.service.ts"
 *   external:<package>       an npm package (subpaths collapsed: lodash/get -> lodash),
 *                            or a resolved file outside the repository root
 *   core:<name>              a Node.js builtin ("node:fs" and "fs" -> core:fs)
 *   unresolved:<specifier>   a specifier that could not be resolved; relative
 *                            specifiers are normalized against the importer, and
 *                            implausible ones become *invalid-specifier:<digest>*
 */

export type NodeKind = "module" | "external" | "core" | "unresolved";

export interface GraphNode {
  readonly id: string;
  readonly kind: NodeKind;
}

export interface GraphEdge {
  /** Always a local module id. */
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  /** The specifier as written in the source, or a digest placeholder when it is implausible (see safeSpecifier). */
  readonly specifier: string;
  readonly isTypeOnly: boolean;
  readonly isDynamic: boolean;
  readonly isReExport: boolean;
}

export const GRAPH_SCHEMA_VERSION = 1;

export interface ModuleGraph {
  readonly schemaVersion: typeof GRAPH_SCHEMA_VERSION;
  /** Sorted by id. */
  readonly nodes: readonly GraphNode[];
  /** Sorted by (from, to, kind, specifier); no duplicates. */
  readonly edges: readonly GraphEdge[];
}

export interface Adjacency {
  /** from -> outgoing edges, in graph order. */
  readonly out: ReadonlyMap<string, readonly GraphEdge[]>;
  /** to -> incoming edges, in graph order. */
  readonly in: ReadonlyMap<string, readonly GraphEdge[]>;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function compareEdges(a: GraphEdge, b: GraphEdge): number {
  return compare(a.from, b.from) || compare(a.to, b.to) || compare(a.kind, b.kind) || compare(a.specifier, b.specifier);
}

/** Forward and reverse adjacency, rebuilt from the edge list (research doc 05, section 5.1). */
export function buildAdjacency(graph: ModuleGraph): Adjacency {
  const out = new Map<string, GraphEdge[]>();
  const inn = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    let outgoing = out.get(edge.from);
    if (!outgoing) out.set(edge.from, (outgoing = []));
    outgoing.push(edge);
    let incoming = inn.get(edge.to);
    if (!incoming) inn.set(edge.to, (incoming = []));
    incoming.push(edge);
  }
  return { out, in: inn };
}

/** Modules that import `id` directly, sorted. */
export function importersOf(adjacency: Adjacency, id: string): string[] {
  return [...new Set((adjacency.in.get(id) ?? []).map((e) => e.from))].sort(compare);
}

/** Nodes `id` imports directly, sorted. */
export function importsOf(adjacency: Adjacency, id: string): string[] {
  return [...new Set((adjacency.out.get(id) ?? []).map((e) => e.to))].sort(compare);
}

/** Everything that transitively imports any of `ids` (reverse BFS), excluding the seeds, sorted. */
export function reverseReachable(adjacency: Adjacency, ids: readonly string[]): string[] {
  const seen = new Set(ids);
  const queue = [...ids];
  const found: string[] = [];
  for (let i = 0; i < queue.length; i++) {
    for (const edge of adjacency.in.get(queue[i] as string) ?? []) {
      if (seen.has(edge.from)) continue;
      seen.add(edge.from);
      found.push(edge.from);
      queue.push(edge.from);
    }
  }
  return found.sort(compare);
}

/** Canonical, byte-stable JSON (for .engintel/cache/graph.json and golden comparison). */
export function serializeGraph(graph: ModuleGraph): string {
  return `${JSON.stringify(graph, null, 2)}\n`;
}
