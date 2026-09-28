// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import type { ArchitectureContract, ArchitectureRule, BaselineFile, ResolvedConfig } from "@engintel/config";
import { BUILTIN_RULES, type Violation } from "./diagnostics.js";

/**
 * Policy-change detection (ENG-012; FR-012; research doc 06, section 8).
 *
 * The attack this stops: an agent meets a red check and, instead of fixing
 * the import, deletes the rule, adds an exception that never expires, grows
 * the baseline, or excludes the file from analysis. Each policy file is
 * compared with its merge-base version and every difference is classified:
 *
 *   weakening   could let a violation pass that would have failed before;
 *               blocking unless owners approved the change
 *   tightening  can only make more things fail; reported, never silent
 *   neutral     wording, ownership, versions
 *
 * The classification is structural and conservative: a change whose effect
 * cannot be proven harmless (a rule's from/to edited, layer globs changed)
 * counts as weakening. Owners then approve it with a label; CODEOWNERS makes
 * sure they are the ones who do.
 */

export type ChangeClass = "weakening" | "tightening" | "neutral";

export interface PolicyChangeItem {
  /** The policy file, e.g. ".engintel/architecture.json". */
  readonly file: string;
  readonly class: ChangeClass;
  /** Stable key of what changed, e.g. "rule:no-controller-to-repository". */
  readonly subject: string;
  readonly summary: string;
}

const SEVERITY_RANK: Record<string, number> = { advisory: 0, warn: 1, error: 2 };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function byKey<T>(items: readonly T[], key: (t: T) => string): Map<string, T> {
  return new Map(items.map((t) => [key(t), t]));
}

function compareRules(file: string, before: ArchitectureRule, after: ArchitectureRule): PolicyChangeItem[] {
  const out: PolicyChangeItem[] = [];
  const subject = `rule:${after.id}`;
  const push = (cls: ChangeClass, summary: string) => out.push({ file, class: cls, subject, summary: `rule '${after.id}': ${summary}` });
  if (before.kind !== after.kind) {
    push("weakening", `kind changed from ${before.kind} to ${after.kind}`);
    return out;
  }
  if (before.enabled !== after.enabled) push(after.enabled ? "tightening" : "weakening", after.enabled ? "enabled" : "disabled");
  const rankBefore = SEVERITY_RANK[before.severity] ?? 0;
  const rankAfter = SEVERITY_RANK[after.severity] ?? 0;
  if (rankAfter !== rankBefore) push(rankAfter > rankBefore ? "tightening" : "weakening", `severity ${before.severity} -> ${after.severity}`);

  const scopeFields = before.kind === "acyclic" ? ["within"] : ["from", "to"];
  for (const field of scopeFields) {
    const a = (before as unknown as Record<string, unknown>)[field];
    const b = (after as unknown as Record<string, unknown>)[field];
    if (!same(a, b)) push("weakening", `${field} changed from ${JSON.stringify(a)} to ${JSON.stringify(b)}`);
  }
  if (before.kind === "forbidden" && after.kind === "forbidden") {
    for (const flag of ["ignoreTypeOnly", "ignoreDynamic"] as const) {
      if (before[flag] !== after[flag]) push(after[flag] ? "weakening" : "tightening", `${flag} ${before[flag]} -> ${after[flag]}`);
    }
    if (before.direction !== after.direction) {
      push(after.direction === "both" ? "tightening" : "weakening", `direction ${before.direction} -> ${after.direction}`);
    }
  }
  if (before.kind === "allowed" && after.kind === "allowed" && before.exclusive !== after.exclusive) {
    push(after.exclusive ? "tightening" : "weakening", `exclusive ${before.exclusive} -> ${after.exclusive}`);
  }
  if (before.comment !== after.comment) push("neutral", "comment edited");
  return out;
}

/** Classify every difference between two contracts. `base` null means the contract is new. */
export function classifyContractChange(file: string, base: ArchitectureContract | null, head: ArchitectureContract): PolicyChangeItem[] {
  if (!base) {
    return [{ file, class: head.status === "active" ? "tightening" : "neutral", subject: "contract", summary: `contract added (status ${head.status})` }];
  }
  const out: PolicyChangeItem[] = [];
  const add = (cls: ChangeClass, subject: string, summary: string) => out.push({ file, class: cls, subject, summary });

  if (base.status !== head.status) {
    add(head.status === "active" ? "tightening" : "weakening", "status", `status ${base.status} -> ${head.status}${head.status === "draft" ? " (the contract is no longer enforced)" : ""}`);
  }

  const layersBefore = byKey(base.layers, (l) => l.id);
  const layersAfter = byKey(head.layers, (l) => l.id);
  for (const [id, before] of layersBefore) {
    const after = layersAfter.get(id);
    if (!after) {
      add("weakening", `layer:${id}`, `layer '${id}' removed`);
      continue;
    }
    if (!same(before.globs, after.globs) || !same(before.excludeGlobs ?? [], after.excludeGlobs ?? [])) {
      add("weakening", `layer:${id}`, `layer '${id}': globs changed, so different files are governed by its rules`);
    }
    if (before.intraAllowed !== after.intraAllowed) {
      add(after.intraAllowed ? "weakening" : "tightening", `layer:${id}`, `layer '${id}': intraAllowed ${before.intraAllowed} -> ${after.intraAllowed}`);
    }
    if (before.description !== after.description || before.owner !== after.owner) add("neutral", `layer:${id}`, `layer '${id}': description or owner edited`);
  }
  for (const id of layersAfter.keys()) if (!layersBefore.has(id)) add("neutral", `layer:${id}`, `layer '${id}' added`);

  const rulesBefore = byKey(base.rules, (r) => r.id);
  const rulesAfter = byKey(head.rules, (r) => r.id);
  for (const [id, before] of rulesBefore) {
    const after = rulesAfter.get(id);
    if (!after) {
      add(before.kind === "allowed" && !before.exclusive ? "tightening" : "weakening", `rule:${id}`, `rule '${id}' (${before.kind}) removed`);
    } else {
      out.push(...compareRules(file, before, after));
    }
  }
  for (const [id, after] of rulesAfter) {
    if (!rulesBefore.has(id)) add(after.kind === "allowed" ? "weakening" : "tightening", `rule:${id}`, `rule '${id}' (${after.kind}) added`);
  }

  const exBefore = byKey(base.exceptions, (e) => e.id);
  const exAfter = byKey(head.exceptions, (e) => e.id);
  for (const [id, after] of exAfter) {
    const before = exBefore.get(id);
    if (!before) {
      add("weakening", `exception:${id}`, `exception '${id}' added for rule '${after.ruleId}' (${after.source} -> ${after.target}, until ${after.expiresAt})`);
      continue;
    }
    if (before.ruleId !== after.ruleId || before.source !== after.source || before.target !== after.target) {
      add("weakening", `exception:${id}`, `exception '${id}': what it waives changed`);
    }
    if (after.expiresAt > before.expiresAt) add("weakening", `exception:${id}`, `exception '${id}' extended from ${before.expiresAt} to ${after.expiresAt}`);
    if (after.expiresAt < before.expiresAt) add("tightening", `exception:${id}`, `exception '${id}' shortened to ${after.expiresAt}`);
    if (before.reason !== after.reason || before.owner !== after.owner) add("neutral", `exception:${id}`, `exception '${id}': reason or owner edited`);
  }
  for (const id of exBefore.keys()) if (!exAfter.has(id)) add("tightening", `exception:${id}`, `exception '${id}' removed`);

  const unsupportedBefore = new Set(base.unsupportedPaths.map((u) => u.glob));
  const unsupportedAfter = new Set(head.unsupportedPaths.map((u) => u.glob));
  for (const glob of unsupportedAfter) if (!unsupportedBefore.has(glob)) add("weakening", `unsupportedPaths:${glob}`, `unsupportedPaths allowlists '${glob}'`);
  for (const glob of unsupportedBefore) if (!unsupportedAfter.has(glob)) add("tightening", `unsupportedPaths:${glob}`, `unsupportedPaths no longer allowlists '${glob}'`);

  const allowBefore = new Set(base.externals?.allowUnresolved ?? []);
  const allowAfter = new Set(head.externals?.allowUnresolved ?? []);
  for (const s of allowAfter) if (!allowBefore.has(s)) add("weakening", `allowUnresolved:${s}`, `externals.allowUnresolved tolerates '${s}'`);
  for (const s of allowBefore) if (!allowAfter.has(s)) add("tightening", `allowUnresolved:${s}`, `externals.allowUnresolved no longer tolerates '${s}'`);

  if (base.opaqueImports !== head.opaqueImports) {
    add(head.opaqueImports === "error" ? "tightening" : "weakening", "opaqueImports", `opaqueImports ${base.opaqueImports} -> ${head.opaqueImports}`);
  }
  const unlayeredBefore = SEVERITY_RANK[base.unlayered?.severity ?? "advisory"] ?? 0;
  const unlayeredAfter = SEVERITY_RANK[head.unlayered?.severity ?? "advisory"] ?? 0;
  if (unlayeredBefore !== unlayeredAfter) {
    add(unlayeredAfter > unlayeredBefore ? "tightening" : "weakening", "unlayered", `unlayered severity ${base.unlayered?.severity ?? "advisory"} -> ${head.unlayered?.severity ?? "advisory"}`);
  }
  if (!same(base.naming, head.naming)) add("neutral", "naming", "naming rules edited (not enforced yet)");
  if (!same(base.ownership, head.ownership)) add("neutral", "ownership", "ownership edited");
  if (base.policyVersion !== head.policyVersion || base.description !== head.description) add("neutral", "metadata", "policyVersion or description edited");
  return out;
}

/** `.engintel/config.json`: anything that changes which files are analyzed or how imports resolve can hide a violation. */
export function classifyConfigChange(file: string, base: ResolvedConfig, head: ResolvedConfig): PolicyChangeItem[] {
  const out: PolicyChangeItem[] = [];
  const add = (cls: ChangeClass, subject: string, summary: string) => out.push({ file, class: cls, subject, summary });
  if (!same(base.include ?? null, head.include ?? null)) add("weakening", "include", "include changed, so a different set of files is analyzed");
  const exBefore = new Set(base.exclude);
  const exAfter = new Set(head.exclude);
  for (const glob of exAfter) if (!exBefore.has(glob)) add("weakening", `exclude:${glob}`, `exclude skips '${glob}'`);
  for (const glob of exBefore) if (!exAfter.has(glob)) add("tightening", `exclude:${glob}`, `exclude no longer skips '${glob}'`);
  if (base.tsconfig !== head.tsconfig) add("weakening", "tsconfig", `tsconfig ${base.tsconfig ?? "(default)"} -> ${head.tsconfig ?? "(default)"} changes how imports resolve`);
  if (!same(base.limits, head.limits)) add("neutral", "limits", "limits changed");
  return out;
}

/** `.engintel/ignore`: added patterns hide files from analysis. */
export function classifyIgnoreChange(file: string, base: string, head: string): PolicyChangeItem[] {
  const lines = (text: string) => new Set(text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#")));
  const before = lines(base);
  const after = lines(head);
  return [
    ...[...after].filter((l) => !before.has(l)).map((l) => ({ file, class: "weakening" as const, subject: `ignore:${l}`, summary: `ignores '${l}'` })),
    ...[...before].filter((l) => !after.has(l)).map((l) => ({ file, class: "tightening" as const, subject: `ignore:${l}`, summary: `no longer ignores '${l}'` })),
  ];
}

export interface BaselineChange {
  readonly items: readonly PolicyChangeItem[];
  /** Removed entries whose violation still occurs: dropping debt that was not fixed. */
  readonly dropped: readonly BaselineFile["entries"][number][];
}

/**
 * Baseline edits (doc 08, section 7): growth is a weakening (owners approve
 * with a baseline-change label); removing an entry whose violation still
 * occurs is always an error; removing a fixed one is a tightening.
 * `current` holds the baseline-eligible identities of a full evaluation.
 */
export function classifyBaselineChange(file: string, base: BaselineFile | null, head: BaselineFile | null, current: ReadonlySet<string>): BaselineChange {
  const before = byKey(base?.entries ?? [], (e) => e.identity);
  const after = byKey(head?.entries ?? [], (e) => e.identity);
  const items: PolicyChangeItem[] = [];
  const dropped: BaselineFile["entries"][number][] = [];
  for (const [id, e] of after) {
    if (!before.has(id)) items.push({ file, class: "weakening", subject: `baseline:${id}`, summary: `baseline adds ${e.ruleId}: ${e.source} -> ${e.target}` });
  }
  for (const [id, e] of before) {
    if (after.has(id)) continue;
    if (current.has(id)) dropped.push(e);
    else items.push({ file, class: "tightening", subject: `baseline:${id}`, summary: `baseline drops fixed ${e.ruleId}: ${e.source} -> ${e.target}` });
  }
  return { items, dropped };
}

/** Diagnostics for classified changes. Weakening blocks unless approved; tightening is advisory; neutral is report-only. */
export function policyChangeViolations(
  items: readonly PolicyChangeItem[],
  approved: (item: PolicyChangeItem) => boolean,
): Violation[] {
  const out: Violation[] = [];
  for (const item of items) {
    if (item.class === "neutral") continue;
    const weakening = item.class === "weakening";
    const isBaseline = item.subject.startsWith("baseline:");
    const label = isBaseline ? "baseline-change" : "policy-change";
    const ok = weakening && approved(item);
    out.push({
      ruleId: weakening ? BUILTIN_RULES.policyWeakening : BUILTIN_RULES.policyChange,
      severity: weakening ? (ok ? "warn" : "error") : "advisory",
      adapter: "policy",
      source: item.file,
      target: "<policy>",
      cycleSignature: null,
      identityDetail: item.subject,
      file: item.file,
      position: null,
      edgeKind: null,
      message: `${weakening ? "Policy weakening" : "Policy tightening"} in ${item.file}: ${item.summary}.`,
      why: weakening
        ? ok
          ? "Architecture owners approved this weakening for this pull request."
          : `A change to ${item.file} that could let a violation pass needs architecture owners' approval: their CODEOWNERS review and the '${label}' label on the pull request. EngIntel cannot tell a deliberate policy change from an agent removing the rule that blocks it.`
        : "Tightening the policy is allowed with normal review. It is reported so it is never silent.",
      suggest: {
        kind: "none",
        explanation: weakening
          ? `Revert this part of ${item.file}, or ask an architecture owner to review the change and add the '${label}' label.`
          : "No action needed.",
      },
    });
  }
  return out;
}

/** Removing a baseline entry while its violation still exists: always blocking. */
export function baselineDropViolations(file: string, dropped: readonly BaselineFile["entries"][number][]): Violation[] {
  return dropped.map((e) => ({
    ruleId: BUILTIN_RULES.baselineDrop,
    severity: "error" as const,
    adapter: "policy" as const,
    source: e.source,
    target: e.target,
    cycleSignature: e.cycleSignature,
    identityDetail: e.identity,
    file,
    position: null,
    edgeKind: null,
    message: `${file} removes the entry for ${e.ruleId} (${e.source} -> ${e.target}), but that violation still exists.`,
    why: "Dropping baseline debt that was not fixed makes every later change to those files fail. Fix the violation first, then remove the entry with engintel baseline prune.",
    suggest: { kind: "none" as const, explanation: "Restore the entry, or fix the violation in this pull request." },
  }));
}
