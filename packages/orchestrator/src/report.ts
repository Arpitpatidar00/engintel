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

export interface ValidationReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly command: "validate";
  readonly engineVersion: string;
  readonly identityVersion: number;
  readonly outcome: "pass" | "fail";
  readonly exitCode: 0 | 1;
  readonly now: string;
  readonly scope: Scope;
  readonly contract: ContractSummary;
  readonly repository: { readonly treeHash: string };
  readonly counts: EvaluationResult["counts"];
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
    readonly files: { readonly total: number; readonly source: number; readonly ok: number; readonly unreadable: number; readonly ignored: number; readonly unsupported: number };
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
