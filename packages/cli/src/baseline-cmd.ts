// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { resolve } from "node:path";
import { ToolError, buildBaseline, inspectBaseline, writeBaseline, type BaselineSummary, type BaselineWriteResult } from "@engintel/orchestrator";
import { Option, type Command } from "commander";
import type { CliIO } from "./io.js";

/**
 * `engintel baseline` (ENG-038; research doc 08, section 6). The baseline is
 * human-owned policy: writing it needs a named human author, an explicit
 * --yes, and is refused in CI unless a human-triggered workflow opts in with
 * ENGINTEL_ALLOW_BASELINE_WRITE=1. Writing only changes the working tree; the
 * result still goes through a pull request and CODEOWNERS review.
 */

export interface BaselineCommandContext {
  readonly io: CliIO;
  readonly fail: (command: string, format: "human" | "json", error: unknown) => number;
  readonly setExitCode: (code: number) => void;
}

const truthy = (value: string | undefined) => value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";

/** BD-7: in CI, only an explicitly opted-in (human-triggered) workflow may write the baseline. */
export function assertBaselineWriteAllowed(env: Readonly<Record<string, string | undefined>>): void {
  if (truthy(env["CI"]) && env["ENGINTEL_ALLOW_BASELINE_WRITE"] !== "1") {
    throw new ToolError(
      "E_BASELINE_WRITE_IN_CI",
      "refusing to write the baseline in CI. Baselines are written by a human, locally or from a manually triggered workflow that sets ENGINTEL_ALLOW_BASELINE_WRITE=1.",
    );
  }
}

function formatSummary(s: BaselineSummary): string {
  if (!s.present) return `No baseline: ${s.file} does not exist. Every violation counts as new.\n`;
  const lines = [
    `Baseline: ${s.file}`,
    `Entries: ${s.entries}, written by ${s.writtenBy} on ${s.writtenAt} (policy ${s.policyVersionAtWrite})`,
    `Oldest entry first seen: ${s.oldestFirstSeenAt ?? "n/a"}`,
    "By rule:",
    ...s.byRule.map((r) => `  ${String(r.entries).padStart(6)}  ${r.ruleId}`),
    s.issues.length === 0 ? "Integrity: ok" : `Integrity: ${s.issues.length} problem${s.issues.length === 1 ? "" : "s"}`,
    ...s.issues.map((i) => `  ${i.path}: ${i.message}`),
  ];
  return `${lines.join("\n")}\n`;
}

function formatWrite(r: BaselineWriteResult, mode: "write" | "prune", written: boolean): string {
  const lines = [
    `${written ? "Wrote" : "Would write"} .engintel/baseline.json (${mode}): ${r.baseline.entries.length} entries`,
    `  added ${r.added.length}, removed ${r.removed.length}, unchanged ${r.kept.length}`,
  ];
  if (r.byRule.length > 0) {
    lines.push("Top rules (review a sample of each before committing):");
    for (const rule of r.byRule.slice(0, 20)) lines.push(`  ${String(rule.entries).padStart(6)}  ${rule.ruleId}`);
  }
  lines.push(
    written
      ? "Next: commit it in its own pull request; architecture owners review it (CODEOWNERS)."
      : "Dry run: nothing was written. Re-run with --yes to write the file.",
  );
  return `${lines.join("\n")}\n`;
}

export function registerBaseline(program: Command, ctx: BaselineCommandContext): void {
  const { io } = ctx;
  const format = () => new Option("--format <format>", "output format").choices(["human", "json"]).default("human");
  const group = program.command("baseline").description("inspect or rewrite .engintel/baseline.json (existing architecture debt)");

  group
    .command("show")
    .description("summarize the baseline and check its integrity")
    .option("--root <dir>", "repository root", ".")
    .addOption(format())
    .action((options: { root: string; format: "human" | "json" }) => {
      try {
        const summary = inspectBaseline(resolve(io.cwd, options.root));
        io.stdout.write(options.format === "json" ? `${JSON.stringify(summary, null, 2)}\n` : formatSummary(summary));
        ctx.setExitCode(summary.issues.length > 0 ? 2 : 0);
      } catch (error) {
        ctx.setExitCode(ctx.fail("baseline show", options.format, error));
      }
    });

  group
    .command("check")
    .description("verify every entry's identity against its fields (exit 0 ok, 2 invalid)")
    .option("--root <dir>", "repository root", ".")
    .action((options: { root: string }) => {
      try {
        const summary = inspectBaseline(resolve(io.cwd, options.root));
        if (summary.issues.length > 0) {
          throw new ToolError("E_BASELINE_INVALID", `${summary.file} failed its integrity check`, { file: summary.file, issues: summary.issues });
        }
        io.stdout.write(summary.present ? `${summary.file}: ${summary.entries} entries, integrity ok\n` : `${summary.file}: not present\n`);
        ctx.setExitCode(0);
      } catch (error) {
        ctx.setExitCode(ctx.fail("baseline check", "human", error));
      }
    });

  for (const mode of ["write", "prune"] as const) {
    group
      .command(mode)
      .description(
        mode === "write"
          ? "record every current violation as existing debt (full scope; a dry run unless --yes)"
          : "drop entries whose violation no longer occurs (a dry run unless --yes)",
      )
      .requiredOption("--written-by <login>", "GitHub login of the human owner writing it")
      .option("--root <dir>", "repository root", ".")
      .option("--now <date>", "UTC date (YYYY-MM-DD); default today")
      .option("--notes <text>", "free-text note stored in the file")
      .option("--yes", "actually write the file")
      .addOption(format())
      .action(async (options: { root: string; writtenBy: string; now?: string; notes?: string; yes?: boolean; format: "human" | "json" }) => {
        try {
          const request = {
            root: resolve(io.cwd, options.root),
            mode,
            writtenBy: options.writtenBy,
            now: options.now ?? io.today(),
            ...(options.notes ? { notes: options.notes } : {}),
          };
          if (options.yes) assertBaselineWriteAllowed(io.env);
          const result = options.yes ? await writeBaseline(request) : await buildBaseline(request);
          io.stdout.write(
            options.format === "json"
              ? `${JSON.stringify({ written: Boolean(options.yes), mode, entries: result.baseline.entries.length, added: result.added, removed: result.removed, kept: result.kept.length, byRule: result.byRule }, null, 2)}\n`
              : formatWrite(result, mode, Boolean(options.yes)),
          );
          ctx.setExitCode(0);
        } catch (error) {
          ctx.setExitCode(ctx.fail(`baseline ${mode}`, options.format, error));
        }
      });
  }
}
