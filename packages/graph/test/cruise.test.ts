// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { goldenRoot } from "@engintel/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { GraphError, buildModuleGraph, normalizeCruiseResult, packageName, serializeGraph, type ModuleGraph } from "../src/index.js";

// Adapter contract tests (ENG-005). Assertions are on ModuleGraph, never on raw
// dependency-cruiser JSON, so a cruiser upgrade that changes its output format
// shows up here as a normalization failure rather than a silent snapshot diff.

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "engintel-graph-"));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

function sources(root: string, dir = "src"): string[] {
  return readdirSync(join(root, dir))
    .flatMap((name) => {
      const rel = `${dir}/${name}`;
      return statSync(join(root, rel)).isDirectory() ? sources(root, rel) : [rel];
    })
    .filter((p) => /\.[cm]?[jt]sx?$/.test(p))
    .sort();
}

const edgeList = (g: ModuleGraph) => g.edges.map((e) => `${e.from} -> ${e.to} [${e.kind}]`);
const nodeOf = (g: ModuleGraph, id: string) => g.nodes.find((n) => n.id === id);

async function golden(id: string, doNotFollow: string[] = []): Promise<ModuleGraph> {
  const root = join(goldenRoot(), id, "repo");
  const files = sources(root).filter((f) => !doNotFollow.includes(f));
  return buildModuleGraph({ root, files, doNotFollow });
}

describe("golden fixtures", () => {
  test("invalid-layer: value and type-only edges, repo-relative ids", async () => {
    const g = await golden("invalid-layer");
    expect(edgeList(g)).toEqual([
      "src/controllers/audit.controller.ts -> src/repositories/order.repository.ts [type-only]",
      "src/controllers/order.controller.ts -> src/domain/order.ts [type-only]",
      "src/controllers/order.controller.ts -> src/services/order.service.ts [import]",
      "src/controllers/report.controller.ts -> src/repositories/order.repository.ts [import]",
      "src/repositories/order.repository.ts -> src/domain/order.ts [type-only]",
      "src/services/order.service.ts -> src/domain/order.ts [type-only]",
      "src/services/order.service.ts -> src/repositories/order.repository.ts [import]",
    ]);
    expect(g.nodes.every((n) => n.kind === "module")).toBe(true);
    const audit = g.edges.find((e) => e.from === "src/controllers/audit.controller.ts");
    expect(audit).toMatchObject({ specifier: "../repositories/order.repository", isTypeOnly: true, isDynamic: false, isReExport: false });
  });

  test("unresolved: relative misses normalize against the importer; literal import() is a dynamic edge", async () => {
    const g = await golden("unresolved");
    expect(g.edges.filter((e) => e.from === "src/services/export.service.ts").map((e) => [e.to, e.kind, e.specifier])).toEqual([
      ["src/domain/order.ts", "dynamic", "../domain/order"],
      ["unresolved:src/lib/csv-writer", "import", "../lib/csv-writer"],
    ]);
    expect(g.nodes.filter((n) => n.kind === "unresolved")).toEqual([{ id: "unresolved:src/lib/csv-writer", kind: "unresolved" }]);
  });

  test("circular: both directions of the cycle are edges", async () => {
    const g = await golden("circular");
    expect(edgeList(g)).toContain("src/domain/discount.ts -> src/domain/pricing.ts [import]");
    expect(edgeList(g)).toContain("src/domain/pricing.ts -> src/domain/discount.ts [import]");
  });

  test("unreadable-files: doNotFollow files are never parsed, and nothing imports them", async () => {
    const skip = ["src/legacy/vendor-blob.ts", "src/services/corrupt.service.ts", "src/services/truncated.service.ts"];
    const g = await golden("unreadable-files", skip);
    for (const path of skip) {
      expect(nodeOf(g, path)).toBeUndefined();
      expect(g.edges.some((e) => e.from === path)).toBe(false);
    }
  });

  test("the same input gives byte-identical output", async () => {
    const [a, b] = [await golden("exceptions"), await golden("exceptions")];
    expect(serializeGraph(a)).toBe(serializeGraph(b));
  });
});

describe("resolution", () => {
  test("externals collapse to the package, builtins become core:, tsconfig paths resolve", async () => {
    const root = tree({
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } } }),
      "node_modules/lodash/package.json": JSON.stringify({ name: "lodash", version: "1.0.0", main: "index.js" }),
      "node_modules/lodash/index.js": "module.exports = {};\n",
      "node_modules/lodash/get.js": "module.exports = () => 1;\n",
      "node_modules/@acme/kit/package.json": JSON.stringify({ name: "@acme/kit", version: "1.0.0", main: "index.js" }),
      "node_modules/@acme/kit/index.js": "module.exports = {};\n",
      "node_modules/@acme/kit/sub/index.js": "module.exports = {};\n",
      "package.json": JSON.stringify({ name: "fixture", dependencies: { lodash: "1.0.0", "@acme/kit": "1.0.0" } }),
      "src/util.ts": "export const one = 1;\n",
      "src/lazy.ts": "export const two = 2;\n",
      "src/barrel.ts": "export const three = 3;\n",
      "src/main.ts": [
        'import { readFileSync } from "node:fs";',
        'import { join } from "path";',
        'import get from "lodash/get";',
        'import _ from "lodash";',
        'import sub from "@acme/kit/sub";',
        'import { one } from "@app/util";',
        'import missing from "not-installed";',
        'export * from "./barrel";',
        'const lazy = () => import("./lazy");',
        "export default [readFileSync, join, get, _, sub, one, missing, lazy];",
        "",
      ].join("\n"),
    });
    const g = await buildModuleGraph({ root, files: sources(root) });
    const fromMain = g.edges.filter((e) => e.from === "src/main.ts").map((e) => `${e.to} [${e.kind}]`);
    expect(fromMain).toEqual([
      "core:fs [import]",
      "core:path [import]",
      "external:@acme/kit [import]",
      "external:lodash [import]",
      "external:lodash [import]",
      "src/barrel.ts [re-export]",
      "src/lazy.ts [dynamic]",
      "src/util.ts [import]",
      "unresolved:not-installed [import]",
    ]);
    expect(nodeOf(g, "external:lodash")).toEqual({ id: "external:lodash", kind: "external" });
    expect(nodeOf(g, "core:fs")).toEqual({ id: "core:fs", kind: "core" });
    expect(g.nodes.some((n) => n.id.includes("node_modules"))).toBe(false);
  });

  test("without a tsconfig, path aliases are unresolved rather than guessed", async () => {
    const root = tree({ "src/util.ts": "export const one = 1;\n", "src/main.ts": 'import { one } from "@app/util";\nexport default one;\n' });
    const g = await buildModuleGraph({ root, files: sources(root) });
    expect(edgeList(g)).toEqual(["src/main.ts -> unresolved:@app/util [import]"]);
  });

  test("cruiser keeps the first static use of a specifier; type-only and value uses stay separate", async () => {
    // A later import("./util") after `export * from "./util"` is dropped by cruiser.
    // The from -> to edge survives, which is all layer rules key on; the parse
    // pass in @engintel/symbols keeps the full list of uses with positions.
    const root = tree({
      "src/util.ts": "export type T = 1;\nexport const one = 1;\n",
      "src/main.ts": 'export * from "./util";\nexport const lazy = () => import("./util");\n',
      "src/mixed.ts": 'import type { T } from "./util";\nimport { one } from "./util";\nexport const x: T = one;\n',
    });
    const g = await buildModuleGraph({ root, files: sources(root) });
    expect(edgeList(g)).toEqual([
      "src/main.ts -> src/util.ts [re-export]",
      "src/mixed.ts -> src/util.ts [import]",
      "src/mixed.ts -> src/util.ts [type-only]",
    ]);
  });

  test("an empty file list is an empty graph without calling cruiser", async () => {
    const g = await buildModuleGraph({
      root: tmpdir(),
      files: [],
      cruiseImpl: () => {
        throw new Error("must not be called");
      },
    });
    expect(g).toEqual({ schemaVersion: 1, nodes: [], edges: [] });
  });
});

describe("fail closed (ENG-030)", () => {
  const root = realpathSync(tmpdir());
  const files = ["src/a.ts"];

  test("a cruiser crash is E_GRAPH_FAILED, never an empty graph", async () => {
    const run = buildModuleGraph({ root, files, tsconfig: null, cruiseImpl: () => Promise.reject(new Error("boom")) });
    await expect(run).rejects.toThrow(GraphError);
    await expect(run).rejects.toMatchObject({ code: "E_GRAPH_FAILED" });
  });

  test("a synchronous throw is E_GRAPH_FAILED", async () => {
    const cruiseImpl = () => {
      throw new Error("sync boom");
    };
    await expect(buildModuleGraph({ root, files, tsconfig: null, cruiseImpl })).rejects.toMatchObject({ code: "E_GRAPH_FAILED" });
  });

  test("a hang is E_GRAPH_TIMEOUT", async () => {
    const cruiseImpl = () => new Promise<never>(() => {});
    await expect(buildModuleGraph({ root, files, tsconfig: null, timeoutMs: 20, cruiseImpl })).rejects.toMatchObject({ code: "E_GRAPH_TIMEOUT" });
  });

  test.each([
    ["not JSON", "{oops"],
    ["no modules", { summary: {} }],
    ["modules not an array", { modules: {} }],
    ["module without source", { modules: [{ dependencies: [] }] }],
    ["null", null],
  ])("malformed output (%s) is E_GRAPH_MALFORMED", async (_, output) => {
    const cruiseImpl = () => Promise.resolve({ output });
    await expect(buildModuleGraph({ root, files, tsconfig: null, cruiseImpl })).rejects.toMatchObject({ code: "E_GRAPH_MALFORMED" });
  });

  test("an unreadable tsconfig is E_TSCONFIG_INVALID", async () => {
    const dir = tree({ "tsconfig.json": "{ not json", "src/a.ts": "" });
    await expect(buildModuleGraph({ root: dir, files })).rejects.toMatchObject({ code: "E_TSCONFIG_INVALID" });
  });

  test("the adapter passes explicit files, baseDir, and no repository-supplied cruiser config", async () => {
    let seen: { files: string[]; options: Record<string, unknown> } | undefined;
    await buildModuleGraph({
      root,
      files: ["src/b.ts", "src/a.ts"],
      doNotFollow: ["src/bad(1).ts"],
      tsconfig: null,
      cruiseImpl: (f, options) => {
        seen = { files: f, options };
        return Promise.resolve({ output: { modules: [] } });
      },
    });
    expect(seen?.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(seen?.options).toMatchObject({ baseDir: root, tsPreCompilationDeps: true, cache: false });
    expect(seen?.options).not.toHaveProperty("ruleSet");
    expect(seen?.options).not.toHaveProperty("webpackConfig");
    expect((seen?.options["doNotFollow"] as { path: string[] }).path).toEqual(["(^|/)node_modules/", "^src/bad\\(1\\)\\.ts$"]);
  });
});

describe("normalizeCruiseResult", () => {
  test("dedupes edges, sorts nodes and edges, and ignores non-local module entries", () => {
    const g = normalizeCruiseResult({
      modules: [
        { source: "src/b.ts", dependencies: [] },
        {
          source: "src/a.ts",
          dependencies: [
            { resolved: "src/b.ts", module: "./b", dependencyTypes: ["local", "import"] },
            { resolved: "src/b.ts", module: "./b", dependencyTypes: ["local", "import"] },
            { resolved: "fs", module: "fs", coreModule: true, dependencyTypes: ["core"] },
          ],
        },
        { source: "fs", coreModule: true, dependencies: [] },
        { source: "../x", couldNotResolve: true, dependencies: [] },
      ],
    });
    expect(g.nodes).toEqual([
      { id: "core:fs", kind: "core" },
      { id: "src/a.ts", kind: "module" },
      { id: "src/b.ts", kind: "module" },
    ]);
    expect(edgeList(g)).toEqual(["src/a.ts -> core:fs [import]", "src/a.ts -> src/b.ts [import]"]);
  });

  test("edge kind priority: re-export > dynamic > require > triple-slash > type-only > import", () => {
    const kinds = (dependencyTypes: string[], extra: object = {}) =>
      normalizeCruiseResult({ modules: [{ source: "src/a.ts", dependencies: [{ resolved: "src/b.ts", module: "./b", dependencyTypes, ...extra }] }] }).edges[0]?.kind;
    expect(kinds(["local", "export", "type-only"])).toBe("re-export");
    expect(kinds(["local", "dynamic-import"])).toBe("dynamic");
    expect(kinds(["local", "require"])).toBe("require");
    expect(kinds(["local", "triple-slash-directive"])).toBe("triple-slash");
    expect(kinds(["local", "type-only", "import"])).toBe("type-only");
    expect(kinds(["local", "import"], { typeOnly: true })).toBe("type-only");
    expect(kinds(["local", "import"])).toBe("import");
  });

  test("a relative miss that escapes the root keeps its specifier; a resolved file outside the root is external", () => {
    const g = normalizeCruiseResult({
      modules: [
        {
          source: "src/a.ts",
          dependencies: [
            { resolved: "../../../nope", module: "../../../nope", couldNotResolve: true, dependencyTypes: ["unknown"] },
            { resolved: "../sibling/lib.ts", module: "../../sibling/lib", dependencyTypes: ["local"] },
          ],
        },
      ],
    });
    expect(g.edges.map((e) => e.to)).toEqual(["external:../sibling/lib.ts", "unresolved:../../../nope"]);
  });

  test("packageName", () => {
    expect(packageName("lodash/get")).toBe("lodash");
    expect(packageName("@scope/pkg/deep/path")).toBe("@scope/pkg");
    expect(packageName("react")).toBe("react");
  });
});
