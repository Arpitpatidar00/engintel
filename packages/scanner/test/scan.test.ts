// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GOLDEN_IDS, goldenRoot, loadGoldens, materializeScenario } from "@engintel/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { ScanError, scanRepository, type ScannedFile } from "../src/index.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) {
    chmodTree(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function chmodTree(dir: string): void {
  try {
    execFileSync("chmod", ["-R", "u+rwX", dir]);
  } catch {
    // best effort
  }
}

function tree(files: Record<string, string | Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), "engintel-scan-"));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const byPath = (files: readonly ScannedFile[], path: string) => files.find((f) => f.path === path);
const paths = (files: readonly ScannedFile[]) => files.map((f) => f.path);

describe("golden fixtures", () => {
  test.each(GOLDEN_IDS)("%s: git listing (in place) equals walk listing (temp copy)", (id) => {
    const golden = loadGoldens().find((g) => g.id === id)!;
    const viaGit = scanRepository(join(goldenRoot(), id, "repo"), { listing: "git" });
    const copy = materializeScenario(golden, Object.keys(golden.scenarios)[0]!);
    try {
      const overlayFiles = new Set(
        copy.scenario.overlay ? scanRepository(join(golden.dir, copy.scenario.overlay), { listing: "walk" }).files.map((f) => f.path) : [],
      );
      const viaWalk = scanRepository(copy.dir, { listing: "walk" });
      expect(viaGit.listing).toBe("git");
      expect(viaWalk.files.filter((f) => !overlayFiles.has(f.path))).toEqual(viaGit.files);
    } finally {
      copy.cleanup();
    }
  });

  test("unreadable-files: binary .ts files are unreadable; syntax is not the scanner's job", () => {
    const { files } = scanRepository(join(goldenRoot(), "unreadable-files", "repo"));
    expect(byPath(files, "src/services/corrupt.service.ts")).toMatchObject({ status: "unreadable", reason: "binary", sha256: null });
    expect(byPath(files, "src/legacy/vendor-blob.ts")).toMatchObject({ status: "unreadable", reason: "binary" });
    expect(byPath(files, "src/services/truncated.service.ts")).toMatchObject({ status: "ok", kind: "source" });
    expect(byPath(files, ".engintel/architecture.json")).toMatchObject({ status: "ok", kind: "config" });
    expect(byPath(files, "tsconfig.json")).toMatchObject({ status: "ok", kind: "config" });
  });

  test("prompt-injection: README.md is listed but unsupported", () => {
    const { files } = scanRepository(join(goldenRoot(), "prompt-injection", "repo"));
    expect(byPath(files, "README.md")).toMatchObject({ status: "unsupported", reason: "not-js-ts", sha256: null });
  });
});

describe("scanRepository", () => {
  test("is deterministic and content-addressed", () => {
    const dir = tree({ "src/b.ts": "export const b = 1;\n", "src/a.ts": "export const a = 1;\n" });
    const first = scanRepository(dir, { listing: "walk" });
    expect(scanRepository(dir, { listing: "walk" })).toEqual(first);
    expect(paths(first.files)).toEqual(["src/a.ts", "src/b.ts"]);
    writeFileSync(join(dir, "src/a.ts"), "export const a = 2;\n");
    expect(scanRepository(dir, { listing: "walk" }).treeHash).not.toBe(first.treeHash);
  });

  test("walk mode honors nested .gitignore files", () => {
    const dir = tree({
      ".gitignore": "dist/\n*.log\n",
      "src/a.ts": "",
      "dist/out.js": "",
      "debug.log": "",
      "sub/.gitignore": "local.ts\n",
      "sub/local.ts": "",
      "sub/keep.ts": "",
      "other/local.ts": "",
    });
    const listed = paths(scanRepository(dir, { listing: "walk" }).files);
    expect(listed).toEqual([".gitignore", "other/local.ts", "src/a.ts", "sub/.gitignore", "sub/keep.ts"]);
  });

  test("node_modules, .git, and EngIntel's own cache are never listed", () => {
    const dir = tree({
      "src/a.ts": "",
      "node_modules/x/index.js": "",
      "packages/p/node_modules/y/index.js": "",
      ".engintel/cache/graph.json": "{}",
      ".engintel/index/engintel.sqlite": "",
      ".engintel/architecture.json": "{}",
    });
    expect(paths(scanRepository(dir, { listing: "walk" }).files)).toEqual([".engintel/architecture.json", "src/a.ts"]);
  });

  test("build output directories are left to .gitignore, never skipped by name", () => {
    const dir = tree({ "src/build/webpack.ts": "", "dist/index.js": "" });
    expect(paths(scanRepository(dir, { listing: "walk" }).files)).toEqual(["dist/index.js", "src/build/webpack.ts"]);
  });

  test(".engintel/ignore and config globs mark files ignored, not missing", () => {
    const dir = tree({
      ".engintel/ignore": "src/generated/\n",
      "src/generated/api.ts": "",
      "src/app.ts": "",
      "src/app.spec.ts": "",
      "scripts/tool.ts": "",
    });
    const { files } = scanRepository(dir, { listing: "walk", include: ["src/**"], exclude: ["**/*.spec.ts"] });
    expect(byPath(files, "src/generated/api.ts")).toMatchObject({ status: "ignored", reason: "engintel-ignore" });
    expect(byPath(files, "src/app.spec.ts")).toMatchObject({ status: "ignored", reason: "config-exclude" });
    expect(byPath(files, "scripts/tool.ts")).toMatchObject({ status: "ignored", reason: "not-included" });
    expect(byPath(files, "src/app.ts")).toMatchObject({ status: "ok" });
  });

  test("unreadable reasons: too large, invalid UTF-8, symlink, unportable path", () => {
    const dir = tree({
      "src/big.ts": "x".repeat(64),
      "src/latin1.ts": Buffer.from([0x63, 0x6f, 0x6e, 0x73, 0x74, 0x20, 0xe9]),
      "src/target.ts": "",
      "src/a:b.ts": "",
    });
    symlinkSync(join(dir, "src/target.ts"), join(dir, "src/link.ts"));
    const { files } = scanRepository(dir, { listing: "walk", maxFileBytes: 32 });
    expect(byPath(files, "src/big.ts")).toMatchObject({ status: "unreadable", reason: "too-large" });
    expect(byPath(files, "src/latin1.ts")).toMatchObject({ status: "unreadable", reason: "invalid-utf8" });
    expect(byPath(files, "src/link.ts")).toMatchObject({ status: "unreadable", reason: "symlink" });
    expect(byPath(files, "src/a:b.ts")).toMatchObject({ status: "unreadable", reason: "unportable-path" });
    expect(byPath(files, "src/target.ts")).toMatchObject({ status: "ok" });
  });

  test.skipIf(process.getuid?.() === 0)("a file without read permission is unreadable, not skipped", () => {
    const dir = tree({ "src/secret.ts": "export {};\n" });
    chmodSync(join(dir, "src/secret.ts"), 0o000);
    expect(byPath(scanRepository(dir, { listing: "walk" }).files, "src/secret.ts")).toMatchObject({
      status: "unreadable",
      reason: "permission",
    });
  });

  test("refuses repositories above the file cap instead of truncating", () => {
    const dir = tree({ "a.ts": "", "b.ts": "", "c.ts": "" });
    expect(() => scanRepository(dir, { listing: "walk", maxFiles: 2 })).toThrowError(ScanError);
  });

  test("git mode lists tracked and untracked files and honors .gitignore", () => {
    const dir = tree({ ".gitignore": "ignored.ts\n", "tracked.ts": "", "untracked.ts": "", "ignored.ts": "" });
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("add", "tracked.ts", ".gitignore");
    const result = scanRepository(dir);
    expect(result.listing).toBe("git");
    expect(paths(result.files)).toEqual([".gitignore", "tracked.ts", "untracked.ts"]);
  });

  test("a missing root is an error", () => {
    expect(() => scanRepository(join(tmpdir(), "engintel-does-not-exist"))).toThrowError(ScanError);
  });
});
