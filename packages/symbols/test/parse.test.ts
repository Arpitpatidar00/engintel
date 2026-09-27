// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { goldenRoot } from "@engintel/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { parseSourceFiles } from "../src/index.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function parse(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "engintel-parse-"));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return parseSourceFiles(dir, Object.keys(files));
}

describe("imports", () => {
  test("classifies every import form, with 1-based positions", () => {
    const [file] = parse({
      "src/a.ts": [
        'import { A } from "./a1";',
        'import type { B } from "./b1";',
        'import { type C, type D } from "./c1";',
        'import { type E, F } from "./e1";',
        'import "./side-effect";',
        'export { G } from "./g1";',
        'export type { H } from "./h1";',
        'import I = require("./i1");',
        'type J = typeof import("./j1");',
        "const k = await import(\"./k1\");",
        "const l = await import(name);",
        'const m = require("./m1");',
        "const n = require(`./n${1}`);",
        "const o = await import(`./o1`);",
      ].join("\n"),
    });
    expect(file!.syntaxErrors).toEqual([]);
    expect(file!.imports.map((i) => [i.line, i.kind, i.specifier, i.isTypeOnly])).toEqual([
      [1, "import", "./a1", false],
      [2, "type-only", "./b1", true],
      [3, "type-only", "./c1", true],
      [4, "import", "./e1", false],
      [5, "side-effect", "./side-effect", false],
      [6, "re-export", "./g1", false],
      [7, "re-export", "./h1", true],
      [8, "require", "./i1", false],
      [9, "type-only", "./j1", true],
      [10, "dynamic", "./k1", false],
      [11, "dynamic", null, false],
      [12, "require", "./m1", false],
      [13, "require", null, false],
      [14, "dynamic", "./o1", false],
    ]);
    expect(file!.imports[0]).toMatchObject({ line: 1, column: 1 });
  });

  test("a property named require is not an import", () => {
    const [file] = parse({ "src/a.js": 'const x = loader.require("./x");\n' });
    expect(file!.imports).toEqual([]);
  });
});

describe("exports", () => {
  test("lists top-level exports with kinds, keeping default export names", () => {
    const [file] = parse({
      "src/a.ts": [
        "export function f() {}",
        "export class OrderService {}",
        "export interface I {}",
        "export type T = string;",
        "export enum E { A }",
        "export const a = 1, b = 2;",
        "export namespace N {}",
        "const hidden = 1;",
        "export { hidden as visible };",
        "export default class Main {}",
      ].join("\n"),
    });
    expect(file!.exports.map((e) => [e.name, e.kind, e.isDefault])).toEqual([
      ["f", "function", false],
      ["OrderService", "class", false],
      ["I", "interface", false],
      ["T", "type", false],
      ["E", "enum", false],
      ["a", "variable", false],
      ["b", "variable", false],
      ["N", "namespace", false],
      ["visible", "value", false],
      ["Main", "class", true],
    ]);
  });

  test("export default of an expression is named default", () => {
    const [file] = parse({ "src/a.ts": "export default 42;\n" });
    expect(file!.exports).toEqual([expect.objectContaining({ name: "default", isDefault: true })]);
  });
});

describe("syntax errors", () => {
  test("a truncated file reports errors instead of throwing", () => {
    const [file] = parse({ "src/a.ts": "export function broken(a: string {\n  return `x ${a\n" });
    expect(file!.syntaxErrors.length).toBeGreaterThan(0);
    expect(file!.syntaxErrors[0]).toMatchObject({ line: expect.any(Number), code: expect.any(Number) });
  });

  test("TSX and JSX parse by extension", () => {
    const files = parse({
      "src/view.tsx": "export const V = () => <div className=\"x\">{1}</div>;\n",
      "src/view.jsx": "export const W = () => <span />;\n",
    });
    expect(files.map((f) => f.syntaxErrors)).toEqual([[], []]);
  });

  test("results are sorted by path regardless of input order", () => {
    const files = parse({ "src/z.ts": "", "src/a.ts": "" });
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/z.ts"]);
  });
});

describe("golden fixtures", () => {
  test("unresolved: one literal import, one literal dynamic import, one opaque dynamic import", () => {
    const [file] = parseSourceFiles(join(goldenRoot(), "unresolved", "repo"), ["src/services/export.service.ts"]);
    expect(file!.imports.map((i) => [i.kind, i.specifier])).toEqual([
      ["import", "../lib/csv-writer"],
      ["dynamic", "../domain/order"],
      ["dynamic", null],
    ]);
  });

  test("unreadable-files: the truncated service has syntax errors", () => {
    const [file] = parseSourceFiles(join(goldenRoot(), "unreadable-files", "repo"), ["src/services/truncated.service.ts"]);
    expect(file!.syntaxErrors.length).toBeGreaterThan(0);
  });

  test("valid-architecture: OrderService is an exported class", () => {
    const [file] = parseSourceFiles(join(goldenRoot(), "valid-architecture", "repo"), ["src/services/order.service.ts"]);
    expect(file!.exports).toEqual([expect.objectContaining({ name: "OrderService", kind: "class" })]);
  });
});
