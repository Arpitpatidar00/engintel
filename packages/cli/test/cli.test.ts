// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagnosticSchema } from "@engintel/config";
import { goldenRoot, runCli } from "@engintel/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { defaultBase, main, todayUtc, type CliIO } from "../src/index.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyOf(id: string): string {
  const dir = mkdtempSync(join(tmpdir(), `engintel-cli-${id}-`));
  created.push(dir);
  cpSync(join(goldenRoot(), id, "repo"), dir, { recursive: true });
  return dir;
}

/** In-process run with captured streams. */
async function run(args: string[], options: { cwd?: string; tty?: boolean } = {}) {
  let stdout = "";
  let stderr = "";
  const io: CliIO = {
    stdout: { write: (s: string) => (stdout += s), isTTY: options.tty ?? false },
    stderr: { write: (s: string) => (stderr += s) },
    cwd: options.cwd ?? tmpdir(),
    env: {},
    today: () => "2026-09-01",
  };
  const exitCode = await main(args, io);
  return { exitCode, stdout, stderr };
}

describe("engintel validate (ENG-008 definition of done, end to end)", () => {
  test("exits 1 on invalid-layer", async () => {
    const r = await runCli(["validate", "--now", "2026-09-01"], { cwd: copyOf("invalid-layer") });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("EngIntel validate: FAIL (2 errors");
    expect(r.errorCode).toBeNull();
  });

  test("exits 0 on valid-architecture", async () => {
    const r = await runCli(["validate", "--now", "2026-09-01"], { cwd: copyOf("valid-architecture") });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("EngIntel validate: PASS");
  });

  test("exits 2 on a broken contract, with the error on stderr and nothing on stdout", async () => {
    const root = copyOf("valid-architecture");
    writeFileSync(join(root, ".engintel/architecture.json"), '{ "schemaVersion": 1, ');
    const r = await runCli(["validate"], { cwd: root });
    expect(r.exitCode).toBe(2);
    expect(r.errorCode).toBe("E_CONTRACT_INVALID");
    expect(r.stdout).toBe("");
  });

  test("exits 2 on a missing contract", async () => {
    const root = copyOf("valid-architecture");
    rmSync(join(root, ".engintel/architecture.json"));
    const r = await runCli(["validate"], { cwd: root });
    expect(r).toMatchObject({ exitCode: 2, errorCode: "E_CONTRACT_MISSING" });
  });

  test("exits 1 when a file cannot be read or parsed (fail closed)", async () => {
    const r = await runCli(["validate", "--format", "json", "--now", "2026-09-01"], { cwd: copyOf("unreadable-files") });
    expect(r.exitCode).toBe(1);
    const report = JSON.parse(r.stdout) as { diagnostics: { ruleId: string; file: string }[] };
    expect(report.diagnostics.map((d) => [d.ruleId, d.file])).toEqual([
      ["engintel.unanalyzable", "src/services/corrupt.service.ts"],
      ["engintel.unanalyzable", "src/services/truncated.service.ts"],
    ]);
  });

  test("two runs give byte-identical output and identities", async () => {
    const root = copyOf("invalid-layer");
    const first = await runCli(["validate", "--format", "json", "--now", "2026-09-01"], { cwd: root });
    const second = await runCli(["validate", "--format", "json", "--now", "2026-09-01"], { cwd: root });
    expect(second.stdout).toBe(first.stdout);
    const human1 = await runCli(["validate", "--now", "2026-09-01"], { cwd: root });
    const human2 = await runCli(["validate", "--now", "2026-09-01"], { cwd: root });
    expect(human2.stdout).toBe(human1.stdout);
  });

  test("the JSON report matches the golden expected.json for a full-scope scenario", async () => {
    const r = await runCli(["validate", "--format", "json", "--now", "2026-09-01"], { cwd: copyOf("circular") });
    const { engineVersion: _v, ...report } = JSON.parse(r.stdout) as Record<string, unknown>;
    const expected = JSON.parse(readFileSync(join(goldenRoot(), "circular", "expected.json"), "utf8")) as Record<string, unknown>;
    expect(report).toEqual(expected["full"]);
  });

  test("stderr never carries source text", async () => {
    const r = await runCli(["validate", "--now", "2026-09-01"], { cwd: copyOf("prompt-injection") });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("");
    expect(r.stdout).not.toMatch(/SYSTEM OVERRIDE|approved|ignore previous/i);
  });
});

describe("engintel validate --changed (ENG-010)", () => {
  const env = {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, ...env }, stdio: "ignore" });

  function pr(id: string): string {
    const root = copyOf(id);
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    git(root, "checkout", "-q", "-b", "pr");
    return root;
  }

  test("legacy debt outside the diff passes; a new violation in the diff fails", async () => {
    const root = pr("invalid-layer");
    const clean = await runCli(["validate", "--changed", "--base", "main"], { cwd: root });
    expect(clean.exitCode).toBe(0);
    expect(clean.stdout).toMatch(/Scope: 0 changed files since [0-9a-f]{12} \(merge base with main\)/);
    writeFileSync(join(root, "src/controllers/refund.controller.ts"), 'import { OrderRepository } from "../repositories/order.repository";\nexport const r = new OrderRepository();\n');
    const dirty = await runCli(["validate", "--base", "main", "--format", "json"], { cwd: root });
    expect(dirty.exitCode).toBe(1);
    expect((JSON.parse(dirty.stdout) as { diagnostics: { file: string }[] }).diagnostics.map((d) => d.file)).toEqual(["src/controllers/refund.controller.ts"]);
  });

  test("an unknown base is exit 2 with a hint", async () => {
    const r = await runCli(["validate", "--changed", "--base", "origin/nope"], { cwd: pr("valid-architecture") });
    expect(r).toMatchObject({ exitCode: 2, errorCode: "E_GIT_BAD_REF" });
    expect(r.stderr).toContain("git fetch origin nope");
  });

  test("the default base follows the pull request in GitHub Actions", () => {
    expect(defaultBase({ GITHUB_BASE_REF: "main" })).toBe("origin/main");
    expect(defaultBase({})).toBe("origin/HEAD");
  });
});

describe("reporters (ENG-033)", () => {
  test("JSON: results on stdout, every diagnostic matches the shared schema", async () => {
    const r = await run(["validate", "--format", "json"], { cwd: copyOf("unresolved") });
    const report = JSON.parse(r.stdout) as { schemaVersion: number; outcome: string; diagnostics: unknown[] };
    expect(report).toMatchObject({ schemaVersion: 1, outcome: "fail" });
    for (const d of report.diagnostics) expect(DiagnosticSchema.safeParse(d).error?.issues ?? []).toEqual([]);
    expect(r.stderr).toBe("");
  });

  test("human: one stable snapshot for the skip-layer fixture", async () => {
    const r = await run(["validate"], { cwd: copyOf("invalid-layer") });
    expect(r.exitCode).toBe(1);
    await expect(r.stdout).toMatchFileSnapshot("./__snapshots__/validate-invalid-layer.txt");
  });

  test("human: no color unless stdout is a TTY", async () => {
    expect((await run(["validate"], { cwd: copyOf("invalid-layer") })).stdout).not.toContain("\u001b[");
    expect((await run(["validate"], { cwd: copyOf("invalid-layer"), tty: true })).stdout).toContain("\u001b[31m");
  });

  test("errors in JSON mode are a JSON error report on stdout plus a line on stderr", async () => {
    const root = copyOf("valid-architecture");
    rmSync(join(root, ".engintel/architecture.json"));
    const r = await run(["validate", "--format", "json"], { cwd: root });
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ outcome: "error", exitCode: 2, error: { code: "E_CONTRACT_MISSING", file: ".engintel/architecture.json" } });
    expect(r.stderr).toMatch(/^engintel: error E_CONTRACT_MISSING: /);
  });

  test("schema issues are listed on stderr", async () => {
    const root = copyOf("valid-architecture");
    writeFileSync(join(root, ".engintel/architecture.json"), JSON.stringify({ schemaVersion: 1, policyVersion: "1.0.0", status: "active", layers: [], rules: [] }));
    const r = await run(["validate"], { cwd: root });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("  layers: ");
  });
});

describe("commands and usage", () => {
  test("architecture validate is an alias of validate", async () => {
    const root = copyOf("invalid-layer");
    const a = await run(["validate", "--format", "json"], { cwd: root });
    const b = await run(["architecture", "validate", "--format", "json"], { cwd: root });
    expect(b).toEqual(a);
  });

  test("--root is resolved against the working directory", async () => {
    const root = copyOf("valid-architecture");
    expect((await run(["validate", "--root", root])).exitCode).toBe(0);
  });

  test("--now drives exception expiry", async () => {
    const root = copyOf("exceptions");
    expect((await run(["validate", "--now", "2026-09-01"], { cwd: root })).exitCode).toBe(1);
    expect((await run(["validate", "--now", "2026-02-01"], { cwd: root })).exitCode).toBe(0);
    expect((await run(["validate", "--now", "soon"], { cwd: root })).exitCode).toBe(2);
  });

  test("analyze summarizes and writes only .engintel/cache/graph.json", async () => {
    const root = copyOf("invalid-layer");
    const r = await run(["analyze"], { cwd: root });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Graph: 6 modules, 7 dependencies");
    expect(r.stdout).toContain("Files: 9 (6 source: 6 ok, 0 unreadable, 0 ignored; 3 other)");
    expect(JSON.parse(readFileSync(join(root, ".engintel/cache/graph.json"), "utf8"))).toMatchObject({ schemaVersion: 1 });
    const json = await run(["analyze", "--format", "json", "--no-cache"], { cwd: root });
    expect(JSON.parse(json.stdout)).toMatchObject({ command: "analyze", graph: { file: null } });
  });

  test("usage errors exit 2; help and version exit 0", async () => {
    expect((await run(["validate", "--bogus"])).exitCode).toBe(2);
    expect((await run(["validate", "--format", "xml"])).exitCode).toBe(2);
    expect((await run(["frobnicate"])).exitCode).toBe(2);
    expect((await run([])).exitCode).toBe(2);
    expect((await run(["--help"])).exitCode).toBe(0);
    const version = await run(["--version"]);
    expect(version).toMatchObject({ exitCode: 0, stdout: "0.1.0\n" });
  });

  test("todayUtc reads the date in UTC", () => {
    expect(todayUtc(new Date("2026-03-01T23:30:00-05:00"))).toBe("2026-03-02");
  });
});
