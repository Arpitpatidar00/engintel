// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import type { ErrorReport, ValidationReport } from "@engintel/orchestrator";

/**
 * Markdown summary for a GitHub job summary or pull request comment
 * (research doc 16, section 6). Built from the report only: rule ids, paths,
 * and EngIntel's own messages, never source text. At most 50 findings.
 */

const MAX_ROWS = 50;

/** Markdown-escape text that goes into a table cell. */
function cell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;")).replace(/\r?\n/g, " ");
}

export function toMarkdown(report: ValidationReport | ErrorReport): string {
  if (report.outcome === "error") {
    return `## EngIntel: no verdict (exit 2)\n\n\`${report.error.code}\`: ${cell(report.error.message)}\n\nThe check cannot pass until this is fixed. It fails closed.\n`;
  }
  const c = report.counts;
  const verdict = report.outcome === "pass" ? "PASS" : "FAIL";
  const scope =
    report.scope.mode === "full"
      ? "full repository"
      : `${report.scope.changedFiles.length} changed file${report.scope.changedFiles.length === 1 ? "" : "s"}${report.git ? ` since the merge base with \`${cell(report.git.base)}\`` : ""}`;
  const lines = [
    `## EngIntel: ${verdict}`,
    "",
    `**${c.errors}** blocking error${c.errors === 1 ? "" : "s"}, ${c.warnings} warning${c.warnings === 1 ? "" : "s"}, ${c.advisories} advisor${c.advisories === 1 ? "y" : "ies"}. Scope: ${scope}.`,
  ];
  if (report.baseline) lines.push(`Baseline: ${report.baseline.suppressed} existing violation${report.baseline.suppressed === 1 ? "" : "s"} not counted (${report.baseline.entries} entries).`);
  if (c.suppressedByException > 0) lines.push(`Exceptions applied: ${c.suppressedByException}.`);
  const findings = [...report.diagnostics.filter((d) => d.blocking), ...report.diagnostics.filter((d) => !d.blocking)];
  if (findings.length > 0) {
    lines.push("", "| | Rule | Where | Finding |", "| --- | --- | --- | --- |");
    for (const d of findings.slice(0, MAX_ROWS)) {
      const where = d.file ? `\`${cell(d.file)}${d.range ? `:${d.range.start.line}` : ""}\`` : "(repository)";
      lines.push(`| ${d.blocking ? "error" : d.severity} | \`${cell(d.ruleId)}\` | ${where} | ${cell(d.message)} |`);
    }
    if (findings.length > MAX_ROWS) lines.push("", `... and ${findings.length - MAX_ROWS} more. The full list is in the SARIF and JSON reports.`);
  }
  const policy = report.policyChange?.items.filter((i) => i.class !== "neutral") ?? [];
  if (policy.length > 0) {
    lines.push("", "**Policy changes** (compared with the merge base):", "");
    for (const i of policy.slice(0, MAX_ROWS)) lines.push(`- ${i.class}: \`${cell(i.file)}\`: ${cell(i.summary)}`);
  }
  return `${lines.join("\n")}\n`;
}
