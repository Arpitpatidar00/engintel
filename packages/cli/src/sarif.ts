// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import type { Diagnostic } from "@engintel/config";
import type { ErrorReport, ValidationReport } from "@engintel/orchestrator";
import type { Log, ReportingDescriptor, Result } from "sarif";

/**
 * SARIF 2.1.0 reporter (ENG-039) for GitHub code scanning and annotations.
 *
 * Paths are relative URIs against %SRCROOT%. Results carry no source text
 * (no snippets, ever), and each one's EngIntel identity is its partial
 * fingerprint, so an alert keeps its identity across line moves exactly as
 * the baseline does. Findings without a file (project-level) are anchored to
 * the contract file, because code scanning needs a location.
 */

export const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
const INFORMATION_URI = "https://github.com/Arpitpatidar00/engintel";
const ANCHOR = ".engintel/architecture.json";

const LEVEL: Record<Diagnostic["severity"], Result.level> = { error: "error", warning: "warning", info: "note", advisory: "note" };

/** Percent-encode each path segment; keep "/" as the separator. */
export function toUri(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function ruleDescription(ruleId: string): string {
  if (ruleId === "engintel.unanalyzable") return "A file EngIntel cannot read or parse fails closed.";
  if (ruleId === "engintel.opaque-import") return "An import whose module name is computed at runtime cannot be checked.";
  if (ruleId === "engintel.unresolved-import") return "An import that does not resolve cannot be checked.";
  if (ruleId === "engintel.overlapping-layers") return "A file belongs to more than one layer.";
  if (ruleId === "engintel.intra-layer") return "Files in a layer with intraAllowed false import each other.";
  if (ruleId === "engintel.unlayered") return "A file belongs to no layer.";
  if (ruleId === "engintel.policy-weakening") return "A change weakens the architecture policy and needs owners' approval.";
  if (ruleId === "engintel.policy-change") return "A change tightens the architecture policy.";
  if (ruleId === "engintel.baseline-drop") return "A baseline entry is removed while its violation still exists.";
  return `Architecture contract rule '${ruleId}'.`;
}

function driver(engineVersion: string, rules: ReportingDescriptor[]) {
  return { name: "EngIntel", semanticVersion: engineVersion, informationUri: INFORMATION_URI, rules };
}

export function toSarif(report: ValidationReport | ErrorReport): Log {
  if (report.outcome === "error") {
    return {
      $schema: SARIF_SCHEMA,
      version: "2.1.0",
      runs: [
        {
          tool: { driver: driver(report.engineVersion, []) },
          invocations: [
            {
              executionSuccessful: false,
              exitCode: 2,
              toolExecutionNotifications: [{ level: "error", message: { text: `${report.error.code}: ${report.error.message}` } }],
            },
          ],
          results: [],
        },
      ],
    };
  }

  const ruleIds = [...new Set(report.diagnostics.map((d) => d.ruleId))].sort();
  const rules: ReportingDescriptor[] = ruleIds.map((id) => {
    const levels = report.diagnostics.filter((d) => d.ruleId === id).map((d) => LEVEL[d.severity]);
    const level = levels.includes("error") ? "error" : levels.includes("warning") ? "warning" : "note";
    return { id, name: id, shortDescription: { text: ruleDescription(id) }, defaultConfiguration: { level } };
  });
  const results: Result[] = report.diagnostics.map((d) => {
    const suggestion = d.suggest.explanation;
    const dependency = d.edge ? `\n\nDependency: ${d.edge.source} -> ${d.edge.target} (${d.edge.kind})` : d.cycleSignature ? `\n\nCycle: ${d.cycleSignature}` : "";
    return {
      ruleId: d.ruleId,
      ruleIndex: ruleIds.indexOf(d.ruleId),
      level: LEVEL[d.severity],
      message: { text: `${d.message}\n\nWhy: ${d.why}${dependency}\n\nSuggested: ${suggestion}` },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: toUri(d.file ?? ANCHOR), uriBaseId: "%SRCROOT%" },
            region: { startLine: d.range?.start.line ?? 1, startColumn: d.range?.start.column ?? 1 },
          },
        },
      ],
      partialFingerprints: { "engintelIdentity/v1": d.identity },
      properties: {
        blocking: d.blocking,
        adapter: d.adapter,
        ...(d.edge ? { edge: d.edge } : {}),
        ...(d.cycleSignature ? { cycleSignature: d.cycleSignature } : {}),
        suggest: d.suggest,
      },
    };
  });
  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: { driver: driver(report.engineVersion, rules) },
        automationDetails: { id: "engintel/validate/" },
        invocations: [{ executionSuccessful: true, exitCode: report.exitCode }],
        results,
      },
    ],
  };
}

export function serializeSarif(log: Log): string {
  return `${JSON.stringify(log, null, 2)}\n`;
}
