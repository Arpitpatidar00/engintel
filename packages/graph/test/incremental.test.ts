// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { goldenRoot } from "@engintel/testkit";
import { describe, expect, test } from "vitest";
import {
  buildModuleGraph,
  cacheFromGraph,
  graphCacheKey,
  mergeGraph,
  parseGraphCache,
  planReuse,
  serializeGraph,
  type CacheKeyParts,
} from "../src/index.js";

const parts: CacheKeyParts = {
  engineVersion: "0.1.0",
  tsconfig: "tsconfig.json",
  paths: ["a.ts", "b.ts", "package.json"],
  configHashes: { "package.json": "1".repeat(64) },
  installHashes: { "pnpm-lock.yaml": "2".repeat(64), "yarn.lock": null },
  analyzed: ["a.ts", "b.ts"],
};

describe("graphCacheKey (ENG-037)", () => {
  test("stable under reordering, different when anything that steers resolution changes", () => {
    const key = graphCacheKey(parts);
    expect(graphCacheKey({ ...parts, paths: [...parts.paths].reverse(), analyzed: ["b.ts", "a.ts"] })).toBe(key);
    const variants: Partial<CacheKeyParts>[] = [
      { engineVersion: "0.1.1" },
      { tsconfig: null },
      { paths: [...parts.paths, "c.ts"] },
      { configHashes: { "package.json": "3".repeat(64) } },
      { installHashes: { ...parts.installHashes, "pnpm-lock.yaml": "4".repeat(64) } },
      { analyzed: ["a.ts"] },
    ];
    for (const v of variants) expect(graphCacheKey({ ...parts, ...v }), JSON.stringify(v)).not.toBe(key);
  });
});

describe("parseGraphCache", () => {
  const key = "a".repeat(64);
  const good = {
    format: 1,
    key,
    files: { "a.ts": { sha256: "b".repeat(64), edges: [{ from: "a.ts", to: "b.ts", kind: "import", specifier: "./b", isTypeOnly: false, isDynamic: false, isReExport: false }], targets: [{ id: "b.ts", kind: "module" }] } },
  };

  test("accepts a well-formed cache", () => {
    expect(parseGraphCache(JSON.stringify(good))?.key).toBe(key);
  });

  test.each([
    ["not JSON", "{"],
    ["wrong format", JSON.stringify({ ...good, format: 2 })],
    ["bad key", JSON.stringify({ ...good, key: "x" })],
    ["edge from another file", JSON.stringify({ ...good, files: { "a.ts": { ...good.files["a.ts"], edges: [{ ...good.files["a.ts"].edges[0], from: "evil.ts" }] } } })],
    ["extra edge field", JSON.stringify({ ...good, files: { "a.ts": { ...good.files["a.ts"], edges: [{ ...good.files["a.ts"].edges[0], trusted: true }] } } })],
    ["unknown node kind", JSON.stringify({ ...good, files: { "a.ts": { ...good.files["a.ts"], targets: [{ id: "b.ts", kind: "magic" }] } } })],
    ["files is an array", JSON.stringify({ ...good, files: [] })],
  ])("treats %s as a miss", (_, text) => {
    expect(parseGraphCache(text)).toBeNull();
  });
});

describe("planReuse and mergeGraph", () => {
  const root = join(goldenRoot(), "circular", "repo");
  const list = (dir: string): string[] =>
    readdirSync(join(root, dir)).flatMap((n) => (statSync(join(root, dir, n)).isDirectory() ? list(`${dir}/${n}`) : [`${dir}/${n}`]));
  const files = list("src").sort();

  test("re-cruising only changed files and merging reproduces the full graph exactly", async () => {
    const fullGraph = await buildModuleGraph({ root, files });
    const shas = new Map(files.map((f) => [f, "0".repeat(64)]));
    const cache = cacheFromGraph("k".repeat(64).replace(/k/g, "a"), shas, fullGraph);
    for (const changed of files) {
      const edited = new Map(shas);
      edited.set(changed, "1".repeat(64));
      const plan = planReuse(cache, cache.key, edited);
      expect(plan.status).toBe("partial");
      expect(plan.toCruise).toEqual([changed]);
      const fresh = await buildModuleGraph({ root, files: [...plan.toCruise] });
      expect(serializeGraph(mergeGraph(files, plan.reused, fresh)), changed).toBe(serializeGraph(fullGraph));
    }
  });

  test("hit when nothing changed; miss on a different key or no cache", () => {
    const shas = new Map(files.map((f) => [f, "0".repeat(64)]));
    const cache = cacheFromGraph("a".repeat(64), shas, { schemaVersion: 1, nodes: [], edges: [] });
    expect(planReuse(cache, "a".repeat(64), shas).status).toBe("hit");
    expect(planReuse(cache, "b".repeat(64), shas)).toMatchObject({ status: "miss", toCruise: files });
    expect(planReuse(null, "a".repeat(64), shas).status).toBe("miss");
  });
});
