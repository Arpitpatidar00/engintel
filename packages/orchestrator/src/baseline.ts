// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { BASELINE_PATH, loadBaseline, parseBaselineText, type LoadedBaseline } from "@engintel/config";
import { applyBaseline, checkBaselineIntegrity, isBaselineEligible, type EvaluationResult, type Scope } from "@engintel/policy";
import { ToolError } from "./errors.js";
import type { BaselineSection } from "./report.js";

/**
 * Which baseline a run compares against (ENG-009; research doc 08, sections
 * 5 and 7).
 *
 * - Locally, the working copy's baseline.
 * - For a pull request (`--changed`, or a scenario with a base), the baseline
 *   at the merge base. The PR's own edits to baseline.json never shrink its
 *   failing set; additions count only when owners approved a baseline change.
 * - Debt the default branch has baselined since the fork is tolerated only
 *   for violations the PR does not touch, so parallel branches do not race.
 *
 * Every baseline read is integrity-checked; a broken one fails closed.
 */

export interface BaselineContext {
  /** The working copy's baseline.json. */
  readonly head: LoadedBaseline | null;
  /** The baseline suppression is judged against. */
  readonly reference: LoadedBaseline | null;
  readonly comparedWith: "working-copy" | "merge-base";
  /** The default branch's current baseline, in git mode. */
  readonly defaultBranch: LoadedBaseline | null;
}

function verified(loaded: LoadedBaseline | null, where: string): LoadedBaseline | null {
  if (!loaded) return null;
  const issues = checkBaselineIntegrity(loaded.baseline);
  if (issues.length > 0) {
    throw new ToolError("E_BASELINE_INVALID", `${loaded.file}${where} failed its integrity check: ${issues[0]?.path}: ${issues[0]?.message}`, {
      file: loaded.file,
      issues,
    });
  }
  return loaded;
}

export function loadBaselineContext(
  root: string,
  base: { readonly baseline: string | null } | undefined,
  defaultBranchText: string | null | undefined,
): BaselineContext {
  const head = verified(loadBaseline(root), "");
  if (!base) return { head, reference: head, comparedWith: "working-copy", defaultBranch: null };
  const at = (text: string | null | undefined, where: string) =>
    text === null || text === undefined ? null : verified(parseBaselineText(text, BASELINE_PATH, where), where);
  return {
    head,
    reference: at(base.baseline, " at the merge base"),
    comparedWith: "merge-base",
    defaultBranch: at(defaultBranchText, " on the default branch"),
  };
}

const idsOf = (loaded: LoadedBaseline | null) => new Set(loaded?.baseline.entries.map((e) => e.identity) ?? []);

/**
 * Apply the baseline to a result. `full` is a full-scope evaluation of the
 * same tree, used to find stale entries; pass null for changed-file runs.
 */
export function applyBaselineContext(
  result: EvaluationResult,
  context: BaselineContext,
  options: { readonly scope: Scope; readonly baselineChangeApproved: boolean },
): { result: EvaluationResult; section: BaselineSection | null } {
  if (!context.head && !context.reference && !context.defaultBranch) return { result, section: null };
  const suppress = idsOf(context.reference);
  if (options.baselineChangeApproved) for (const id of idsOf(context.head)) suppress.add(id);
  if (context.defaultBranch) {
    const changed = options.scope.mode === "changed" ? new Set(options.scope.changedFiles) : new Set<string>();
    const onDefault = idsOf(context.defaultBranch);
    for (const f of result.findings) {
      if (onDefault.has(f.identity) && !changed.has(f.source) && !changed.has(f.target)) suppress.add(f.identity);
    }
  }
  const applied = applyBaseline(result, suppress);
  let stale: string[] | null = null;
  if (options.scope.mode === "full" && context.head) {
    const current = new Set(result.findings.filter(isBaselineEligible).map((f) => f.identity));
    stale = context.head.baseline.entries.map((e) => e.identity).filter((id) => !current.has(id)).sort();
  }
  return {
    result: applied,
    section: {
      file: BASELINE_PATH,
      comparedWith: context.comparedWith,
      entries: context.reference?.baseline.entries.length ?? 0,
      suppressed: applied.counts.suppressedByBaseline,
      stale,
    },
  };
}
