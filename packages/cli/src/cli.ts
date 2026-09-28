// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ENGINE_VERSION,
  REPORT_SCHEMA_VERSION,
  analyzeRepository,
  serializeReport,
  ToolError,
  toToolError,
  validateRepository,
  type ErrorReport,
  type ValidationReport,
} from "@engintel/orchestrator";
import { Command, CommanderError, Option } from "commander";
import { registerBaseline } from "./baseline-cmd.js";
import type { CliIO } from "./io.js";
import { COLOR, PLAIN, formatAnalysis, formatError, formatValidation, type Style } from "./human.js";
import { toMarkdown } from "./markdown.js";
import { serializeSarif, toSarif } from "./sarif.js";

/**
 * The `engintel` command line (ENG-008; research doc 17). The same entry
 * point GitHub Actions will call. Results go to stdout, logs and errors to
 * stderr. Exit codes (Phase 1): 0 pass, 1 blocking violations, 2 tool,
 * configuration, contract, or usage error. Nothing here reads repository
 * code as instructions, and nothing is written outside .engintel/.
 */

type Format = "human" | "json" | "sarif" | "markdown";

interface CommonOptions {
  readonly root: string;
  readonly format: Format;
}

function formatOption(choices: readonly Format[] = ["human", "json"]): Option {
  return new Option("--format <format>", "output format").choices([...choices]).default("human");
}

/** Render a validation or error report in any output format. */
function render(report: ValidationReport | ErrorReport, format: Format, style: Style): string {
  if (format === "json") return serializeReport(report);
  if (format === "sarif") return serializeSarif(toSarif(report));
  if (format === "markdown") return toMarkdown(report);
  return report.outcome === "error" ? "" : formatValidation(report, style);
}

export async function main(argv: readonly string[], io: CliIO): Promise<number> {
  const style = io.stdout.isTTY && !io.env["NO_COLOR"] && io.env["TERM"] !== "dumb" ? COLOR : PLAIN;
  let exitCode = 0;

  const fail = (command: string, format: Format, error: unknown): number => {
    const toolError = toToolError(error);
    if (format !== "human") {
      const report: ErrorReport = {
        schemaVersion: REPORT_SCHEMA_VERSION,
        command,
        engineVersion: ENGINE_VERSION,
        outcome: "error",
        exitCode: 2,
        error: { code: toolError.code, message: toolError.message, file: toolError.file, issues: toolError.issues },
      };
      io.stdout.write(render(report, format, style));
    }
    io.stderr.write(formatError(toolError));
    return 2;
  };

  const notices = (lines: readonly string[]) => {
    for (const line of lines) io.stderr.write(`engintel: note: ${line}\n`);
  };

  const validate = async (
    options: CommonOptions & {
      readonly now?: string;
      readonly changed?: boolean;
      readonly base?: string;
      readonly policyChangeApproved?: boolean;
      readonly baselineChangeApproved?: boolean;
      readonly cache?: boolean;
      readonly verbose?: boolean;
    },
  ) => {
    try {
      const changedSince = options.changed || options.base !== undefined ? (options.base ?? defaultBase(io.env)) : undefined;
      const report = await validateRepository({
        root: resolve(io.cwd, options.root),
        now: options.now ?? io.today(),
        ...(changedSince === undefined ? {} : { changedSince }),
        approvals: { policyChange: options.policyChangeApproved ?? false, baselineChange: options.baselineChangeApproved ?? false },
        graphCache: options.cache ?? true,
        ...(options.verbose ? { log: (line: string) => io.stderr.write(`engintel: ${line}\n`) } : {}),
      });
      io.stdout.write(render(report, options.format, style));
      notices(report.notices);
      exitCode = report.exitCode;
    } catch (error) {
      exitCode = fail("validate", options.format, error);
    }
  };

  const program = new Command()
    .name("engintel")
    .description("Deterministic architecture validation for JavaScript and TypeScript repositories.")
    .version(ENGINE_VERSION, "--version", "print the engine version")
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.stdout.write(s), writeErr: (s) => io.stderr.write(s) });

  const addValidate = (command: Command) =>
    command
      .description("validate the repository against .engintel/architecture.json (exit 0 pass, 1 violations, 2 error)")
      .option("--root <dir>", "repository root", ".")
      .addOption(formatOption(["human", "json", "sarif", "markdown"]))
      .option("--now <date>", "UTC date (YYYY-MM-DD) for exception expiry; default today")
      .option("--changed", "check only what changed since the merge base with --base")
      .option("--base <ref>", "git ref to diff against (implies --changed); default origin/$GITHUB_BASE_REF, else origin/HEAD")
      .option("--policy-change-approved", "architecture owners approved weakening .engintel policy in this change (set by CI from a label)")
      .option("--baseline-change-approved", "architecture owners approved growing the baseline in this change (set by CI from a label)")
      .option("--no-cache", "do not reuse or update .engintel/cache/graph-cache.json")
      .option("--verbose", "log cache statistics to stderr")
      .action(validate);

  addValidate(program.command("validate"));
  addValidate(program.command("architecture").description("architecture commands").command("validate"));

  program
    .command("analyze")
    .description("build the module graph and summarize the repository; enforces nothing")
    .option("--root <dir>", "repository root", ".")
    .addOption(formatOption())
    .option("--no-cache", "do not use or write .engintel/cache/")
    .action(async (options: CommonOptions & { readonly cache: boolean }) => {
      try {
        const report = await analyzeRepository({ root: resolve(io.cwd, options.root), writeCache: options.cache });
        io.stdout.write(options.format === "json" ? serializeReport(report) : formatAnalysis(report, style));
        notices(report.notices);
        exitCode = 0;
      } catch (error) {
        exitCode = fail("analyze", options.format, error);
      }
    });

  program
    .command("report")
    .description("render a saved JSON report (from validate --format json) in another format, without re-analyzing")
    .argument("<file>", "path of the saved JSON report")
    .addOption(formatOption(["human", "json", "sarif", "markdown"]))
    .action((file: string, options: { readonly format: Format }) => {
      try {
        const report = readSavedReport(resolve(io.cwd, file));
        io.stdout.write(report.outcome === "error" && options.format === "human" ? formatError(new ToolError(report.error.code, report.error.message)) : render(report, options.format, style));
        exitCode = 0;
      } catch (error) {
        exitCode = fail("report", "human", error);
      }
    });

  registerBaseline(program, { io, fail, setExitCode: (code) => (exitCode = code) });

  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.code === "commander.helpDisplayed" || error.code === "commander.version" ? 0 : 2;
    }
    return fail("engintel", "human", error);
  }
  return exitCode;
}

/** The base ref for --changed: the pull request's base branch in GitHub Actions, else the remote's default branch. */
export function defaultBase(env: Readonly<Record<string, string | undefined>>): string {
  const pr = env["GITHUB_BASE_REF"];
  return pr ? `origin/${pr}` : "origin/HEAD";
}

/** A report written by `validate --format json`: checked for shape before it is rendered. */
export function readSavedReport(path: string): ValidationReport | ErrorReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ToolError("E_REPORT_INVALID", `cannot read a JSON report from ${path}: ${(error as Error).message}`);
  }
  const r = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const current = r["schemaVersion"] === REPORT_SCHEMA_VERSION;
  const isValidation = current && r["command"] === "validate" && (r["outcome"] === "pass" || r["outcome"] === "fail") && Array.isArray(r["diagnostics"]);
  const error = r["error"] as Record<string, unknown> | undefined;
  const isError = current && r["outcome"] === "error" && typeof error?.["code"] === "string";
  if (!isValidation && !isError) throw new ToolError("E_REPORT_INVALID", `${path} is not an EngIntel validate report (schemaVersion ${REPORT_SCHEMA_VERSION})`);
  return parsed as ValidationReport | ErrorReport;
}

export function todayUtc(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
