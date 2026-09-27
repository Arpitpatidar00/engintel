// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import type { GraphEdge, ModuleGraph } from "./model.js";

/**
 * Cycle detection and cycle signatures (ENG-031; research doc 05, section 6.3).
 *
 * Cycles are enumerated, not just flagged, because every cycle violation's
 * identity includes its signature (doc 08, section 3.2, LOCKED). Two different
 * cycles over overlapping files are two different debts.
 *
 * Algorithm: Tarjan's strongly connected components, then Johnson's
 * elementary-circuit search inside each component. Starting each search from
 * the component's nodes in sorted order means every cycle is found already in
 * canonical rotation, exactly once. Enumeration can be exponential, so a
 * component that is too large, or that yields too many cycles, is reported as
 * one coarse cycle over its sorted node set instead (never silently dropped).
 */

export interface Cycle {
  /**
   * Exact cycles: canonical rotation (lexicographically smallest id first), in
   * import order; each node imports the next and the last imports the first.
   * Coarse cycles: the component's node set, sorted.
   */
  readonly nodes: readonly string[];
  /** Exact: `nodes.join(" -> ")`. Coarse: `"{" + nodes.join(", ") + "}"`, so the two can never collide. */
  readonly signature: string;
  /** False when the component was too large to enumerate (diagnostic `engintel.graph.cycle-approx`). */
  readonly exact: boolean;
}

export interface CycleOptions {
  /** Restrict to the subgraph induced by these nodes (an acyclic rule's `within`). Default: every node. */
  readonly include?: (id: string) => boolean;
  /** Edges to consider (e.g. skip type-only). Default: every edge. */
  readonly edgeFilter?: (edge: GraphEdge) => boolean;
  /** Components with more nodes than this are reported coarsely. Default 2 000 (doc 05). */
  readonly maxComponentSize?: number;
  /** A component that yields more cycles than this is reported coarsely. Default 1 000. */
  readonly maxCyclesPerComponent?: number;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function compareSequences(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = compare(a[i] as string, b[i] as string);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/**
 * Rotate a ring so the smallest id comes first. If the smallest id repeats
 * (never in an elementary cycle), the smallest rotation wins.
 */
export function canonicalRotation(ring: readonly string[]): string[] {
  let best: string[] = [...ring];
  for (let i = 1; i < ring.length; i++) {
    const rotated = [...ring.slice(i), ...ring.slice(0, i)];
    if (compareSequences(rotated, best) < 0) best = rotated;
  }
  return best;
}

/** The identity-bearing signature of an elementary cycle, in any rotation. */
export function cycleSignature(ring: readonly string[]): string {
  return canonicalRotation(ring).join(" -> ");
}

/** Sorted, deduplicated successor lists of the filtered subgraph. */
function successors(graph: ModuleGraph, options: CycleOptions): Map<string, string[]> {
  const include = options.include ?? (() => true);
  const edgeFilter = options.edgeFilter ?? (() => true);
  const out = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (!edgeFilter(edge) || !include(edge.from) || !include(edge.to)) continue;
    let next = out.get(edge.from);
    if (!next) out.set(edge.from, (next = new Set()));
    next.add(edge.to);
  }
  return new Map([...out].map(([id, next]) => [id, [...next].sort(compare)]));
}

/**
 * Tarjan's algorithm, iterative so deep import chains cannot overflow the
 * stack. Returns components that contain a cycle (size > 1, or a self-import),
 * each sorted, in order of their smallest id.
 */
export function cyclicComponents(graph: ModuleGraph, options: CycleOptions = {}): string[][] {
  const next = successors(graph, options);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const start of [...next.keys()].sort(compare)) {
    if (index.has(start)) continue;
    const work: { id: string; i: number }[] = [{ id: start, i: 0 }];
    index.set(start, counter);
    low.set(start, counter++);
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1] as { id: string; i: number };
      const children = next.get(frame.id) ?? [];
      if (frame.i < children.length) {
        const child = children[frame.i++] as string;
        if (!index.has(child)) {
          index.set(child, counter);
          low.set(child, counter++);
          stack.push(child);
          onStack.add(child);
          work.push({ id: child, i: 0 });
        } else if (onStack.has(child)) {
          low.set(frame.id, Math.min(low.get(frame.id) as number, index.get(child) as number));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id) as number, low.get(frame.id) as number));
      if (low.get(frame.id) === index.get(frame.id)) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop() as string;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.id);
        const selfLoop = component.length === 1 && (next.get(frame.id) ?? []).includes(frame.id);
        if (component.length > 1 || selfLoop) components.push(component.sort(compare));
      }
    }
  }
  return components.sort((a, b) => compare(a[0] as string, b[0] as string));
}

class TooManyCycles extends Error {}

/** Johnson's circuit search restricted to one component. Throws TooManyCycles past the cap. */
function circuitsIn(component: readonly string[], next: Map<string, string[]>, cap: number): string[][] {
  const members = new Set(component);
  const found: string[][] = [];
  for (let s = 0; s < component.length; s++) {
    const start = component[s] as string;
    // Subgraph induced by the component's nodes >= start: every cycle through
    // `start` found here has `start` as its smallest node.
    const allowed = new Set(component.slice(s));
    const succ = (v: string) => (next.get(v) ?? []).filter((w) => members.has(w) && allowed.has(w));
    const blocked = new Set<string>();
    const blockers = new Map<string, Set<string>>();
    const path: string[] = [];

    const unblock = (u: string): void => {
      const pending = [u];
      while (pending.length > 0) {
        const v = pending.pop() as string;
        if (!blocked.delete(v)) continue;
        const waiting = blockers.get(v);
        if (!waiting) continue;
        blockers.delete(v);
        pending.push(...waiting);
      }
    };

    const circuit = (v: string): boolean => {
      let closed = false;
      path.push(v);
      blocked.add(v);
      for (const w of succ(v)) {
        if (w === start) {
          found.push([...path]);
          if (found.length > cap) throw new TooManyCycles();
          closed = true;
        } else if (!blocked.has(w) && circuit(w)) {
          closed = true;
        }
      }
      if (closed) {
        unblock(v);
      } else {
        for (const w of succ(v)) {
          let waiting = blockers.get(w);
          if (!waiting) blockers.set(w, (waiting = new Set()));
          waiting.add(v);
        }
      }
      path.pop();
      return closed;
    };
    circuit(start);
  }
  return found;
}

/**
 * Every elementary cycle in the (filtered) graph, in canonical rotation,
 * sorted by signature. Deterministic for a given graph and options.
 */
export function findCycles(graph: ModuleGraph, options: CycleOptions = {}): Cycle[] {
  const maxSize = options.maxComponentSize ?? 2_000;
  const cap = options.maxCyclesPerComponent ?? 1_000;
  const next = successors(graph, options);
  const cycles: Cycle[] = [];
  for (const component of cyclicComponents(graph, options)) {
    const coarse = (): Cycle => ({ nodes: component, signature: `{${component.join(", ")}}`, exact: false });
    if (component.length > maxSize) {
      cycles.push(coarse());
      continue;
    }
    try {
      for (const nodes of circuitsIn(component, next, cap)) cycles.push({ nodes, signature: nodes.join(" -> "), exact: true });
    } catch (error) {
      if (!(error instanceof TooManyCycles)) throw error;
      cycles.push(coarse());
    }
  }
  return cycles.sort((a, b) => compare(a.signature, b.signature));
}
