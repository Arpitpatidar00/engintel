// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goldenRoot } from "@engintel/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { GRAPH_CACHE_PATH, SYMBOLS_CACHE_PATH, ToolError, analyzeRepository, validateRepository, writeInsideEngintel } from "../src/index.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway copy of a golden repo, optionally with files replaced. */
function copyOf(id: string, files: Record<string, string | null> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), `engintel-orch-${id}-`));
  created.push(dir);
  cpSync(join(goldenRoot(), id, "repo"), dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) rmSync(join(dir, rel), { force: true });
    else writeFileSync(join(dir, rel), content);
  }
  return dir;
}

function snapshotTree(dir: string, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(dir, rel))) {
    const path = rel ? `${rel}/${name}` : name;
    if (statSync(join(dir, path)).isDirectory()) Object.assign(out, snapshotTree(dir, path));
    else out[path] = readFileSync(join(dir, path)).toString("base64");
  }
  return out;
}

async function toolError(run: Promise<unknown>): Promise<ToolError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error("expected a ToolError");
}

const now = "2026-09-01";
const contractPath = ".engintel/architecture.json";

describe("validateRepository: tool errors never pass (exit 2)", () => {
  test.each([
    ["missing contract", { [contractPath]: null }, "E_CONTRACT_MISSING"],
    ["broken JSON", { [contractPath]: "{ this is not json" }, "E_CONTRACT_INVALID"],
    ["schema-invalid contract", { [contractPath]: JSON.stringify({ schemaVersion: 1, status: "active" }) }, "E_CONTRACT_INVALID"],
    ["invalid config", { ".engintel/config.json": JSON.stringify({ schemaVersion: 1, apiToken: "x" }) }, "E_CONFIG_INVALID"],
  ] as const)("%s is %s", async (_, files, code) => {
    const error = await toolError(validateRepository({ root: copyOf("valid-architecture", files), now }));
    expect(error.code).toBe(code);
  });

  test("a draft contract is refused, not enforced and not passed", async () => {
    const root = copyOf("invalid-layer");
    const contract = JSON.parse(readFileSync(join(root, contractPath), "utf8")) as Record<string, unknown>;
    writeFileSync(join(root, contractPath), JSON.stringify({ ...contract, status: "draft" }));
    const error = await toolError(validateRepository({ root, now }));
    expect(error.code).toBe("E_CONTRACT_DRAFT");
    expect(error.message).toContain('status "draft"');
  });

  test("a dependency-cruiser crash is E_GRAPH_FAILED", async () => {
    const error = await toolError(validateRepository({ root: copyOf("valid-architecture"), now, cruiseImpl: () => Promise.reject(new Error("boom")) }));
    expect(error.code).toBe("E_GRAPH_FAILED");
  });

  test("a malformed clock is a usage error", async () => {
    expect((await toolError(validateRepository({ root: copyOf("valid-architecture"), now: "tomorrow" }))).code).toBe("E_USAGE");
  });

  test("a changed file outside the root is refused", async () => {
    const error = await toolError(validateRepository({ root: copyOf("valid-architecture"), now, scope: { mode: "changed", changedFiles: ["../x.ts"], contractChanged: false } }));
    expect(error.code).toBe("E_PATH_OUTSIDE_ROOT");
  });
});

describe("validateRepository: full scope", () => {
  test("valid-architecture passes, invalid-layer fails", async () => {
    expect((await validateRepository({ root: copyOf("valid-architecture"), now })).exitCode).toBe(0);
    const r = await validateRepository({ root: copyOf("invalid-layer"), now });
    expect(r.exitCode).toBe(1);
    expect(r.scope).toEqual({ mode: "full" });
  });

  test("unreadable and unparseable files fail closed; the allowlisted blob does not block", async () => {
    const r = await validateRepository({ root: copyOf("unreadable-files"), now });
    expect(r.outcome).toBe("fail");
    expect(r.diagnostics.map((d) => [d.ruleId, d.file])).toEqual([
      ["engintel.unanalyzable", "src/services/corrupt.service.ts"],
      ["engintel.unanalyzable", "src/services/truncated.service.ts"],
    ]);
  });

  test("a file that becomes unparseable flips a passing repository to fail", async () => {
    const root = copyOf("valid-architecture", { "src/services/order.service.ts": "export class OrderService {\n  broken(\n" });
    const r = await validateRepository({ root, now });
    expect(r.diagnostics.map((d) => [d.ruleId, d.file])).toEqual([["engintel.unanalyzable", "src/services/order.service.ts"]]);
  });

  test("validate writes nothing", async () => {
    const root = copyOf("invalid-layer");
    const before = snapshotTree(root);
    await validateRepository({ root, now });
    expect(snapshotTree(root)).toEqual(before);
  });
});

describe("analyzeRepository", () => {
  test("summarizes the repository and caches the normalized graph in .engintel/cache/", async () => {
    const root = copyOf("invalid-layer");
    const before = snapshotTree(root);
    const r = await analyzeRepository({ root });
    expect(r).toMatchObject({
      command: "analyze",
      outcome: "ok",
      exitCode: 0,
      contract: { status: "active" },
      graph: { file: GRAPH_CACHE_PATH, modules: 6, external: 0, core: 0, unresolved: 0, edges: 7, cycles: 0 },
      layers: [
        { id: "controllers", files: 3 },
        { id: "services", files: 1 },
        { id: "repositories", files: 1 },
        { id: "domain", files: 1 },
      ],
      unlayered: 0,
      unanalyzable: [],
    });
    expect(r.symbols).toEqual({ file: SYMBOLS_CACHE_PATH, exported: 7, projects: [{ configFile: "tsconfig.json", files: 6 }] });
    const after = snapshotTree(root);
    expect(Object.keys(after).filter((p) => !(p in before)).sort()).toEqual([GRAPH_CACHE_PATH, SYMBOLS_CACHE_PATH]);
    const cached = JSON.parse(readFileSync(join(root, SYMBOLS_CACHE_PATH), "utf8")) as { symbols: { file: string; name: string; kind: string }[] };
    expect(cached.symbols.find((s) => s.name === "OrderService")).toMatchObject({ file: "src/services/order.service.ts", kind: "class" });
    const graph = JSON.parse(readFileSync(join(root, GRAPH_CACHE_PATH), "utf8")) as { edges: { from: string; to: string }[] };
    // ENG-030: "who imports order.repository.ts" from the persisted graph.
    const importers = graph.edges.filter((e) => e.to === "src/repositories/order.repository.ts").map((e) => e.from);
    expect(importers).toEqual(["src/controllers/audit.controller.ts", "src/controllers/report.controller.ts", "src/services/order.service.ts"]);
  });

  test("runs without a contract and says so", async () => {
    const r = await analyzeRepository({ root: copyOf("valid-architecture", { [contractPath]: null }), writeCache: false });
    expect(r.contract).toBeNull();
    expect(r.layers).toEqual([]);
    expect(r.notices[0]).toContain("without a contract");
  });

  test("a broken contract is still an error for analyze", async () => {
    expect((await toolError(analyzeRepository({ root: copyOf("valid-architecture", { [contractPath]: "{" }) }))).code).toBe("E_CONTRACT_INVALID");
  });
});

describe("writeInsideEngintel", () => {
  test("refuses paths outside .engintel/", () => {
    const root = copyOf("valid-architecture");
    expect(() => writeInsideEngintel(root, "src/evil.ts", "x")).toThrow(expect.objectContaining({ code: "E_WRITE_OUTSIDE_ENGINTEL" }));
    expect(() => writeInsideEngintel(root, ".engintel/../src/evil.ts", "x")).toThrow(expect.objectContaining({ code: "E_WRITE_OUTSIDE_ENGINTEL" }));
    expect(existsSync(join(root, "src/evil.ts"))).toBe(false);
  });

  test("refuses to write through a symlinked directory", () => {
    const root = copyOf("valid-architecture");
    const elsewhere = mkdtempSync(join(tmpdir(), "engintel-elsewhere-"));
    created.push(elsewhere);
    symlinkSync(elsewhere, join(root, ".engintel", "cache"));
    expect(() => writeInsideEngintel(root, GRAPH_CACHE_PATH, "x")).toThrow(expect.objectContaining({ code: "E_WRITE_UNSAFE" }));
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test("refuses to replace a symlinked file", () => {
    const root = copyOf("valid-architecture");
    mkdirSync(join(root, ".engintel", "cache"));
    const target = join(tmpdir(), `engintel-target-${process.pid}.json`);
    writeFileSync(target, "original");
    created.push(target);
    symlinkSync(target, join(root, GRAPH_CACHE_PATH));
    expect(() => writeInsideEngintel(root, GRAPH_CACHE_PATH, "x")).toThrow(expect.objectContaining({ code: "E_WRITE_UNSAFE" }));
    expect(readFileSync(target, "utf8")).toBe("original");
  });

  test("overwrites atomically", () => {
    const root = copyOf("valid-architecture");
    writeInsideEngintel(root, ".engintel/cache/a.json", "1");
    writeInsideEngintel(root, ".engintel/cache/a.json", "2");
    expect(readFileSync(join(root, ".engintel/cache/a.json"), "utf8")).toBe("2");
    expect(readdirSync(join(root, ".engintel/cache"))).toEqual(["a.json"]);
  });
});
