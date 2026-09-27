// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import type { ArchitectureContract, ArchitectureRule, Diagnostic, LayerRef } from "@engintel/config";
import { buildAdjacency, findCycles, type Adjacency, type GraphEdge, type ModuleGraph } from "@engintel/graph";
import {
  cycleViolation,
  forbiddenEdge,
  intraLayerEdge,
  missingRequired,
  notAllowedEdge,
  opaqueImport,
  overlappingLayers,
  toDiagnostic,
  unanalyzableFile,
  unlayeredFile,
  unreachable,
  unresolvedImport,
  type ContractSeverity,
  type EdgeFacts,
  type ExampleSymbol,
  type Position,
  type Suggestion,
  type Violation,
} from "./diagnostics.js";
import { LayerIndex, describeRef, globMatcher, refLayers } from "./layers.js";
import { LayerGraph, allowedTargets } from "./routes.js";

/**
 * The rule engine (ENG-007; research doc 07, section 6). Pure: the same
 * inputs always give the same result, byte for byte. It never reads files,
 * never reads the clock (`now` is injected), and never shells out to git
 * (the caller resolves the scope).
 */

export type Scope =
  | { readonly mode: "full" }
  | {
      readonly mode: "changed";
      /** Canonical repo paths. */
      readonly changedFiles: readonly string[];
      /** The contract is in the diff: policy changes re-evaluate everything. */
      readonly contractChanged: boolean;
    };

/** Every source file the scanner saw and did not ignore. */
export interface SourceFileState {
  readonly path: string;
  /** null when the file was read and parsed; otherwise why it could not be. */
  readonly unanalyzable: { readonly reason: string; readonly detail: string } | null;
}

export interface ImportSite {
  /** null when the specifier is not a string literal. */
  readonly specifier: string | null;
  readonly kind: "import" | "type-only" | "re-export" | "dynamic" | "require" | "side-effect";
  readonly line: number;
  readonly column: number;
}

export interface ExportedSymbol {
  readonly name: string;
  readonly kind: string;
}

/** What the parse pass learned about one analyzable file. */
export interface FileFacts {
  readonly imports: readonly ImportSite[];
  readonly exports: readonly ExportedSymbol[];
}

export interface EvaluationInput {
  readonly contract: ArchitectureContract;
  readonly graph: ModuleGraph;
  readonly files: readonly SourceFileState[];
  readonly facts: ReadonlyMap<string, FileFacts>;
  readonly scope: Scope;
  /** UTC date, YYYY-MM-DD. Exceptions are active while now <= expiresAt. */
  readonly now: string;
}

export interface ExceptionApplication {
  readonly exceptionId: string;
  readonly ruleId: string;
  readonly source: string;
  readonly target: string;
  readonly expiresAt: string;
}

export interface UnanalyzableEntry {
  readonly path: string;
  readonly reason: string;
  readonly inScope: boolean;
  /** Matched a reviewed unsupportedPaths entry: reported, never blocking. */
  readonly allowlisted: boolean;
}

export interface EvaluationResult {
  readonly outcome: "pass" | "fail";
  readonly counts: {
    readonly errors: number;
    readonly warnings: number;
    readonly advisories: number;
    readonly suppressedByException: number;
    readonly unanalyzable: number;
  };
  /** Sorted by file, position, rule, identity. */
  readonly diagnostics: readonly Diagnostic[];
  readonly exceptionsApplied: readonly ExceptionApplication[];
  readonly unanalyzable: readonly UnanalyzableEntry[];
  readonly stats: { readonly files: number; readonly filesInScope: number; readonly edges: number; readonly edgesEvaluated: number };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const EXAMPLE_KIND_RANK: Record<string, number> = { class: 0, function: 1, variable: 2, value: 2, enum: 2 };

export function evaluate(input: EvaluationInput): EvaluationResult {
  const { contract, graph, facts, now } = input;
  const files = [...input.files].sort((a, b) => compare(a.path, b.path));
  const index = new LayerIndex(contract);
  const layerGraph = new LayerGraph(contract);
  const adjacency = buildAdjacency(graph);
  const changed = input.scope.mode === "changed" && !input.scope.contractChanged ? new Set(input.scope.changedFiles) : null;
  const fileInScope = (path: string) => changed === null || changed.has(path);
  const edgeInScope = (edge: GraphEdge) => changed === null || changed.has(edge.from) || changed.has(edge.to);
  const analyzable = files.filter((f) => f.unanalyzable === null).map((f) => f.path);
  const opaqueSeverity: ContractSeverity = contract.opaqueImports === "error" ? "error" : "warn";

  const violations: Violation[] = [];
  const exceptionsApplied: ExceptionApplication[] = [];

  /** Active exception: record and suppress. Expired: returned so the message says so. */
  const exceptionFor = (ruleId: string, source: string, target: string): { suppressed: boolean; expired?: { id: string; expiresAt: string } } => {
    const matching = contract.exceptions.filter(
      (ex) => ex.ruleId === ruleId && globMatcher(ex.source)(source) && (ex.target === "*" || globMatcher(ex.target)(target)),
    );
    const active = matching.find((ex) => now <= ex.expiresAt);
    if (active) {
      exceptionsApplied.push({ exceptionId: active.id, ruleId, source, target, expiresAt: active.expiresAt });
      return { suppressed: true };
    }
    const expired = matching[0];
    return expired ? { suppressed: false, expired: { id: expired.id, expiresAt: expired.expiresAt } } : { suppressed: false };
  };

  const positionOf = (edge: GraphEdge): Position | null => {
    const site = facts.get(edge.from)?.imports.find((i) => i.specifier === edge.specifier);
    return site ? { line: site.line, column: site.column } : null;
  };

  const example = (layer: string, edge: GraphEdge): ExampleSymbol | null => {
    const srcLayer = index.layerOf(edge.from);
    const rank = (path: string): [number, number] => [
      (adjacency.out.get(path) ?? []).some((e) => e.to === edge.to) ? 0 : 1,
      (adjacency.in.get(path) ?? []).some((e) => e.from !== edge.from && index.layerOf(e.from) === srcLayer) ? 0 : 1,
    ];
    const candidates = analyzable
      .filter((p) => index.layerOf(p) === layer)
      .map((p) => ({ p, r: rank(p) }))
      .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || compare(a.p, b.p));
    for (const { p } of candidates) {
      const symbol = [...(facts.get(p)?.exports ?? [])]
        .filter((s) => s.kind in EXAMPLE_KIND_RANK && s.name !== "default")
        .sort((a, b) => (EXAMPLE_KIND_RANK[a.kind] as number) - (EXAMPLE_KIND_RANK[b.kind] as number))[0];
      if (symbol) return { name: symbol.name, kind: symbol.kind, file: p };
    }
    return null;
  };

  const suggestFor = (edge: GraphEdge, srcLayer: string | null, dstLayer: string | null): Suggestion => {
    if (srcLayer === null || dstLayer === null) {
      if (edge.to.startsWith("unresolved:")) {
        return {
          kind: "none",
          explanation:
            "Fix the import so it resolves. If a build tool resolves it in a way EngIntel cannot see, list the specifier in externals.allowUnresolved (reviewed like policy).",
        };
      }
      if (/^(external|core):/.test(edge.to)) {
        return { kind: "none", explanation: `Remove the dependency on ${edge.to} from this file, or move the code that needs it to a layer that may use it.` };
      }
      return { kind: "none", explanation: "No layer route applies to this dependency. See the rule comment." };
    }
    const paths = layerGraph.shortestPaths(srcLayer, dstLayer);
    if (paths.length === 0) {
      return { kind: "none", explanation: `The contract allows no route from layer '${srcLayer}' to layer '${dstLayer}'. See the rule comment.` };
    }
    if (paths.length > 1) {
      return {
        kind: "none",
        explanation: `No unique legal layer route. Candidates: ${paths.map((p) => p.join(" -> ")).join("; ")}. See the rule comment.`,
      };
    }
    const path = paths[0] as string[];
    if (path.length < 3) return { kind: "none", explanation: "See the rule comment." };
    const via = path[1] as string;
    const symbol = example(via, edge);
    const hint = symbol ? ` For example, use ${symbol.name} (${symbol.kind}) from ${symbol.file}.` : "";
    return { kind: "use-layer", layers: path, explanation: `Depend on layer '${via}' instead, following the legal route ${path.join(" -> ")}.${hint}` };
  };

  const edgeFacts = (rule: ArchitectureRule, edge: GraphEdge, srcLayer: string | null, dstLayer: string | null, expired?: EdgeFacts["expired"]): EdgeFacts => ({
    ruleId: rule.id,
    severity: rule.severity,
    comment: rule.comment,
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    isTypeOnly: edge.isTypeOnly,
    srcLayer,
    dstLayer,
    position: positionOf(edge),
    suggest: suggestFor(edge, srcLayer, dstLayer),
    expired,
  });

  // Files: overlapping layers, unanalyzable, unlayered.
  const unanalyzable: UnanalyzableEntry[] = [];
  for (const file of files) {
    const inScope = fileInScope(file.path);
    const layers = index.layersOf(file.path);
    if (layers.length > 1 && inScope) violations.push(overlappingLayers({ file: file.path, layers }));
    if (file.unanalyzable) {
      const allowlisted = contract.unsupportedPaths.some((entry) => globMatcher(entry.glob)(file.path));
      unanalyzable.push({ path: file.path, reason: file.unanalyzable.reason, inScope, allowlisted });
      if (inScope && !allowlisted) violations.push(unanalyzableFile({ file: file.path, ...file.unanalyzable }));
      continue;
    }
    if (layers.length === 0 && inScope) {
      violations.push(unlayeredFile({ file: file.path, severity: contract.unlayered?.severity ?? "advisory", comment: contract.unlayered?.comment }));
    }
    for (const site of facts.get(file.path)?.imports ?? []) {
      if (!inScope || site.specifier !== null || (site.kind !== "dynamic" && site.kind !== "require")) continue;
      violations.push(
        opaqueImport({ file: file.path, severity: opaqueSeverity, call: site.kind === "require" ? "require" : "import", position: { line: site.line, column: site.column } }),
      );
    }
  }

  // Edges: forbidden, exclusive allowed, intra-layer, unresolved.
  const rules = contract.rules.filter((r) => r.enabled);
  const exclusiveLayers = new Map<string, { rule: ArchitectureRule; allowed: Set<string> }>();
  for (const rule of rules) {
    if (rule.kind === "allowed" && rule.exclusive && "layer" in rule.from) {
      exclusiveLayers.set(rule.from.layer, { rule, allowed: allowedTargets(contract, rule.from.layer) ?? new Set() });
    }
  }
  let edgesEvaluated = 0;
  for (const edge of graph.edges) {
    if (!edgeInScope(edge)) continue;
    edgesEvaluated++;
    const srcLayer = index.layerOf(edge.from);
    const dstLayer = index.layerOf(edge.to);
    let reportedUnresolved = false;
    for (const rule of rules) {
      if (rule.kind !== "forbidden") continue;
      if ((rule.ignoreTypeOnly && edge.isTypeOnly) || (rule.ignoreDynamic && edge.isDynamic)) continue;
      const on = (ref: LayerRef, id: string) => index.matches(ref, id, edge.specifier);
      const hit =
        (rule.direction !== "backward" && on(rule.from, edge.from) && on(rule.to, edge.to)) ||
        (rule.direction !== "forward" && on(rule.to, edge.from) && on(rule.from, edge.to));
      if (!hit) continue;
      if (edge.to.startsWith("unresolved:")) reportedUnresolved = true;
      const ex = exceptionFor(rule.id, edge.from, edge.to);
      if (!ex.suppressed) violations.push(forbiddenEdge(edgeFacts(rule, edge, srcLayer, dstLayer, ex.expired)));
    }
    const exclusive = srcLayer === null ? undefined : exclusiveLayers.get(srcLayer);
    if (srcLayer !== null && dstLayer !== null) {
      const intra = srcLayer === dstLayer;
      if (exclusive && (intra ? !index.intraAllowed(srcLayer) : !exclusive.allowed.has(dstLayer))) {
        const ex = exceptionFor(exclusive.rule.id, edge.from, edge.to);
        if (!ex.suppressed) {
          violations.push(
            notAllowedEdge({
              ...edgeFacts(exclusive.rule, edge, srcLayer, dstLayer, ex.expired),
              allowed: [...exclusive.allowed].sort(compare),
              intraAllowed: index.intraAllowed(srcLayer),
            }),
          );
        }
      } else if (!exclusive && intra && !index.intraAllowed(srcLayer)) {
        violations.push(
          intraLayerEdge({
            ruleId: "engintel.intra-layer",
            severity: "error",
            comment: "",
            from: edge.from,
            to: edge.to,
            kind: edge.kind,
            isTypeOnly: edge.isTypeOnly,
            srcLayer,
            dstLayer,
            position: positionOf(edge),
            suggest: { kind: "none", explanation: `Move the shared code out of layer '${srcLayer}', or set intraAllowed to true.` },
          }),
        );
      }
    }
    if (edge.to.startsWith("unresolved:") && !reportedUnresolved && !index.isAllowedUnresolved(edge.specifier)) {
      violations.push(
        unresolvedImport({
          ruleId: "engintel.unresolved-import",
          severity: opaqueSeverity,
          comment: "",
          from: edge.from,
          to: edge.to,
          kind: edge.kind,
          isTypeOnly: edge.isTypeOnly,
          srcLayer,
          dstLayer: null,
          position: positionOf(edge),
          suggest: suggestFor(edge, srcLayer, null),
          specifier: edge.specifier,
        }),
      );
    }
  }

  // Graph-level rules: acyclic, required, reachable.
  for (const rule of rules) {
    if (rule.kind === "acyclic") {
      for (const cycle of findCycles(graph, { include: (id) => index.matches(rule.within, id) })) {
        if (changed !== null && !cycle.nodes.some((n) => changed.has(n))) continue;
        const ex = exceptionFor(rule.id, cycle.nodes[0] as string, cycle.nodes[cycle.nodes.length - 1] as string);
        if (ex.suppressed) continue;
        violations.push(
          cycleViolation({ ruleId: rule.id, severity: rule.severity, comment: rule.comment, within: describeRef(rule.within), ...cycle, expired: ex.expired }),
        );
      }
    } else if (rule.kind === "required") {
      const from = refLayers(rule.from);
      const to = refLayers(rule.to);
      const layers = from?.length === 1 && to?.length === 1 ? [from[0] as string, to[0] as string] : undefined;
      for (const file of analyzable) {
        if (!fileInScope(file) || !index.matches(rule.from, file)) continue;
        if ((adjacency.out.get(file) ?? []).some((e) => index.matches(rule.to, e.to, e.specifier))) continue;
        const ex = exceptionFor(rule.id, file, "<missing>");
        if (ex.suppressed) continue;
        violations.push(
          missingRequired({ ruleId: rule.id, severity: rule.severity, comment: rule.comment, file, from: describeRef(rule.from), to: describeRef(rule.to), layers, expired: ex.expired }),
        );
      }
    } else if (rule.kind === "reachable") {
      const reached = forwardReachable(adjacency, analyzable.filter((f) => index.matches(rule.from, f)));
      for (const file of analyzable) {
        if (!fileInScope(file) || !index.matches(rule.to, file) || reached.has(file)) continue;
        const ex = exceptionFor(rule.id, "<unreachable-from>", file);
        if (ex.suppressed) continue;
        violations.push(unreachable({ ruleId: rule.id, severity: rule.severity, comment: rule.comment, file, from: describeRef(rule.from), expired: ex.expired }));
      }
    }
  }

  const unique = new Map<string, Diagnostic>();
  for (const v of violations) {
    const d = toDiagnostic(v);
    unique.set(JSON.stringify(d), d);
  }
  const diagnostics = [...unique.values()].sort(compareDiagnostics);
  const count = (severity: Diagnostic["severity"]) => diagnostics.filter((d) => d.severity === severity).length;
  const blocking = diagnostics.filter((d) => d.blocking).length;
  return {
    outcome: blocking > 0 ? "fail" : "pass",
    counts: {
      errors: count("error"),
      warnings: count("warning"),
      advisories: count("advisory"),
      suppressedByException: exceptionsApplied.length,
      unanalyzable: unanalyzable.filter((u) => u.inScope && !u.allowlisted).length,
    },
    diagnostics,
    exceptionsApplied: exceptionsApplied.sort(
      (a, b) => compare(a.exceptionId, b.exceptionId) || compare(a.source, b.source) || compare(a.target, b.target),
    ),
    unanalyzable,
    stats: { files: files.length, filesInScope: files.filter((f) => fileInScope(f.path)).length, edges: graph.edges.length, edgesEvaluated },
  };
}

function forwardReachable(adjacency: Adjacency, seeds: readonly string[]): Set<string> {
  const seen = new Set(seeds);
  const queue = [...seeds];
  for (let i = 0; i < queue.length; i++) {
    for (const edge of adjacency.out.get(queue[i] as string) ?? []) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
  return seen;
}

export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return (
    compare(a.file ?? "", b.file ?? "") ||
    (a.range?.start.line ?? 0) - (b.range?.start.line ?? 0) ||
    (a.range?.start.column ?? 0) - (b.range?.start.column ?? 0) ||
    compare(a.ruleId, b.ruleId) ||
    compare(a.identity, b.identity) ||
    compare(JSON.stringify(a), JSON.stringify(b))
  );
}
