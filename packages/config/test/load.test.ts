// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { CONTRACT_PATH, ConfigError, canonicalJson, loadContract, parseContract } from "../src/index.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(files: Record<string, string | Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), "engintel-config-"));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const minimal = readFileSync(new URL("../testdata/architecture/valid/minimal.json", import.meta.url), "utf8");
const minimalDoc = JSON.parse(minimal) as Record<string, unknown>;

function loadError(root: string): ConfigError {
  try {
    loadContract(root);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected loadContract to throw");
}

describe("loadContract (ENG-006)", () => {
  test("loads a valid contract with defaults applied and a content hash", () => {
    const loaded = loadContract(repo({ [CONTRACT_PATH]: minimal }));
    expect(loaded.file).toBe(".engintel/architecture.json");
    expect(loaded.contract.opaqueImports).toBe("error");
    expect(loaded.contractHash).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.warnings).toEqual([]);
  });

  test("the hash ignores formatting and key order, and changes with content", () => {
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(minimalDoc).reverse()));
    const a = loadContract(repo({ [CONTRACT_PATH]: minimal })).contractHash;
    expect(loadContract(repo({ [CONTRACT_PATH]: reordered })).contractHash).toBe(a);
    expect(loadContract(repo({ [CONTRACT_PATH]: `\uFEFF${minimal}` })).contractHash).toBe(a);
    expect(loadContract(repo({ [CONTRACT_PATH]: JSON.stringify({ ...minimalDoc, policyVersion: "0.1.1" }) })).contractHash).not.toBe(a);
  });

  test.each([
    ["missing file", {}, "E_CONTRACT_MISSING"],
    ["invalid JSON", { [CONTRACT_PATH]: "{ nope" }, "E_CONTRACT_INVALID"],
    ["empty file", { [CONTRACT_PATH]: "" }, "E_CONTRACT_INVALID"],
    ["not an object", { [CONTRACT_PATH]: "[]" }, "E_CONTRACT_INVALID"],
    ["unknown key", { [CONTRACT_PATH]: JSON.stringify({ ...minimalDoc, ignoreAll: true }) }, "E_CONTRACT_INVALID"],
    ["invalid UTF-8", { [CONTRACT_PATH]: new Uint8Array([0x7b, 0xff, 0x7d]) }, "E_CONTRACT_INVALID"],
    ["too large", { [CONTRACT_PATH]: `${minimal}${" ".repeat(1024 * 1024)}` }, "E_CONTRACT_INVALID"],
  ] as const)("%s is %s", (_, files, code) => {
    expect(loadError(repo(files)).code).toBe(code);
  });

  test("JSON errors give a position, never a quote of the file", () => {
    const error = loadError(repo({ [CONTRACT_PATH]: '{\n  "schemaVersion": 1,\n  SECRET-ISH TEXT\n}' }));
    expect(error.message).toBe(".engintel/architecture.json is not valid JSON at line 3, column 3");
    expect(loadError(repo({ [CONTRACT_PATH]: "hello world" })).message).not.toContain("hello");
    expect(loadError(repo({ [CONTRACT_PATH]: "  " })).message).toBe(".engintel/architecture.json is not valid JSON: the file is empty");
  });

  test("a directory in place of the contract is refused", () => {
    const root = repo({ ".engintel/architecture.json/x": "" });
    expect(loadError(root).code).toBe("E_CONTRACT_INVALID");
  });

  test("a symlinked contract is refused, not followed", () => {
    const root = repo({ "elsewhere.json": minimal });
    mkdirSync(join(root, ".engintel"));
    symlinkSync(join(root, "elsewhere.json"), join(root, CONTRACT_PATH));
    expect(loadError(root)).toMatchObject({ code: "E_CONTRACT_INVALID", message: expect.stringContaining("symlink") });
  });

  test("schema issues are reported with document paths", () => {
    const bad = { ...minimalDoc, rules: [{ ...(minimalDoc["rules"] as object[])[0], from: { layer: "nope" } }] };
    const error = loadError(repo({ [CONTRACT_PATH]: JSON.stringify(bad) }));
    expect(error.code).toBe("E_CONTRACT_INVALID");
    expect(error.issues).toEqual([{ path: "rules[0].from.layer", message: 'unknown layer "nope"' }]);
    expect(error.message).toContain('rules[0].from.layer: unknown layer "nope"');
  });

  test("an exception living longer than 180 days is a warning, not an error", () => {
    const doc = {
      ...minimalDoc,
      exceptions: [
        {
          id: "ex-long",
          ruleId: "no-ui-to-data",
          source: "src/ui/a.ts",
          target: "src/data/b.ts",
          reason: "Migration of the legacy data client is tracked in PLAT-1.",
          owner: "@platform",
          addedAt: "2026-01-01",
          expiresAt: "2026-12-31",
        },
      ],
    };
    const loaded = parseContract(doc);
    expect(loaded.warnings).toEqual([{ path: "exceptions[0].expiresAt", message: expect.stringContaining("364 days") }]);
  });
});

describe("canonicalJson", () => {
  test("sorts keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });
});
