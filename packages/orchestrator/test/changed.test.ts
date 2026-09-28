// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goldenRoot } from "@engintel/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { ToolError, changedScopeFromGit, validateRepository } from "../src/index.js";

// ENG-010: --changed validates what a pull request changed, against the merge base.

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "ignore" });

/** A golden repo committed on main, then checked out on branch "pr". */
function gitRepo(golden: string): string {
  const root = mkdtempSync(join(tmpdir(), `engintel-changed-${golden}-`));
  created.push(root);
  cpSync(join(goldenRoot(), golden, "repo"), root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "pr");
  return root;
}

const now = "2026-09-01";
const SKIP_LAYER = 'import { OrderRepository } from "../repositories/order.repository";\nexport const shortcut = new OrderRepository();\n';

describe("validate --changed (ENG-010)", () => {
  test("no changes: nothing in scope, pass", async () => {
    const report = await validateRepository({ root: gitRepo("invalid-layer"), now, changedSince: "main" });
    expect(report.scope).toEqual({ mode: "changed", changedFiles: [], contractChanged: false });
    expect(report.outcome).toBe("pass");
  });

  test("existing debt in untouched files is ignored; a changed file's illegal import fails", async () => {
    // invalid-layer already has two skip-layer imports on main.
    const root = gitRepo("invalid-layer");
    writeFileSync(join(root, "src/controllers/refund.controller.ts"), SKIP_LAYER);
    const report = await validateRepository({ root, now, changedSince: "main" });
    expect(report.diagnostics.map((d) => [d.ruleId, d.file])).toEqual([["no-controller-to-repository", "src/controllers/refund.controller.ts"]]);
    expect(report.git).toMatchObject({ base: "main", baseCommit: expect.stringMatching(/^[0-9a-f]{40}$/), mergeBase: expect.stringMatching(/^[0-9a-f]{40}$/) });
  });

  test("editing a file with existing debt brings that debt into scope", async () => {
    const root = gitRepo("invalid-layer");
    writeFileSync(join(root, "src/controllers/report.controller.ts"), `// touched\n${SKIP_LAYER}`);
    const report = await validateRepository({ root, now, changedSince: "main" });
    expect(report.diagnostics.map((d) => d.file)).toEqual(["src/controllers/report.controller.ts"]);
  });

  test("committed changes count too, and commits on the base branch after the fork do not", async () => {
    const root = gitRepo("valid-architecture");
    writeFileSync(join(root, "src/controllers/refund.controller.ts"), SKIP_LAYER);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "pr change");
    git(root, "checkout", "-q", "main");
    writeFileSync(join(root, "src/controllers/main-only.controller.ts"), SKIP_LAYER);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "main moved on");
    git(root, "checkout", "-q", "pr");
    const report = await validateRepository({ root, now, changedSince: "main" });
    expect(report.scope).toEqual({ mode: "changed", changedFiles: ["src/controllers/refund.controller.ts"], contractChanged: false });
    expect(report.outcome).toBe("fail");
  });

  test("deleting a file fails its importers, whose import no longer resolves", async () => {
    const root = gitRepo("valid-architecture");
    rmSync(join(root, "src/repositories/order.repository.ts"));
    const report = await validateRepository({ root, now, changedSince: "main" });
    expect(report.scope).toMatchObject({ changedFiles: ["src/repositories/order.repository.ts"] });
    expect(report.diagnostics.map((d) => [d.ruleId, d.file])).toEqual([["no-unresolved-in-src", "src/services/order.service.ts"]]);
  });

  test("a changed contract re-evaluates everything", async () => {
    const root = gitRepo("invalid-layer");
    const path = join(root, ".engintel/architecture.json");
    const contract = JSON.parse(execFileSync("cat", [path], { encoding: "utf8" })) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...contract, description: "edited" }, null, 2));
    const scope = changedScopeFromGit(root, "main").scope;
    expect(scope).toEqual({ mode: "changed", changedFiles: [".engintel/architecture.json"], contractChanged: true });
    expect((await validateRepository({ root, now, changedSince: "main" })).counts.errors).toBe(2);
  });

  test("git problems are tool errors (exit 2), never a pass", async () => {
    const root = gitRepo("valid-architecture");
    const code = async (options: Partial<Parameters<typeof validateRepository>[0]>) => {
      try {
        await validateRepository({ root, now, ...options });
      } catch (error) {
        if (error instanceof ToolError) return error.code;
        throw error;
      }
      return "no error";
    };
    expect(await code({ changedSince: "no-such-branch" })).toBe("E_GIT_BAD_REF");
    expect(await code({ changedSince: "--output=x" })).toBe("E_GIT_BAD_REF");
    expect(await code({ changedSince: "main", scope: { mode: "full" } })).toBe("E_USAGE");
    const plain = mkdtempSync(join(tmpdir(), "engintel-nogit-"));
    created.push(plain);
    cpSync(join(goldenRoot(), "valid-architecture", "repo"), plain, { recursive: true });
    expect(await code({ root: plain, changedSince: "main" })).toBe("E_GIT_NOT_A_REPO");
  });
});
