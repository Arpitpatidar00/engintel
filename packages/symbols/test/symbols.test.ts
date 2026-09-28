// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { goldenRoot } from "@engintel/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { TsConfigError, discoverProjects, extractSymbols } from "../src/index.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "engintel-symbols-"));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

/** A solution-style root with two referenced projects, one of which maps paths. */
const MONOREPO = {
  "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./packages/core" }, { path: "./packages/app/tsconfig.app.json" }] }),
  "packages/core/tsconfig.json": JSON.stringify({ compilerOptions: { composite: true, strict: true, module: "nodenext", target: "es2022" }, include: ["src"] }),
  "packages/core/src/ids.ts": 'export type UserId = string & { readonly __brand: "UserId" };\nexport const toUserId = (raw: string): UserId => raw as UserId;\n',
  "packages/core/src/user.ts": [
    'import type { UserId } from "./ids.js";',
    "export interface User { id: UserId; name: string }",
    "export class UserService { find(id: UserId): User | undefined { return undefined; } }",
    "export enum Role { Admin, Member }",
    "export namespace Legacy { export const flag = true; }",
    "export default function makeUser(id: UserId): User { return { id, name: \"\" }; }",
    "",
  ].join("\n"),
  "packages/core/src/index.ts": 'export * from "./user.js";\nexport { toUserId } from "./ids.js";\nexport type { UserId } from "./ids.js";\n',
  "packages/app/tsconfig.app.json": JSON.stringify({ compilerOptions: { strict: true, module: "nodenext", target: "es2022" }, include: ["main.ts"], references: [{ path: "../core" }] }),
  "packages/app/main.ts": 'import { UserService } from "../core/src/index.js";\nexport const service = new UserService();\n',
  "scripts/tool.js": "module.exports.run = function run() {};\nexport const x = 1;\n",
  "generated/ignored.ts": "export type UserId = number;\n",
};

describe("discoverProjects (ENG-004)", () => {
  test("follows project references; a solution-style root contributes no files", () => {
    const root = tree(MONOREPO);
    expect(discoverProjects(root).map((p) => [p.configFile, p.fileNames])).toEqual([
      ["packages/core/tsconfig.json", ["packages/core/src/ids.ts", "packages/core/src/index.ts", "packages/core/src/user.ts"]],
      ["packages/app/tsconfig.app.json", ["packages/app/main.ts"]],
    ]);
  });

  test("no tsconfig means no projects", () => {
    expect(discoverProjects(tree({ "a.ts": "" }))).toEqual([]);
  });

  test("an invalid or missing referenced tsconfig is a coded error", () => {
    expect(() => discoverProjects(tree({ "tsconfig.json": "{ nope" }))).toThrow(TsConfigError);
    expect(() => discoverProjects(tree({ "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./missing" }] }) }))).toThrow(
      expect.objectContaining({ code: "E_TSCONFIG_INVALID", file: "missing/tsconfig.json" }),
    );
    expect(() => discoverProjects(tree({ "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./gone.json" }] }) }))).toThrow(
      expect.objectContaining({ file: "gone.json" }),
    );
    expect(() => discoverProjects(tree({ "tsconfig.json": JSON.stringify({ compilerOptions: { target: "es1999" } }) }))).toThrow(TsConfigError);
  });

  test("plugins in a tsconfig are cleared", () => {
    const root = tree({ "tsconfig.json": JSON.stringify({ compilerOptions: { plugins: [{ name: "evil-plugin" }] } }), "a.ts": "export const a = 1;\n" });
    expect(discoverProjects(root)[0]?.options.plugins).toEqual([]);
  });

  test("reference cycles terminate", () => {
    const root = tree({
      "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./a" }] }),
      "a/tsconfig.json": JSON.stringify({ include: ["*.ts"], references: [{ path: "../b" }] }),
      "b/tsconfig.json": JSON.stringify({ include: ["*.ts"], references: [{ path: "../a" }] }),
      "a/x.ts": "export const x = 1;\n",
      "b/y.ts": "export const y = 1;\n",
    });
    expect(discoverProjects(root).map((p) => p.configFile)).toEqual(["a/tsconfig.json", "b/tsconfig.json"]);
  });
});

describe("extractSymbols (ENG-029)", () => {
  const root = () => tree(MONOREPO);
  const analyzable = Object.keys(MONOREPO).filter((p) => /\.(ts|js)$/.test(p) && !p.startsWith("generated/"));

  test("the golden UserId type is found with its kind, declaration, and type", () => {
    const { symbols } = extractSymbols(root(), analyzable);
    expect(symbols.filter((s) => s.name === "UserId")).toEqual([
      {
        file: "packages/core/src/ids.ts",
        name: "UserId",
        kind: "type",
        isDefault: false,
        isTypeOnly: true,
        declaration: { file: "packages/core/src/ids.ts", line: 1, column: 1 },
        typeString: "UserId",
      },
      {
        file: "packages/core/src/index.ts",
        name: "UserId",
        kind: "type",
        isDefault: false,
        isTypeOnly: true,
        declaration: { file: "packages/core/src/ids.ts", line: 1, column: 1 },
        typeString: "UserId",
      },
    ]);
  });

  test("ignored paths are never reported", () => {
    const { symbols } = extractSymbols(root(), analyzable);
    expect(symbols.some((s) => s.file.startsWith("generated/"))).toBe(false);
  });

  test("kinds, default exports, re-exports through export *, and value types", () => {
    const { symbols } = extractSymbols(root(), analyzable);
    const at = (file: string) => symbols.filter((s) => s.file === file).map((s) => [s.name, s.kind, s.isDefault, s.isTypeOnly]);
    expect(at("packages/core/src/user.ts")).toEqual([
      ["Legacy", "namespace", false, false],
      ["Role", "enum", false, false],
      ["User", "interface", false, true],
      ["UserService", "class", false, false],
      ["default", "function", true, false],
    ]);
    // export * re-exports everything but the default.
    expect(at("packages/core/src/index.ts").map(([name]) => name)).toEqual(["Legacy", "Role", "User", "UserId", "UserService", "toUserId"]);
    const toUserId = symbols.find((s) => s.file === "packages/core/src/index.ts" && s.name === "toUserId");
    expect(toUserId).toMatchObject({ kind: "variable", declaration: { file: "packages/core/src/ids.ts", line: 2 }, typeString: "(raw: string) => UserId" });
  });

  test("files outside every project use the default project, including JS", () => {
    const result = extractSymbols(root(), analyzable);
    expect(result.projects).toEqual([
      { configFile: "packages/core/tsconfig.json", files: 3 },
      { configFile: "packages/app/tsconfig.app.json", files: 1 },
      { configFile: null, files: 1 },
    ]);
    expect(result.symbols.filter((s) => s.file === "scripts/tool.js").map((s) => s.name)).toEqual(["x"]);
  });

  test("golden fixture: exports of the service layer, and nothing from unanalyzable files", () => {
    const repo = join(goldenRoot(), "unreadable-files", "repo");
    const { symbols } = extractSymbols(repo, ["src/services/order.service.ts", "src/domain/order.ts"]);
    expect(symbols.map((s) => `${s.file}#${s.name}:${s.kind}`)).toEqual([
      "src/domain/order.ts#Order:interface",
      "src/domain/order.ts#orderTotal:function",
      "src/services/order.service.ts#OrderService:class",
    ]);
  });

  test("deterministic across runs, and free of machine paths", () => {
    const dir = root();
    const first = JSON.stringify(extractSymbols(dir, analyzable));
    expect(JSON.stringify(extractSymbols(dir, [...analyzable].reverse()))).toBe(first);
    expect(first).not.toContain(dir);
    expect(first).not.toContain(tmpdir());
  });

  test("a type used across files prints repo-relative, never as an absolute import()", () => {
    const dir = tree({
      "a.ts": "export interface Money { cents: number }\n",
      "b.ts": 'import type { Money } from "./a";\nexport const zero = (): Money => ({ cents: 0 });\n',
    });
    const zero = extractSymbols(dir, ["a.ts", "b.ts"]).symbols.find((s) => s.name === "zero");
    expect(zero?.typeString).toBe("() => Money");
  });
});
