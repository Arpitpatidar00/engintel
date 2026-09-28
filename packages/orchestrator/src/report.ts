// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import type { Diagnostic } from "@engintel/config";
import type { EvaluationResult, Scope } from "@engintel/policy";

/**
 * Run reports: the JSON reporter prints these verbatim. They contain no
 * timestamps, durations, hostnames, or absolute paths, so the same inputs
 * give byte-identical output (research doc 07, AV-8). `now` is the injected
 * clock the exceptions were judged against.
 */

export const REPORT_SCHEMA_VERSION = 1;

export interface ContractSummary {
  readonly file: string;
  readonly status: "draft" | "active";
  readonly policyVersion: string;
  readonly contractHash: string;
}

export interface BaselineSection {
  readonly file: string;
  /** "merge-base" for pull requests: the PR's own baseline edits cannot hide its debt. */
  readonly comparedWith: "working-copy" | "merge-base";
  /** Entries in the baseline compared against. */
  readonly entries: number;
  /** Findings suppressed because their identity is baselined. */
  readonly suppressed: number;
  /** Baselined identities that no longer occur (full runs only; null for --changed). */
  readonly stale: readonly string[] | null;
}

export interface ValidationReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly command: "validate";
  readonly engineVersion: string;
  readonly identityVersion: number;
  readonly outcome: "pass" | "fail";
  readonly exitCode: 0 | 1;
  readonly now: string;
  readonly scope: Scope;
  /** Set for `--changed` runs: the base ref, its commit, and the merge base the diff was taken from. */
  readonly git: { readonly base: string; readonly baseCommit: string; readonly mergeBase: string } | null;
  readonly contract: ContractSummary;
  readonly repository: { readonly treeHash: string };
  readonly counts: EvaluationResult["counts"];
  /** null when the repository has no baseline. */
  readonly baseline: BaselineSection | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly exceptionsApplied: EvaluationResult["exceptionsApplied"];
  readonly unanalyzable: EvaluationResult["unanalyzable"];
  readonly stats: EvaluationResult["stats"];
  readonly notices: readonly string[];
}

export interface AnalysisReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly command: "analyze";
  readonly engineVersion: string;
  readonly outcome: "ok";
  readonly exitCode: 0;
  readonly contract: ContractSummary | null;
  readonly repository: {
    readonly treeHash: string;
    /** `ok`, `unreadable`, and `ignored` count source files; `other` counts everything else. */
    readonly files: { readonly total: number; readonly source: number; readonly ok: number; readonly unreadable: number; readonly ignored: number; readonly other: number };
  };
  readonly graph: {
    readonly file: string | null;
    readonly modules: number;
    readonly external: number;
    readonly core: number;
    readonly unresolved: number;
    readonly edges: number;
    readonly cycles: number;
  };
  /** Exported symbols from the TypeScript checker (ENG-029); configFile null is the default project. */
  readonly symbols: {
    readonly file: string | null;
    readonly exported: number;
    readonly projects: readonly { readonly configFile: string | null; readonly files: number }[];
  };
  /** Files per layer, in contract order; empty without a contract. */
  readonly layers: readonly { readonly id: string; readonly files: number }[];
  readonly unlayered: number;
  readonly unanalyzable: readonly { readonly path: string; readonly reason: string }[];
  readonly notices: readonly string[];
}

export interface ErrorReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly command: string;
  readonly engineVersion: string;
  readonly outcome: "error";
  readonly exitCode: 2;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly file: string | null;
    readonly issues: readonly { readonly path: string; readonly message: string }[];
  };
}

export type Report = ValidationReport | AnalysisReport | ErrorReport;

/** Canonical JSON for stdout and golden comparison. */
export function serializeReport(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
