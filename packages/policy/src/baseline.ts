// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { BASELINE_IDENTITY_VERSION, type BaselineFile } from "@engintel/config";
import { BUILTIN_RULES } from "./diagnostics.js";
import type { EvaluationResult, Finding } from "./evaluate.js";
import { IDENTITY_VERSION, IdentityError, violationIdentity } from "./identity.js";

/**
 * Baseline semantics (ENG-009; research doc 08, section 5): a finding whose
 * identity is in the baseline is existing debt and does not fail the run;
 * everything else does (D-008). The baseline never suppresses fail-closed
 * findings, and only blocking errors are ever baseline-eligible.
 */

/**
 * Rules that can never be baselined (ENG-009, doc 23). They mean "EngIntel
 * could not judge this" or "the policy itself is being weakened", and must be
 * fixed, allowlisted in the contract, or approved by owners instead.
 */
export const BASELINE_FORBIDDEN_RULES: ReadonlySet<string> = new Set([
  BUILTIN_RULES.unanalyzable,
  BUILTIN_RULES.opaqueImport,
  BUILTIN_RULES.unresolvedImport,
  BUILTIN_RULES.overlappingLayers,
  BUILTIN_RULES.policyWeakening,
  BUILTIN_RULES.policyChange,
  BUILTIN_RULES.baselineDrop,
]);

export function isBaselineEligible(finding: Pick<Finding, "ruleId" | "blocking">): boolean {
  return finding.blocking && !BASELINE_FORBIDDEN_RULES.has(finding.ruleId);
}

export interface BaselineIntegrityIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Every entry's identity must be the hash of its own fields, and no entry may
 * name a fail-closed rule. A hand-edited source with a stale identity, or a
 * smuggled `engintel.unanalyzable` entry, fails closed (doc 08, section 4).
 */
export function checkBaselineIntegrity(baseline: BaselineFile): BaselineIntegrityIssue[] {
  const issues: BaselineIntegrityIssue[] = [];
  if (baseline.engineIdentityVersion !== IDENTITY_VERSION || BASELINE_IDENTITY_VERSION !== IDENTITY_VERSION) {
    issues.push({ path: "engineIdentityVersion", message: `this engine computes identity version ${IDENTITY_VERSION}` });
  }
  baseline.entries.forEach((entry, i) => {
    if (BASELINE_FORBIDDEN_RULES.has(entry.ruleId)) {
      issues.push({ path: `entries[${i}].ruleId`, message: `${entry.ruleId} can never be baselined; fix the file or allowlist it in the contract` });
      return;
    }
    let expected: string;
    try {
      expected = violationIdentity({ ruleId: entry.ruleId, source: entry.source, target: entry.target, cycleSignature: entry.cycleSignature });
    } catch (error) {
      if (!(error instanceof IdentityError)) throw error;
      issues.push({ path: `entries[${i}]`, message: error.message });
      return;
    }
    if (expected !== entry.identity) {
      issues.push({
        path: `entries[${i}].identity`,
        message: `does not match its fields (expected ${expected}); an entry was edited by hand. Rewrite it with engintel baseline write`,
      });
    }
  });
  return issues;
}

/**
 * Remove baselined findings from a result. Only baseline-eligible findings are
 * suppressed; the outcome and counts are recomputed.
 */
export function applyBaseline(result: EvaluationResult, baselined: ReadonlySet<string>): EvaluationResult {
  if (baselined.size === 0) return result;
  const suppressed = new Set(result.findings.filter((f) => isBaselineEligible(f) && baselined.has(f.identity)).map((f) => f.identity));
  if (suppressed.size === 0) return result;
  const diagnostics = result.diagnostics.filter((d) => !suppressed.has(d.identity));
  const count = (severity: string) => diagnostics.filter((d) => d.severity === severity).length;
  return {
    ...result,
    outcome: diagnostics.some((d) => d.blocking) ? "fail" : "pass",
    counts: {
      ...result.counts,
      errors: count("error"),
      warnings: count("warning"),
      advisories: count("advisory"),
      suppressedByBaseline: result.diagnostics.length - diagnostics.length,
    },
    diagnostics,
  };
}

/** Findings a `baseline write` would record: blocking and eligible. */
export function baselineCandidates(result: EvaluationResult): Finding[] {
  return result.findings.filter(isBaselineEligible);
}
