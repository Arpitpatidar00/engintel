// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { resolve } from "node:path";
import {
  BASELINE_IDENTITY_VERSION,
  BASELINE_PATH,
  BASELINE_SCHEMA_VERSION,
  loadBaseline,
  loadContract,
  parseBaseline,
  serializeBaseline,
  type BaselineEntry,
  type BaselineFile,
} from "@engintel/config";
import { BASELINE_FORBIDDEN_RULES, baselineCandidates, checkBaselineIntegrity, evaluate } from "@engintel/policy";
import { ToolError, toToolError } from "./errors.js";
import { analyzeTree, writeInsideEngintel, type PipelineOptions } from "./pipeline.js";

/**
 * Writing the baseline (ENG-009, ENG-038; research doc 08, sections 6 and 8).
 * Always a full-scope evaluation of the working tree, independent of any
 * existing baseline. Only blocking, baseline-eligible findings are recorded.
 * Fail-closed findings (unanalyzable files, opaque or unresolved imports,
 * overlapping layers) are refused outright: they must be fixed or allowlisted
 * in the contract, never stamped away. The result is deterministic for a
 * given tree, clock, and author.
 */

export interface BaselineWriteOptions extends PipelineOptions {
  /** "write" records every current finding; "prune" only drops entries that no longer occur. */
  readonly mode: "write" | "prune";
  /** GitHub login of the human owner writing the baseline. Agents and bots are refused. */
  readonly writtenBy: string;
  /** UTC date YYYY-MM-DD for writtenAt, firstSeenAt of new entries, and lastSeenAt. */
  readonly now: string;
  readonly notes?: string;
  /** For tests of draft contracts only; the CLI never sets it. */
  readonly allowDraft?: boolean;
}

export interface BaselineWriteResult {
  readonly baseline: BaselineFile;
  /** The canonical file content. */
  readonly text: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly kept: readonly string[];
  /** Entry counts per rule, most first: for owners reviewing a first baseline. */
  readonly byRule: readonly { readonly ruleId: string; readonly entries: number }[];
}

export async function buildBaseline(options: BaselineWriteOptions): Promise<BaselineWriteResult> {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.now) || Number.isNaN(Date.parse(options.now))) {
      throw new ToolError("E_USAGE", `now must be a UTC date (YYYY-MM-DD), got "${options.now}"`);
    }
    const root = resolve(options.root);
    const loaded = loadContract(root);
    if (loaded.contract.status !== "active" && !options.allowDraft) {
      throw new ToolError("E_CONTRACT_DRAFT", `${loaded.file} is a draft; baselines are written against an active contract.`, { file: loaded.file });
    }
    const existing = loadBaseline(root);
    if (existing) {
      const issues = checkBaselineIntegrity(existing.baseline);
      if (issues.length > 0) throw new ToolError("E_BASELINE_INVALID", `${existing.file} failed its integrity check`, { file: existing.file, issues });
    }
    const { graph, files, facts } = await analyzeTree(options);
    const result = evaluate({ contract: loaded.contract, graph, files, facts, scope: { mode: "full" }, now: options.now });

    const refused = result.findings.filter((f) => f.blocking && BASELINE_FORBIDDEN_RULES.has(f.ruleId));
    if (refused.length > 0) {
      throw new ToolError(
        "E_BASELINE_FORBIDDEN",
        `refusing to write a baseline: ${refused.length} fail-closed finding${refused.length === 1 ? "" : "s"} can never be baselined. Fix them, or allowlist unreadable files in the contract's unsupportedPaths.`,
        { issues: refused.map((f) => ({ path: f.source, message: f.ruleId })) },
      );
    }

    const previous = new Map((existing?.baseline.entries ?? []).map((e) => [e.identity, e]));
    const current = baselineCandidates(result);
    const currentIds = new Set(current.map((f) => f.identity));
    let entries: BaselineEntry[];
    if (options.mode === "write") {
      entries = current.map((f) => {
        const before = previous.get(f.identity);
        return {
          identity: f.identity,
          ruleId: f.ruleId,
          source: f.source,
          target: f.target,
          cycleSignature: f.cycleSignature,
          firstSeenAt: before?.firstSeenAt ?? options.now,
          lastSeenAt: options.now,
          ...(before?.owner ? { owner: before.owner } : {}),
          ...(before?.ticket ? { ticket: before.ticket } : {}),
          ...(before?.justification ? { justification: before.justification } : {}),
        };
      });
    } else {
      entries = [...previous.values()].filter((e) => currentIds.has(e.identity));
    }

    const notes = options.notes ?? existing?.baseline.notes;
    const draft = {
      schemaVersion: BASELINE_SCHEMA_VERSION,
      engineIdentityVersion: BASELINE_IDENTITY_VERSION,
      policyVersionAtWrite: loaded.contract.policyVersion,
      writtenAt: options.now,
      writtenBy: options.writtenBy,
      ...(notes ? { notes } : {}),
      entries,
    };
    // Validates writtenBy (no agents or bots) and every entry.
    const baseline = parseBaseline(draft, BASELINE_PATH).baseline;
    const ids = new Set(baseline.entries.map((e) => e.identity));
    const sorted = (xs: Iterable<string>) => [...xs].sort();
    const counts = new Map<string, number>();
    for (const e of baseline.entries) counts.set(e.ruleId, (counts.get(e.ruleId) ?? 0) + 1);
    return {
      baseline,
      text: serializeBaseline(baseline),
      added: sorted([...ids].filter((id) => !previous.has(id))),
      removed: sorted([...previous.keys()].filter((id) => !ids.has(id))),
      kept: sorted([...ids].filter((id) => previous.has(id))),
      byRule: [...counts].map(([ruleId, n]) => ({ ruleId, entries: n })).sort((a, b) => b.entries - a.entries || (a.ruleId < b.ruleId ? -1 : 1)),
    };
  } catch (error) {
    throw toToolError(error);
  }
}

/** Build and write `.engintel/baseline.json` (inside .engintel/, atomically). */
export async function writeBaseline(options: BaselineWriteOptions): Promise<BaselineWriteResult> {
  const built = await buildBaseline(options);
  try {
    writeInsideEngintel(resolve(options.root), BASELINE_PATH, built.text);
  } catch (error) {
    throw toToolError(error);
  }
  return built;
}
