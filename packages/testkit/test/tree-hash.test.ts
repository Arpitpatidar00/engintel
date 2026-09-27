// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  GOLDEN_IDS,
  computeTreeHash,
  fixtureTreeHash,
  goldenRoot,
  listTree,
  loadGoldens,
} from "../src/index.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Build a tree, writing files in the given order. */
function tree(files: Record<string, string | Uint8Array>, order = Object.keys(files)): string {
  const dir = mkdtempSync(join(tmpdir(), "engintel-treehash-"));
  created.push(dir);
  for (const rel of order) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), files[rel]!);
  }
  return dir;
}

describe("computeTreeHash", () => {
  const files = { "a.txt": "alpha", "dir/b.txt": "beta\n" };

  test("matches the known-answer vector (locks the algorithm)", () => {
    expect(computeTreeHash(tree(files))).toBe("6f6d501d7d6ccce1fa958e406ae0102483e4ed170e3511c5107565a8306462e7");
  });

  test("is stable across repeated runs and file creation order", () => {
    const first = computeTreeHash(tree(files, ["a.txt", "dir/b.txt"]));
    const second = computeTreeHash(tree(files, ["dir/b.txt", "a.txt"]));
    expect(second).toBe(first);
    expect(computeTreeHash(tree(files))).toBe(first);
  });

  test("changes when content, a path, or the file set changes", () => {
    const baseline = computeTreeHash(tree(files));
    expect(computeTreeHash(tree({ ...files, "a.txt": "alphA" }))).not.toBe(baseline);
    expect(computeTreeHash(tree({ "a2.txt": "alpha", "dir/b.txt": "beta\n" }))).not.toBe(baseline);
    expect(computeTreeHash(tree({ ...files, "empty.txt": "" }))).not.toBe(baseline);
  });

  test("hashes raw bytes: CRLF and LF are different files", () => {
    expect(computeTreeHash(tree({ "a.txt": "x\r\n" }))).not.toBe(computeTreeHash(tree({ "a.txt": "x\n" })));
  });

  test("ignores OS clutter such as .DS_Store", () => {
    expect(computeTreeHash(tree({ ...files, ".DS_Store": "junk", "dir/.DS_Store": "junk" }))).toBe(
      computeTreeHash(tree(files)),
    );
  });

  test("refuses symlinks", () => {
    const dir = tree(files);
    symlinkSync(join(dir, "a.txt"), join(dir, "link.txt"));
    expect(() => listTree(dir)).toThrow(/symlinks are not allowed/);
  });
});

describe("golden fixture hashes", () => {
  test.each(GOLDEN_IDS)("%s hashes identically twice", (id) => {
    const dir = join(goldenRoot(), id);
    expect(fixtureTreeHash(dir)).toBe(fixtureTreeHash(dir));
  });

  test("expected.json is excluded; everything else counts", () => {
    const copy = mkdtempSync(join(tmpdir(), "engintel-golden-copy-"));
    created.push(copy);
    cpSync(join(goldenRoot(), "valid-architecture"), copy, { recursive: true });
    const recorded = fixtureTreeHash(copy);
    expect(recorded).toBe(loadGoldens().find((g) => g.id === "valid-architecture")!.treeHash);

    writeFileSync(join(copy, "expected.json"), '{ "full": { "outcome": "pass" } }\n');
    expect(fixtureTreeHash(copy)).toBe(recorded);

    writeFileSync(join(copy, "repo", "src", "domain", "order.ts"), "export {};\n");
    expect(fixtureTreeHash(copy)).not.toBe(recorded);
  });
});
