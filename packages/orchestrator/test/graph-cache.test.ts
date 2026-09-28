// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goldenRoot } from "@engintel/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { GRAPH_CACHE_FILE, analyzeRepository, serializeReport, validateRepository, type ValidationReport } from "../src/index.js";

// ENG-037: incremental graph reuse. The cache may only ever make runs faster.

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyOf(id: string): string {
  const dir = mkdtempSync(join(tmpdir(), `engintel-gc-${id}-`));
  created.push(dir);
  cpSync(join(goldenRoot(), id, "repo"), dir, { recursive: true });
  return dir;
}

const now = "2026-09-01";

async function run(root: string, graphCache = true): Promise<{ report: ValidationReport; status: string }> {
  const lines: string[] = [];
  const report = await validateRepository({ root, now, graphCache, log: (l) => lines.push(l) });
  return { report, status: /graph cache: (\w+)/.exec(lines.join("\n"))?.[1] ?? "none" };
}

describe("graph cache (ENG-037)", () => {
  test("second run on the same tree hits, with a byte-identical report", async () => {
    const root = copyOf("invalid-layer");
    const first = await run(root);
    expect(first.status).toBe("miss");
    expect(existsSync(join(root, GRAPH_CACHE_FILE))).toBe(true);
    const second = await run(root);
    expect(second.status).toBe("hit");
    expect(serializeReport(second.report)).toBe(serializeReport(first.report));
  });

  test("an edit is a partial reuse whose result equals a from-scratch run", async () => {
    const root = copyOf("valid-architecture");
    await run(root);
    writeFileSync(join(root, "src/controllers/order.controller.ts"), 'import { OrderRepository } from "../repositories/order.repository";\nexport const c = new OrderRepository();\n');
    const cached = await run(root);
    expect(cached.status).toBe("partial");
    expect(cached.report.outcome).toBe("fail");
    expect(serializeReport(cached.report)).toBe(serializeReport((await run(root, false)).report));
  });

  test("adding a file, or changing the lockfile, rebuilds everything", async () => {
    const root = copyOf("valid-architecture");
    await run(root);
    writeFileSync(join(root, "src/domain/extra.ts"), "export const x = 1;\n");
    expect((await run(root)).status).toBe("miss");
    expect((await run(root)).status).toBe("hit");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    expect((await run(root)).status).toBe("miss");
  });

  test("a corrupted cache is a miss and is rewritten", async () => {
    const root = copyOf("valid-architecture");
    await run(root);
    writeFileSync(join(root, GRAPH_CACHE_FILE), "{ not json");
    expect((await run(root)).status).toBe("miss");
    expect(JSON.parse(readFileSync(join(root, GRAPH_CACHE_FILE), "utf8"))).toMatchObject({ format: 1 });
  });

  test("a cache committed to the repository is refused: forged edges cannot hide a violation", async () => {
    const root = copyOf("invalid-layer");
    await run(root);
    // Forge: drop every edge the cache records for the violating controllers, keep the key.
    const cache = JSON.parse(readFileSync(join(root, GRAPH_CACHE_FILE), "utf8")) as { files: Record<string, { edges: unknown[]; targets: unknown[] }> };
    for (const path of ["src/controllers/audit.controller.ts", "src/controllers/report.controller.ts"]) {
      const entry = cache.files[path];
      if (entry) Object.assign(entry, { edges: [], targets: [] });
    }
    writeFileSync(join(root, GRAPH_CACHE_FILE), JSON.stringify(cache));
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("add", "-f", GRAPH_CACHE_FILE);
    git("commit", "-q", "-m", "ship a forged cache");
    const r = await run(root);
    expect(r.status).toBe("refused");
    expect(r.report.counts.errors).toBe(2);
  });

  test("property: across a sequence of edits, cached and from-scratch results never differ", async () => {
    const root = copyOf("existing-violations");
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const targets = ["../repositories/order.repository", "../services/order.service", "../domain/order", "../domain/money"];
    for (let step = 0; step < 12; step++) {
      const file = `src/controllers/gen${rand(4)}.controller.ts`;
      const action = rand(3);
      if (action === 0) writeFileSync(join(root, file), `import { x } from "${targets[rand(targets.length)]}";\nexport const y${step} = x;\n`);
      else if (action === 1) rmSync(join(root, file), { force: true });
      else writeFileSync(join(root, "src/domain/order.ts"), `${readFileSync(join(root, "src/domain/order.ts"), "utf8")}// step ${step}\n`);
      const cached = await run(root);
      const scratch = await run(root, false);
      expect(serializeReport(cached.report), `step ${step}`).toBe(serializeReport(scratch.report));
    }
  });

  test("analyze reports the cache status; graphCache: false touches nothing", async () => {
    const root = copyOf("valid-architecture");
    expect((await analyzeRepository({ root, writeCache: false })).graph.cache.status).toBe("off");
    expect(existsSync(join(root, ".engintel/cache"))).toBe(false);
    expect((await analyzeRepository({ root })).graph.cache.status).toBe("miss");
    expect((await analyzeRepository({ root })).graph.cache).toMatchObject({ status: "hit", cruised: 0 });
  });
});
