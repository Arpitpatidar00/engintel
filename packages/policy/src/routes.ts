// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import type { ArchitectureContract } from "@engintel/config";
import { refLayers } from "./layers.js";

/**
 * The allowed-layer graph and suggested routes (research doc 07, section 7.1;
 * ENG-032). Nodes are layers. L1 -> L2 exists when no enabled forbidden rule
 * bans it and, if L1 has an exclusive allowed rule, L2 is in its allowed set.
 * Routes are computed from the contract alone, never inferred.
 */

export class LayerGraph {
  readonly #next = new Map<string, readonly string[]>();

  constructor(contract: ArchitectureContract) {
    const ids = contract.layers.map((l) => l.id);
    const banned = new Set<string>();
    const exclusive = new Map<string, Set<string>>();
    for (const rule of contract.rules) {
      if (!rule.enabled) continue;
      if (rule.kind === "forbidden") {
        const from = refLayers(rule.from);
        const to = refLayers(rule.to);
        if (!from || !to) continue;
        for (const a of from) {
          for (const b of to) {
            if (rule.direction !== "backward") banned.add(`${a}\0${b}`);
            if (rule.direction !== "forward") banned.add(`${b}\0${a}`);
          }
        }
      }
    }
    for (const layer of ids) {
      const allowed = allowedTargets(contract, layer);
      if (allowed) exclusive.set(layer, allowed);
    }
    for (const a of ids) {
      this.#next.set(
        a,
        ids.filter((b) => b !== a && !banned.has(`${a}\0${b}`) && (exclusive.get(a)?.has(b) ?? true)),
      );
    }
  }

  /** Every shortest layer path from `from` to `to`, sorted; [] when unreachable. */
  shortestPaths(from: string, to: string): string[][] {
    if (!this.#next.has(from) || !this.#next.has(to) || from === to) return [];
    const depth = new Map<string, number>([[from, 0]]);
    const parents = new Map<string, string[]>();
    const queue = [from];
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i] as string;
      for (const next of this.#next.get(node) ?? []) {
        const d = (depth.get(node) as number) + 1;
        if (!depth.has(next)) {
          depth.set(next, d);
          parents.set(next, [node]);
          queue.push(next);
        } else if (depth.get(next) === d) {
          parents.get(next)?.push(node);
        }
      }
    }
    if (!depth.has(to)) return [];
    const paths: string[][] = [];
    const walk = (node: string, suffix: string[]) => {
      if (node === from) {
        paths.push([from, ...suffix]);
        return;
      }
      for (const parent of parents.get(node) ?? []) walk(parent, [node, ...suffix]);
    };
    walk(to, []);
    return paths.map((p) => p).sort((a, b) => (a.join("\0") < b.join("\0") ? -1 : 1));
  }
}

/**
 * The layers `layer` may depend on when it has an exclusive allowed rule: the
 * union of every enabled allowed rule from that layer. null when no exclusive
 * rule constrains it.
 */
export function allowedTargets(contract: ArchitectureContract, layer: string): Set<string> | null {
  const fromLayer = contract.rules.filter(
    (r) => r.enabled && r.kind === "allowed" && "layer" in r.from && r.from.layer === layer,
  );
  if (!fromLayer.some((r) => r.kind === "allowed" && r.exclusive)) return null;
  const allowed = new Set<string>();
  for (const rule of fromLayer) {
    if (rule.kind !== "allowed") continue;
    for (const target of refLayers(rule.to) ?? []) allowed.add(target);
  }
  return allowed;
}
