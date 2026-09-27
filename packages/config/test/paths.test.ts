// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  CANONICAL_REPO_PATH_PATTERN,
  RepoPathError,
  isCanonicalRepoPath,
  isInsideRoot,
  normalizeRepoPath,
  resolveInsideRoot,
  toPosix,
  toRepoRelative,
  type RepoPathErrorCode,
} from "../src/index.js";

function codeOf(fn: () => unknown): RepoPathErrorCode | "ok" {
  try {
    fn();
    return "ok";
  } catch (error) {
    if (error instanceof RepoPathError) return error.code;
    throw error;
  }
}

describe("toPosix", () => {
  test("converts Windows separators", () => {
    expect(toPosix("src\\ui\\App.ts")).toBe("src/ui/App.ts");
  });
});

describe("normalizeRepoPath", () => {
  test.each([
    ["src/ui/App.ts", "src/ui/App.ts"],
    ["src\\ui\\App.ts", "src/ui/App.ts"],
    ["./x", "x"],
    [".\\x", "x"],
    ["x/", "x"],
    ["a//b", "a/b"],
    ["a/./b", "a/b"],
    ["a/../b", "b"],
    ["Src/App.ts", "Src/App.ts"],
    ["..foo/.bar", "..foo/.bar"],
    ["e\u0301.ts", "\u00e9.ts"],
  ])("%j -> %j", (input, expected) => {
    expect(normalizeRepoPath(input)).toBe(expected);
  });

  test("Windows and POSIX spellings of the same file are identical", () => {
    expect(normalizeRepoPath("src\\ui\\App.ts")).toBe(normalizeRepoPath("src/ui/App.ts"));
    expect(normalizeRepoPath("./x")).toBe(normalizeRepoPath("x"));
  });

  test.each<[string, RepoPathErrorCode]>([
    ["../x", "E_PATH_OUTSIDE_ROOT"],
    ["..\\x", "E_PATH_OUTSIDE_ROOT"],
    ["a/../../x", "E_PATH_OUTSIDE_ROOT"],
    ["src/../../etc/passwd", "E_PATH_OUTSIDE_ROOT"],
    ["/etc/passwd", "E_PATH_ABSOLUTE"],
    ["C:\\repo\\x.ts", "E_PATH_ABSOLUTE"],
    ["C:x.ts", "E_PATH_ABSOLUTE"],
    ["\\\\server\\share\\x.ts", "E_PATH_ABSOLUTE"],
    ["", "E_PATH_EMPTY"],
    [".", "E_PATH_EMPTY"],
    ["a/..", "E_PATH_EMPTY"],
    ["a\0b", "E_PATH_NUL"],
    ["src/a:b.ts", "E_PATH_UNPORTABLE"],
    ["src/a.ts:stream", "E_PATH_UNPORTABLE"],
  ])("%j is rejected with %s", (input, code) => {
    expect(codeOf(() => normalizeRepoPath(input))).toBe(code);
  });
});

describe("isCanonicalRepoPath and CANONICAL_REPO_PATH_PATTERN", () => {
  const canonical = ["x", "src/ui/App.ts", "..foo/.bar", "a b/c.ts", ".engintel/architecture.json"];
  const notCanonical = [
    "",
    ".",
    "./x",
    "x/",
    "a//b",
    "a/./b",
    "a/../b",
    "../x",
    "/x",
    "C:/x",
    "C:x",
    "src\\x.ts",
    "a\0b",
    "a:b",
    "external:",
  ];

  test.each(canonical)("%j is canonical", (p) => {
    expect(isCanonicalRepoPath(p)).toBe(true);
    expect(CANONICAL_REPO_PATH_PATTERN.test(p)).toBe(true);
  });

  test.each(notCanonical)("%j is not canonical", (p) => {
    expect(isCanonicalRepoPath(p)).toBe(false);
    expect(CANONICAL_REPO_PATH_PATTERN.test(p)).toBe(false);
  });

  test("NFD input is not canonical", () => {
    expect(isCanonicalRepoPath("e\u0301.ts")).toBe(false);
  });
});

describe("toRepoRelative", () => {
  test("POSIX paths", () => {
    expect(toRepoRelative("/repo", "/repo/src/a.ts", path.posix)).toBe("src/a.ts");
    expect(codeOf(() => toRepoRelative("/repo", "/repo", path.posix))).toBe("E_PATH_EMPTY");
    expect(codeOf(() => toRepoRelative("/repo", "/other/x.ts", path.posix))).toBe("E_PATH_OUTSIDE_ROOT");
    expect(codeOf(() => toRepoRelative("/repo", "/repository/x.ts", path.posix))).toBe("E_PATH_OUTSIDE_ROOT");
    expect(codeOf(() => toRepoRelative("/repo", "/repo/../x.ts", path.posix))).toBe("E_PATH_OUTSIDE_ROOT");
  });

  test("Windows paths become POSIX", () => {
    expect(toRepoRelative("C:\\repo", "C:\\repo\\src\\ui\\App.ts", path.win32)).toBe("src/ui/App.ts");
  });

  test("a different Windows drive is outside the root", () => {
    expect(codeOf(() => toRepoRelative("C:\\repo", "D:\\repo\\x.ts", path.win32))).toBe("E_PATH_OUTSIDE_ROOT");
  });
});

describe("resolveInsideRoot", () => {
  test("joins a repo path onto the root", () => {
    expect(resolveInsideRoot("/repo", "src/../a.ts", path.posix)).toBe("/repo/a.ts");
  });

  test("refuses to leave the root", () => {
    expect(codeOf(() => resolveInsideRoot("/repo", "../x", path.posix))).toBe("E_PATH_OUTSIDE_ROOT");
    expect(codeOf(() => resolveInsideRoot("/repo", "/etc/passwd", path.posix))).toBe("E_PATH_ABSOLUTE");
  });
});

describe("isInsideRoot", () => {
  test.each([
    ["/repo", "/repo", true],
    ["/repo", "/repo/src/a.ts", true],
    ["/repo", "/repository/a.ts", false],
    ["/repo", "/", false],
    ["/repo", "/repo/../etc", false],
  ])("posix %j contains %j: %s", (root, candidate, expected) => {
    expect(isInsideRoot(root, candidate, path.posix)).toBe(expected);
  });

  test("Windows: another drive is outside", () => {
    expect(isInsideRoot("C:\\repo", "C:\\repo\\a.ts", path.win32)).toBe(true);
    expect(isInsideRoot("C:\\repo", "D:\\repo\\a.ts", path.win32)).toBe(false);
  });
});
