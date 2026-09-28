// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Diagnostic } from "@engintel/config";
import type { ValidationReport } from "@engintel/orchestrator";
import { goldenRoot, runCli } from "@engintel/testkit";
import type { Log } from "sarif";
import { afterEach, describe, expect, test } from "vitest";
import { toMarkdown, toSarif, toUri } from "../src/index.js";

/**
 * ENG-039. The SARIF output was validated against the official SARIF 2.1.0
 * JSON Schema during development; these tests pin the properties GitHub code
 * scanning relies on, plus our own guarantees (no source text, stable
 * fingerprints, relative URIs).
 */

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyOf(id: string): string {
  const dir = mkdtempSync(join(tmpdir(), `engintel-sarif-${id}-`));
  created.push(dir);
  cpSync(join(goldenRoot(), id, "repo"), dir, { recursive: true });
  return dir;
}

async function sarifOf(id: string): Promise<{ log: Log; exitCode: number }> {
  const r = await runCli(["validate", "--format", "sarif", "--now", "2026-09-01"], { cwd: copyOf(id) });
  return { log: JSON.parse(r.stdout) as Log, exitCode: r.exitCode };
}

describe("SARIF 2.1.0 (ENG-039)", () => {
  test("the shape GitHub code scanning requires", async () => {
    const { log, exitCode } = await sarifOf("invalid-layer");
    expect(exitCode).toBe(1);
    expect(log.version).toBe("2.1.0");
    expect(log.$schema).toBe("https://json.schemastore.org/sarif-2.1.0.json");
    expect(log.runs).toHaveLength(1);
    const run = log.runs[0];
    expect(run?.tool.driver).toMatchObject({ name: "EngIntel", semanticVersion: "0.1.0" });
    const ruleIds = run?.tool.driver.rules?.map((r) => r.id);
    expect(ruleIds).toEqual(["no-controller-to-repository"]);
    expect(run?.results).toHaveLength(2);
    for (const result of run?.results ?? []) {
      expect(ruleIds?.[result.ruleIndex ?? -1]).toBe(result.ruleId);
      expect(result.level).toBe("error");
      expect(result.message.text).toMatch(/^Forbidden dependency/);
      const location = result.locations?.[0]?.physicalLocation;
      expect(location?.artifactLocation?.uriBaseId).toBe("%SRCROOT%");
      expect(location?.artifactLocation?.uri).toMatch(/^src\/controllers\/[a-z.]+\.ts$/);
      expect(location?.region?.startLine).toBeGreaterThanOrEqual(1);
      expect(result.partialFingerprints?.["engintelIdentity/v1"]).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("never carries source text", async () => {
    const { log } = await sarifOf("prompt-injection");
    const text = JSON.stringify(log);
    expect(text).not.toContain("snippet");
    expect(text).not.toMatch(/SYSTEM OVERRIDE|approved: true|ignore previous/i);
  });

  test("file-less findings anchor to the contract; levels map warning and advisory", () => {
    const base: Diagnostic = {
      schemaVersion: 1,
      identity: "a".repeat(64),
      adapter: "analyzer",
      ruleId: "engintel.unanalyzable",
      severity: "error",
      blocking: true,
      file: null,
      message: "m",
      why: "w",
      suggest: { kind: "none", explanation: "e" },
    };
    const report = {
      outcome: "fail",
      exitCode: 1,
      engineVersion: "0.1.0",
      diagnostics: [base, { ...base, identity: "b".repeat(64), severity: "warning", blocking: false, ruleId: "r1", file: "src/a b.ts" }, { ...base, identity: "c".repeat(64), severity: "advisory", blocking: false, ruleId: "r2" }],
    } as unknown as ValidationReport;
    const results = toSarif(report).runs[0]?.results ?? [];
    expect(results.map((r) => [r.level, r.locations?.[0]?.physicalLocation?.artifactLocation?.uri])).toEqual([
      ["error", ".engintel/architecture.json"],
      ["warning", "src/a%20b.ts"],
      ["note", ".engintel/architecture.json"],
    ]);
    expect(toUri("src/ünï/[x].ts")).toBe("src/%C3%BCn%C3%AF/%5Bx%5D.ts");
  });

  test("a run with no verdict is an unsuccessful invocation with no results", async () => {
    const root = copyOf("valid-architecture");
    writeFileSync(join(root, ".engintel/architecture.json"), "{");
    const r = await runCli(["validate", "--format", "sarif"], { cwd: root });
    expect(r.exitCode).toBe(2);
    const run = (JSON.parse(r.stdout) as Log).runs[0];
    expect(run?.results).toEqual([]);
    expect(run?.invocations?.[0]).toMatchObject({ executionSuccessful: false, exitCode: 2 });
    expect(run?.invocations?.[0]?.toolExecutionNotifications?.[0]?.message.text).toMatch(/^E_CONTRACT_INVALID: /);
  });
});

describe("engintel report", () => {
  test("renders a saved JSON report as SARIF, Markdown, or human text without re-analyzing", async () => {
    const root = copyOf("invalid-layer");
    const json = await runCli(["validate", "--format", "json", "--now", "2026-09-01"], { cwd: root });
    const sarif = await runCli(["validate", "--format", "sarif", "--now", "2026-09-01"], { cwd: root });
    const human = await runCli(["validate", "--now", "2026-09-01"], { cwd: root });
    const saved = join(root, "..", `${root.split("/").pop()}-report.json`);
    created.push(saved);
    writeFileSync(saved, json.stdout);
    rmSync(join(root, "src"), { recursive: true });
    expect((await runCli(["report", saved, "--format", "sarif"], { cwd: root })).stdout).toBe(sarif.stdout);
    expect((await runCli(["report", saved], { cwd: root })).stdout).toBe(human.stdout);
    const md = await runCli(["report", saved, "--format", "markdown"], { cwd: root });
    expect(md.exitCode).toBe(0);
    expect(md.stdout).toContain("## EngIntel: FAIL");
    expect(md.stdout).toContain("| error | `no-controller-to-repository` | `src/controllers/audit.controller.ts:1` |");
  });

  test("refuses files that are not EngIntel reports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engintel-report-"));
    created.push(dir);
    writeFileSync(join(dir, "x.json"), JSON.stringify({ hello: "world" }));
    expect(await runCli(["report", "x.json"], { cwd: dir })).toMatchObject({ exitCode: 2, errorCode: "E_REPORT_INVALID" });
    expect(await runCli(["report", "missing.json"], { cwd: dir })).toMatchObject({ exitCode: 2, errorCode: "E_REPORT_INVALID" });
  });
});

describe("Markdown summary", () => {
  test("escapes table cells and caps the table at 50 rows", () => {
    const d = (i: number): Diagnostic => ({
      schemaVersion: 1,
      identity: i.toString(16).padStart(64, "0"),
      adapter: "architecture",
      ruleId: "rule",
      severity: "error",
      blocking: true,
      file: `src/f${i}.ts`,
      message: "a | b <script>",
      why: "w",
      suggest: { kind: "none", explanation: "e" },
    });
    const report = {
      outcome: "fail",
      scope: { mode: "full" },
      git: null,
      baseline: null,
      policyChange: null,
      counts: { errors: 60, warnings: 0, advisories: 0, suppressedByException: 0, suppressedByBaseline: 0, unanalyzable: 0 },
      diagnostics: Array.from({ length: 60 }, (_, i) => d(i)),
    } as unknown as ValidationReport;
    const md = toMarkdown(report);
    expect(md.match(/^\| error \|/gm)).toHaveLength(50);
    expect(md).toContain("a \\| b &lt;script&gt;");
    expect(md).toContain("... and 10 more.");
  });
});
