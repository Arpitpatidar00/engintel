// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { GitError, changedFilesSince, isGitWorkTree, mergeBase, resolveCommit, showFileAt } from "../src/index.js";

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

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

/** main: a.ts, b.ts, lib/old.ts, keep.ts. Branch "feature" off main. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "engintel-git-"));
  created.push(root);
  sh(root, "init", "-q", "-b", "main");
  write(root, { "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n", "lib/old.ts": "export const o = 1;\n", "keep.ts": "export {};\n", ".gitignore": "ignored/\n" });
  sh(root, "add", ".");
  sh(root, "commit", "-q", "-m", "base");
  sh(root, "checkout", "-q", "-b", "feature");
  return root;
}

describe("changedFilesSince (ENG-010)", () => {
  test("committed and uncommitted changes, deletions, both sides of renames, untracked; ignored files excluded", () => {
    const root = repo();
    write(root, { "a.ts": "export const a = 2;\n", "new.ts": "export {};\n" });
    rmSync(join(root, "b.ts"));
    mkdirSync(join(root, "lib2"));
    renameSync(join(root, "lib/old.ts"), join(root, "lib2/renamed.ts"));
    sh(root, "add", "-A");
    sh(root, "commit", "-q", "-m", "change");
    write(root, { "keep.ts": "export const k = 1;\n", "untracked.ts": "export {};\n", "ignored/x.ts": "export {};\n" });
    const base = mergeBase(root, "main");
    expect(changedFilesSince(root, base)).toEqual({
      changed: ["a.ts", "b.ts", "keep.ts", "lib/old.ts", "lib2/renamed.ts", "new.ts", "untracked.ts"],
      deleted: ["b.ts", "lib/old.ts"],
    });
  });

  test("no changes means an empty set", () => {
    const root = repo();
    expect(changedFilesSince(root, mergeBase(root, "main"))).toEqual({ changed: [], deleted: [] });
  });

  test("a subdirectory root sees paths relative to itself, and only its own changes", () => {
    const root = repo();
    write(root, { "pkg/src/x.ts": "export {};\n", "other.ts": "export {};\n" });
    sh(root, "add", "-A");
    sh(root, "commit", "-q", "-m", "pkg");
    const base = mergeBase(join(root, "pkg"), "main");
    expect(changedFilesSince(join(root, "pkg"), base).changed).toEqual(["src/x.ts"]);
  });

  test("the merge base ignores commits made on the base branch after branching", () => {
    const root = repo();
    write(root, { "a.ts": "export const a = 3;\n" });
    sh(root, "commit", "-q", "-am", "feature edit");
    sh(root, "checkout", "-q", "main");
    write(root, { "b.ts": "export const b = 99;\n" });
    sh(root, "commit", "-q", "-am", "main moved on");
    sh(root, "checkout", "-q", "feature");
    expect(changedFilesSince(root, mergeBase(root, "main")).changed).toEqual(["a.ts"]);
  });
});

describe("refs and blobs", () => {
  test("showFileAt returns the old content, or null when the file did not exist", () => {
    const root = repo();
    write(root, { "a.ts": "changed\n" });
    const base = mergeBase(root, "main");
    expect(showFileAt(root, base, "a.ts")).toBe("export const a = 1;\n");
    expect(showFileAt(root, base, "missing.ts")).toBeNull();
  });

  test("hostile or unknown refs are refused before git sees them", () => {
    const root = repo();
    for (const ref of ["--output=/tmp/x", "-p", "main with space", "main:a.ts", "$(touch x)", ""]) {
      expect(() => resolveCommit(root, ref), ref).toThrow(expect.objectContaining({ code: "E_GIT_BAD_REF" }));
    }
    expect(() => resolveCommit(root, "no-such-branch")).toThrow(expect.objectContaining({ code: "E_GIT_BAD_REF" }));
    expect(() => changedFilesSince(root, "--cached")).toThrow(GitError);
  });

  test("unrelated histories have no merge base", () => {
    const root = repo();
    sh(root, "checkout", "-q", "--orphan", "island");
    sh(root, "commit", "-q", "-m", "island");
    expect(() => mergeBase(root, "main")).toThrow(expect.objectContaining({ code: "E_GIT_NO_MERGE_BASE" }));
  });

  test("outside a work tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "engintel-nogit-"));
    created.push(dir);
    expect(isGitWorkTree(dir)).toBe(false);
    expect(() => resolveCommit(dir, "main")).toThrow(expect.objectContaining({ code: "E_GIT_NOT_A_REPO" }));
  });
});

describe("repository config cannot run code", () => {
  test("diff.external, core.fsmonitor, and hooks configured by the repository never execute", () => {
    const root = repo();
    const marker = join(root, "PWNED");
    const script = join(root, "evil.sh");
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(script, 0o755);
    sh(root, "config", "diff.external", script);
    sh(root, "config", "core.fsmonitor", script);
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    writeFileSync(join(root, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    write(root, { "a.ts": "changed\n" });
    const base = mergeBase(root, "main");
    changedFilesSince(root, base);
    showFileAt(root, base, "a.ts");
    expect(existsSync(marker)).toBe(false);
  });
});
