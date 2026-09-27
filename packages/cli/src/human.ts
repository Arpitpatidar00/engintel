// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import type { Diagnostic } from "@engintel/config";
import type { AnalysisReport, ToolError, ValidationReport } from "@engintel/orchestrator";

/**
 * Human reporter (ENG-033; research doc 17). Stable wording and layout, no
 * emoji, color only on a TTY. Everything it prints comes from the report, so
 * it can never show more than the JSON reporter does.
 */

export interface Style {
  readonly bold: (s: string) => string;
  readonly red: (s: string) => string;
  readonly yellow: (s: string) => string;
  readonly green: (s: string) => string;
  readonly dim: (s: string) => string;
}

const ansi = (open: number, close: number) => (s: string) => `\u001b[${open}m${s}\u001b[${close}m`;
export const COLOR: Style = { bold: ansi(1, 22), red: ansi(31, 39), yellow: ansi(33, 39), green: ansi(32, 39), dim: ansi(2, 22) };
const id = (s: string) => s;
export const PLAIN: Style = { bold: id, red: id, yellow: id, green: id, dim: id };

const plural = (n: number, singular: string, pluralForm = `${singular}s`) => `${n} ${n === 1 ? singular : pluralForm}`;

function severityLabel(d: Diagnostic, style: Style): string {
  if (d.severity === "error") return style.red(style.bold("error"));
  if (d.severity === "warning") return style.yellow("warning");
  return style.dim(d.severity);
}

function formatDiagnostic(d: Diagnostic, style: Style): string[] {
  const where = d.file ? `${d.file}${d.range ? `:${d.range.start.line}:${d.range.start.column}` : ""}` : "(repository)";
  const lines = [`${severityLabel(d, style)}  ${style.bold(d.ruleId)}${d.blocking ? "" : style.dim("  (not blocking)")}`, `  ${where}`, `  ${d.message}`, `  Why: ${d.why}`];
  if (d.edge) {
    lines.push("  Dependency:", `    ${d.edge.source}`, `    -> ${d.edge.target}  (${d.edge.kind})`);
  } else if (d.cycleSignature) {
    lines.push(`  Cycle: ${d.cycleSignature}`);
  }
  if (d.suggest.layers && d.suggest.layers.length > 0) lines.push(`  Legal route: ${d.suggest.layers.join(" -> ")}`);
  lines.push(`  Suggested: ${d.suggest.explanation}`, style.dim(`  Identity: ${d.identity}`));
  return lines;
}

export function formatValidation(report: ValidationReport, style: Style): string {
  const { counts } = report;
  const verdict = report.outcome === "pass" ? style.green(style.bold("PASS")) : style.red(style.bold("FAIL"));
  const scope = report.scope.mode === "full" ? "full repository" : `${plural(report.scope.changedFiles.length, "changed file")}`;
  const out = [
    `EngIntel validate: ${verdict} (${plural(counts.errors, "error")}, ${plural(counts.warnings, "warning")}, ${plural(counts.advisories, "advisory", "advisories")})`,
    `Contract: ${report.contract.file} (policy ${report.contract.policyVersion}, ${report.contract.status})`,
    `Scope: ${scope}; ${plural(report.stats.filesInScope, "file")} and ${plural(report.stats.edgesEvaluated, "dependency", "dependencies")} checked`,
  ];
  // Blocking findings first, then the rest, each in report order.
  const ordered = [...report.diagnostics.filter((d) => d.blocking), ...report.diagnostics.filter((d) => !d.blocking)];
  for (const d of ordered) out.push("", ...formatDiagnostic(d, style));
  if (report.exceptionsApplied.length > 0) {
    out.push("", `Exceptions applied: ${report.exceptionsApplied.length}`);
    for (const e of report.exceptionsApplied) out.push(`  ${e.exceptionId}: ${e.source} -> ${e.target} (${e.ruleId}, expires ${e.expiresAt})`);
  }
  const allowlisted = report.unanalyzable.filter((u) => u.allowlisted);
  if (allowlisted.length > 0) {
    out.push("", "Unanalyzable but allowlisted (unsupportedPaths):");
    for (const u of allowlisted) out.push(`  ${u.path} (${u.reason})`);
  }
  return `${out.join("\n")}\n`;
}

export function formatAnalysis(report: AnalysisReport, style: Style): string {
  const { files } = report.repository;
  const g = report.graph;
  const out = [
    style.bold("EngIntel analyze"),
    `Files: ${files.total} (${files.source} source: ${files.ok} ok, ${files.unreadable} unreadable, ${files.ignored} ignored; ${files.other} other)`,
    `Tree: sha256 ${report.repository.treeHash}`,
    `Graph: ${plural(g.modules, "module")}, ${plural(g.edges, "dependency", "dependencies")}, ${g.external} external, ${g.core} core, ${g.unresolved} unresolved, ${plural(g.cycles, "cycle")}`,
  ];
  if (g.file) out.push(`Cached: ${g.file}`);
  if (report.contract) {
    out.push(`Contract: ${report.contract.file} (policy ${report.contract.policyVersion}, ${report.contract.status})`, "Layers:");
    const width = Math.max(...report.layers.map((l) => l.id.length), 10);
    for (const l of report.layers) out.push(`  ${l.id.padEnd(width)}  ${l.files}`);
    out.push(`  ${"(unlayered)".padEnd(width)}  ${report.unlayered}`);
  }
  if (report.unanalyzable.length > 0) {
    out.push("Unanalyzable:");
    for (const u of report.unanalyzable) out.push(`  ${u.path} (${u.reason})`);
  } else {
    out.push("Unanalyzable: none");
  }
  return `${out.join("\n")}\n`;
}

export function formatError(error: ToolError): string {
  const lines = [`engintel: error ${error.code}: ${error.message}`];
  for (const issue of error.issues.slice(0, 20)) lines.push(`  ${issue.path || "(root)"}: ${issue.message}`);
  if (error.issues.length > 20) lines.push(`  ... and ${error.issues.length - 20} more`);
  return `${lines.join("\n")}\n`;
}
