// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { join, relative, resolve, sep } from "node:path";
import { isCanonicalRepoPath } from "@engintel/config";
import ts from "typescript";
import type { ExportKind } from "./parse.js";
import { DEFAULT_COMPILER_OPTIONS, createProjectProgram, discoverProjects, type TsProject } from "./program.js";

/**
 * Checker-backed symbol extraction (ENG-029; FR-002). For every analyzable
 * file, the names it exports as the compiler sees them: re-exports and
 * `export *` resolved, merged declarations collapsed, with the declared kind,
 * position, and a type string. Only the files passed in are reported, so
 * ignored and unanalyzable paths never appear. Input to search in later phases.
 */

export interface SymbolRecord {
  /** Module that exports the name (canonical repo path). */
  readonly file: string;
  readonly name: string;
  readonly kind: ExportKind;
  readonly isDefault: boolean;
  /** Types and interfaces, or names exported with `export type`. */
  readonly isTypeOnly: boolean;
  /** Where the symbol is declared. file is null when that is outside the repository (e.g. a package). */
  readonly declaration: { readonly file: string | null; readonly line: number; readonly column: number } | null;
  /** checker.typeToString, at most 200 characters. */
  readonly typeString: string | null;
}

export interface SymbolExtraction {
  readonly symbols: readonly SymbolRecord[];
  /** Which project analyzed which files; configFile null is the default project. */
  readonly projects: readonly { readonly configFile: string | null; readonly files: number }[];
}

const MAX_TYPE_STRING = 200;

function kindOf(symbol: ts.Symbol): ExportKind {
  const f = symbol.flags;
  if (f & ts.SymbolFlags.Class) return "class";
  if (f & ts.SymbolFlags.Function) return "function";
  if (f & ts.SymbolFlags.Enum) return "enum";
  if (f & ts.SymbolFlags.Interface) return "interface";
  if (f & ts.SymbolFlags.TypeAlias) return "type";
  if (f & ts.SymbolFlags.Variable) return "variable";
  if (f & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule)) return "namespace";
  return "value";
}

function typeStringOf(checker: ts.TypeChecker, symbol: ts.Symbol, declaration: ts.Declaration | undefined, root: string): string | null {
  try {
    const type =
      symbol.flags & ts.SymbolFlags.Value && declaration
        ? checker.getTypeOfSymbolAtLocation(symbol, declaration)
        : checker.getDeclaredTypeOfSymbol(symbol);
    // Printed relative to the declaration, so names read as they do in the source.
    // Types not in scope there print as import("<absolute path>"); keep them repo-relative
    // so the output is the same on every machine and leaks no local paths.
    const text = checker
      .typeToString(type, declaration, ts.TypeFormatFlags.NoTruncation)
      .replaceAll(`import("${root.split(sep).join("/")}/`, 'import("');
    return text.length > MAX_TYPE_STRING ? `${text.slice(0, MAX_TYPE_STRING - 1)}…` : text;
  } catch {
    return null;
  }
}

function isTypeOnlyExport(exported: ts.Symbol): boolean {
  return (exported.declarations ?? []).some(
    (d) => (ts.isExportSpecifier(d) && (d.isTypeOnly || d.parent.parent.isTypeOnly)) || (ts.isImportSpecifier(d) && d.isTypeOnly),
  );
}

export function extractSymbols(rootInput: string, files: readonly string[], options: { readonly tsconfig?: string } = {}): SymbolExtraction {
  const root = resolve(rootInput);
  const wanted = new Set(files);
  const projects = discoverProjects(root, options.tsconfig);
  const assigned = new Map<TsProject, string[]>();
  const claimed = new Set<string>();
  for (const project of projects) {
    const mine = project.fileNames.filter((f) => wanted.has(f) && !claimed.has(f));
    for (const f of mine) claimed.add(f);
    if (mine.length > 0) assigned.set(project, mine);
  }
  const rest = [...wanted].filter((f) => !claimed.has(f)).sort();
  if (rest.length > 0) assigned.set({ configFile: null, options: DEFAULT_COMPILER_OPTIONS, fileNames: rest }, rest);

  const toRepo = (fileName: string): string | null => {
    const rel = relative(root, resolve(fileName));
    if (rel.startsWith("..") || rel === "") return null;
    const path = rel.split(sep).join("/");
    return isCanonicalRepoPath(path) && !path.split("/").includes("node_modules") ? path : null;
  };

  const symbols: SymbolRecord[] = [];
  for (const [project, projectFiles] of assigned) {
    const program = createProjectProgram(root, project.options, projectFiles);
    const checker = program.getTypeChecker();
    for (const file of projectFiles) {
      const sourceFile = program.getSourceFile(join(root, ...file.split("/")));
      if (!sourceFile) continue;
      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      if (!moduleSymbol) continue; // a script, not a module: no exports
      for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        const resolvedSymbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
        const declaration = resolvedSymbol.declarations?.[0];
        let where: SymbolRecord["declaration"] = null;
        if (declaration) {
          const declFile = declaration.getSourceFile();
          const { line, character } = declFile.getLineAndCharacterOfPosition(declaration.getStart(declFile));
          where = { file: toRepo(declFile.fileName), line: line + 1, column: character + 1 };
        }
        const kind = kindOf(resolvedSymbol);
        const name = exported.escapedName === "default" ? "default" : exported.name;
        symbols.push({
          file,
          name,
          kind,
          isDefault: name === "default",
          isTypeOnly: isTypeOnlyExport(exported) || (resolvedSymbol.flags & ts.SymbolFlags.Value) === 0,
          declaration: where,
          typeString: typeStringOf(checker, resolvedSymbol, declaration, root),
        });
      }
    }
  }
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  symbols.sort((a, b) => compare(a.file, b.file) || compare(a.name, b.name));
  return {
    symbols,
    projects: [...assigned].map(([project, projectFiles]) => ({ configFile: project.configFile, files: projectFiles.length })),
  };
}
