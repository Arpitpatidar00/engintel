// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { DIAGNOSTIC_SCHEMA_VERSION, type Diagnostic, type EdgeKind } from "@engintel/config";
import { violationIdentity } from "./identity.js";

/**
 * Diagnostics builder (ENG-032; research doc 07, section 7; FR-007).
 *
 * Every blocking finding answers what (message), why (rule comment and
 * template), where (file and position), which rule, which edge, and what
 * would have been legal (suggest, explicitly "none" when nothing is). Wording
 * comes from fixed templates filled with contract text, node ids, and layer
 * ids only: never repository source text, never a clock, never an LLM.
 */

export type ContractSeverity = "error" | "warn" | "advisory";

/** Built-in rule ids. The contract cannot declare ids with dots, so these cannot collide. */
export const BUILTIN_RULES = {
  unanalyzable: "engintel.unanalyzable",
  opaqueImport: "engintel.opaque-import",
  unresolvedImport: "engintel.unresolved-import",
  unlayered: "engintel.unlayered",
  overlappingLayers: "engintel.overlapping-layers",
  intraLayer: "engintel.intra-layer",
} as const;

export interface Position {
  readonly line: number;
  readonly column: number;
}

export interface Suggestion {
  readonly kind: Diagnostic["suggest"]["kind"];
  readonly explanation: string;
  readonly layers?: readonly string[];
}

/** A rule hit before it becomes a Diagnostic. `source`/`target`/`cycleSignature` feed the identity. */
export interface Violation {
  readonly ruleId: string;
  readonly severity: ContractSeverity;
  readonly adapter: "architecture" | "analyzer";
  readonly source: string;
  readonly target: string;
  readonly cycleSignature: string | null;
  readonly file: string | null;
  readonly position: Position | null;
  /** Set when the violation is a single graph edge. */
  readonly edgeKind: EdgeKind | null;
  readonly message: string;
  readonly why: string;
  readonly suggest: Suggestion;
}

export interface ExampleSymbol {
  readonly name: string;
  readonly kind: string;
  readonly file: string;
}

export interface EdgeFacts {
  readonly ruleId: string;
  readonly severity: ContractSeverity;
  readonly comment: string;
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  readonly isTypeOnly: boolean;
  readonly srcLayer: string | null;
  readonly dstLayer: string | null;
  readonly position: Position | null;
  readonly suggest: Suggestion;
  /** An exception matched this violation but had expired. */
  readonly expired?: { readonly id: string; readonly expiresAt: string } | undefined;
}

const SEVERITY: Record<ContractSeverity, Diagnostic["severity"]> = { error: "error", warn: "warning", advisory: "advisory" };

const isRepoPath = (id: string) => !/^(external|core|unresolved):/.test(id) && !id.startsWith("<");

function sentence(text: string): string {
  const trimmed = text.trim();
  return trimmed === "" || /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function join(...parts: (string | null | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").map(sentence).join(" ");
}

function expiredNote(expired: EdgeFacts["expired"]): string | null {
  return expired ? `Exception '${expired.id}' expired on ${expired.expiresAt} and no longer applies` : null;
}

function verb(facts: { isTypeOnly: boolean; kind: EdgeKind }): string {
  if (facts.kind === "re-export") return "re-exports";
  if (facts.kind === "dynamic") return "dynamically imports";
  if (facts.isTypeOnly) return "imports types from";
  return "imports";
}

function edgeViolation(facts: EdgeFacts, message: string, why: string): Violation {
  return {
    ruleId: facts.ruleId,
    severity: facts.severity,
    adapter: "architecture",
    source: facts.from,
    target: facts.to,
    cycleSignature: null,
    file: facts.from,
    position: facts.position,
    edgeKind: facts.kind,
    message,
    why,
    suggest: facts.suggest,
  };
}

/** arch.forbidden-edge */
export function forbiddenEdge(facts: EdgeFacts): Violation {
  const layered = facts.srcLayer !== null && facts.dstLayer !== null;
  const message = layered
    ? `Forbidden dependency from layer '${facts.srcLayer}' to layer '${facts.dstLayer}': ${facts.from} ${verb(facts)} ${facts.to}.`
    : `Forbidden dependency: ${facts.from} ${verb(facts)} ${facts.to}.`;
  const why = layered
    ? join(`Layer '${facts.srcLayer}' is not allowed to depend on layer '${facts.dstLayer}' under rule '${facts.ruleId}'`, facts.comment, expiredNote(facts.expired))
    : join(`Rule '${facts.ruleId}' forbids this dependency`, facts.comment, expiredNote(facts.expired));
  return edgeViolation(facts, message, why);
}

/** arch.forbidden-edge, for the complement of an exclusive allowed rule. */
export function notAllowedEdge(facts: EdgeFacts & { readonly allowed: readonly string[]; readonly intraAllowed: boolean }): Violation {
  const list = facts.allowed.length > 0 ? facts.allowed.map((l) => `'${l}'`).join(", ") : "no other layer";
  const intra = facts.intraAllowed ? " (and its own layer)" : "";
  const message = `Dependency outside the allowed set of layer '${facts.srcLayer}': ${facts.from} ${verb(facts)} ${facts.to} (layer '${facts.dstLayer}').`;
  const why = join(
    `Layer '${facts.srcLayer}' may depend only on ${list}${intra}. '${facts.dstLayer}' is not in that set. Rule '${facts.ruleId}'`,
    facts.comment,
    expiredNote(facts.expired),
  );
  return edgeViolation(facts, message, why);
}

/** Two files in a layer with intraAllowed: false. */
export function intraLayerEdge(facts: EdgeFacts): Violation {
  return edgeViolation(
    facts,
    `Dependency inside layer '${facts.srcLayer}': ${facts.from} ${verb(facts)} ${facts.to}.`,
    join(`Layer '${facts.srcLayer}' sets intraAllowed to false, so its files may not depend on each other`, facts.comment),
  );
}

/** arch.unresolved: an unresolved import no contract rule already reported. */
export function unresolvedImport(facts: EdgeFacts & { readonly specifier: string }): Violation {
  return edgeViolation(
    facts,
    `Unresolved import: ${facts.from} imports '${facts.specifier}', which does not resolve to a file or an installed package.`,
    join(
      "An import EngIntel cannot resolve could point anywhere, so it cannot be checked against the contract and fails closed",
      `opaqueImports is '${facts.severity === "error" ? "error" : "warn"}'`,
    ),
  );
}

/** arch.cycle */
export function cycleViolation(facts: {
  readonly ruleId: string;
  readonly severity: ContractSeverity;
  readonly comment: string;
  readonly within: string;
  readonly nodes: readonly string[];
  readonly signature: string;
  readonly exact: boolean;
  readonly expired?: EdgeFacts["expired"];
}): Violation {
  const first = facts.nodes[0] as string;
  const last = facts.nodes[facts.nodes.length - 1] as string;
  const approx = facts.exact
    ? null
    : "The component has too many cycles to list; the signature is the set of files in the strongly connected component";
  return {
    ruleId: facts.ruleId,
    severity: facts.severity,
    adapter: "architecture",
    source: first,
    target: last,
    cycleSignature: facts.signature,
    file: first,
    position: null,
    edgeKind: null,
    message: `Import cycle in ${facts.within}: ${facts.exact ? `${facts.signature} -> ${first}` : facts.signature}.`,
    why: join(`Cycle inside ${facts.within}: ${facts.signature}. Rule '${facts.ruleId}'`, facts.comment, approx, expiredNote(facts.expired)),
    suggest: {
      kind: "split-module",
      explanation:
        "Break the cycle: move what both files need into a module that neither imports back, or invert one of the dependencies.",
    },
  };
}

/** A file in a required rule's `from` with no dependency on its `to`. */
export function missingRequired(facts: {
  readonly ruleId: string;
  readonly severity: ContractSeverity;
  readonly comment: string;
  readonly file: string;
  readonly from: string;
  readonly to: string;
  readonly layers?: readonly string[] | undefined;
  readonly expired?: EdgeFacts["expired"];
}): Violation {
  return {
    ruleId: facts.ruleId,
    severity: facts.severity,
    adapter: "architecture",
    source: facts.file,
    target: "<missing>",
    cycleSignature: null,
    file: facts.file,
    position: null,
    edgeKind: null,
    message: `Missing required dependency: ${facts.file} (${facts.from}) does not depend on ${facts.to}.`,
    why: join(`File '${facts.file}' in ${facts.from} has no dependency on ${facts.to}. Rule '${facts.ruleId}'`, facts.comment, expiredNote(facts.expired)),
    suggest: {
      kind: "use-layer",
      explanation: `Depend on ${facts.to} from this file.`,
      ...(facts.layers ? { layers: facts.layers } : {}),
    },
  };
}

/** A file in a reachable rule's `to` that nothing in its `from` reaches. */
export function unreachable(facts: {
  readonly ruleId: string;
  readonly severity: ContractSeverity;
  readonly comment: string;
  readonly file: string;
  readonly from: string;
  readonly expired?: EdgeFacts["expired"];
}): Violation {
  return {
    ruleId: facts.ruleId,
    severity: facts.severity,
    adapter: "architecture",
    source: "<unreachable-from>",
    target: facts.file,
    cycleSignature: null,
    file: facts.file,
    position: null,
    edgeKind: null,
    message: `Unreachable: nothing in ${facts.from} reaches ${facts.file}.`,
    why: join(`Rule '${facts.ruleId}' requires every such file to be reachable from ${facts.from}`, facts.comment, expiredNote(facts.expired)),
    suggest: { kind: "none", explanation: `Import ${facts.file} from ${facts.from}, directly or transitively, or remove it.` },
  };
}

/** arch.unanalyzable (D-009): fail closed on a file that cannot be read or parsed. */
export function unanalyzableFile(facts: { readonly file: string; readonly reason: string; readonly detail: string }): Violation {
  return {
    ruleId: BUILTIN_RULES.unanalyzable,
    severity: "error",
    adapter: "analyzer",
    source: facts.file,
    target: "<unanalyzable>",
    cycleSignature: null,
    file: facts.file,
    position: null,
    edgeKind: null,
    message: `${facts.file} could not be analyzed (${facts.reason}).`,
    why: join(
      "EngIntel fails closed: a file it cannot read or parse could hide any dependency, so it is never treated as a pass",
      facts.detail,
    ),
    suggest: {
      kind: "none",
      explanation: "Make the file analyzable, or add a reviewed unsupportedPaths entry to the contract.",
    },
  };
}

/** A non-literal import() or require(): the target cannot be known statically. */
export function opaqueImport(facts: {
  readonly file: string;
  readonly severity: ContractSeverity;
  readonly call: "import" | "require";
  readonly position: Position;
}): Violation {
  return {
    ruleId: BUILTIN_RULES.opaqueImport,
    severity: facts.severity,
    adapter: "architecture",
    source: facts.file,
    target: "unresolved:*dynamic*",
    cycleSignature: null,
    file: facts.file,
    position: facts.position,
    edgeKind: "dynamic",
    message: `Opaque import: ${facts.file} calls ${facts.call}() with a module name computed at runtime.`,
    why: join(
      "EngIntel cannot resolve a non-literal import, so it cannot check it against the contract",
      `opaqueImports is '${facts.severity === "error" ? "error" : "warn"}'`,
    ),
    suggest: {
      kind: "none",
      explanation: "Use a string-literal module specifier, or replace the computed import with a static import.",
    },
  };
}

export function unlayeredFile(facts: { readonly file: string; readonly severity: ContractSeverity; readonly comment?: string | undefined }): Violation {
  return {
    ruleId: BUILTIN_RULES.unlayered,
    severity: facts.severity,
    adapter: "architecture",
    source: facts.file,
    target: "<unlayered>",
    cycleSignature: null,
    file: facts.file,
    position: null,
    edgeKind: null,
    message: `${facts.file} is not in any layer.`,
    why: join("Layer rules cannot check a file that belongs to no layer", facts.comment),
    suggest: { kind: "move-file", explanation: "Add the file to a layer's globs, or move it under a layered directory." },
  };
}

export function overlappingLayers(facts: { readonly file: string; readonly layers: readonly string[] }): Violation {
  const list = facts.layers.map((l) => `'${l}'`).join(", ");
  return {
    ruleId: BUILTIN_RULES.overlappingLayers,
    severity: "error",
    adapter: "architecture",
    source: facts.file,
    target: "<overlapping-layers>",
    cycleSignature: null,
    file: facts.file,
    position: null,
    edgeKind: null,
    message: `${facts.file} matches more than one layer: ${list}.`,
    why: "Overlapping layer globs are a contract error: every file must belong to exactly one layer, so no rule can be evaluated for this file.",
    suggest: { kind: "none", explanation: `Make the globs of layers ${list} disjoint, for example with excludeGlobs.` },
  };
}

/** The Diagnostic every reporter and the MCP server share. */
export function toDiagnostic(v: Violation): Diagnostic {
  const blocking = v.severity === "error";
  return {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    identity: violationIdentity({ ruleId: v.ruleId, source: v.source, target: v.target, cycleSignature: v.cycleSignature }),
    adapter: v.adapter,
    ruleId: v.ruleId,
    severity: SEVERITY[v.severity],
    blocking,
    file: v.file !== null && isRepoPath(v.file) ? v.file : null,
    ...(v.position && v.file !== null ? { range: { start: v.position, end: v.position } } : {}),
    message: v.message,
    why: v.why,
    ...(v.edgeKind ? { edge: { source: v.source, target: v.target, kind: v.edgeKind } } : {}),
    ...(v.cycleSignature ? { cycleSignature: v.cycleSignature } : {}),
    suggest: { kind: v.suggest.kind, explanation: v.suggest.explanation, ...(v.suggest.layers ? { layers: [...v.suggest.layers] } : {}) },
  };
}
