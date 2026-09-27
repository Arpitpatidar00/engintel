// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * Parse-only source analysis with the TypeScript compiler API (D-002).
 *
 * One program over the given files with `noResolve` and `noLib`: every file is
 * parsed, nothing is resolved or type-checked, and no repository code runs.
 * This is what validation needs and dependency-cruiser cannot supply:
 *   - syntax errors, so unparseable files fail closed (D-009);
 *   - imports whose target cannot be known statically (`import(x)`,
 *     `require(x)`), which cruiser silently omits;
 *   - source positions for every import, and top-level exports.
 */

export type ImportKind = "import" | "type-only" | "re-export" | "dynamic" | "require" | "side-effect";

export interface ImportDecl {
  /** The module specifier as written, or null when it is not a string literal. */
  readonly specifier: string | null;
  readonly kind: ImportKind;
  readonly isTypeOnly: boolean;
  /** 1-based. */
  readonly line: number;
  readonly column: number;
}

export type ExportKind = "function" | "class" | "interface" | "type" | "enum" | "variable" | "namespace" | "value";

export interface ExportDecl {
  readonly name: string;
  readonly kind: ExportKind;
  readonly isDefault: boolean;
  readonly line: number;
  readonly column: number;
}

export interface ParseDiagnostic {
  readonly code: number;
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

export interface ParsedFile {
  /** Canonical repo path. */
  readonly path: string;
  readonly syntaxErrors: readonly ParseDiagnostic[];
  readonly imports: readonly ImportDecl[];
  readonly exports: readonly ExportDecl[];
}

export function scriptKindOf(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const PARSE_OPTIONS: ts.CompilerOptions = {
  noResolve: true,
  noLib: true,
  types: [],
  allowJs: true,
  noEmit: true,
  target: ts.ScriptTarget.Latest,
  jsx: ts.JsxEmit.Preserve,
};

/**
 * Parse `paths` (canonical repo paths of readable source files) under `root`.
 * Results are sorted by path; imports and exports by position.
 */
export function parseSourceFiles(root: string, paths: readonly string[]): ParsedFile[] {
  const sorted = [...paths].sort();
  const toAbsolute = (p: string) => join(root, ...p.split("/"));
  const sources = new Map<string, ts.SourceFile>();
  for (const path of sorted) {
    const text = readFileSync(toAbsolute(path), "utf8");
    sources.set(
      toAbsolute(path),
      ts.createSourceFile(toAbsolute(path), text, ts.ScriptTarget.Latest, true, scriptKindOf(path)),
    );
  }

  const host: ts.CompilerHost = {
    getSourceFile: (fileName) => sources.get(fileName),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {
      throw new Error("the parse host never writes");
    },
    getCurrentDirectory: () => root,
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => sources.has(f),
    readFile: () => undefined,
  };
  const program = ts.createProgram({ rootNames: [...sources.keys()], options: PARSE_OPTIONS, host });

  return sorted.map((path) => {
    const sf = sources.get(toAbsolute(path));
    if (!sf) throw new Error(`internal: ${path} was not parsed`);
    const syntaxErrors = program
      .getSyntacticDiagnostics(sf)
      .filter((d) => d.category === ts.DiagnosticCategory.Error)
      .map((d) => ({
        code: d.code,
        message: ts.flattenDiagnosticMessageText(d.messageText, " "),
        ...position(sf, d.start ?? 0),
      }));
    return { path, syntaxErrors, imports: collectImports(sf), exports: collectExports(sf) };
  });
}

function position(sf: ts.SourceFile, pos: number): { line: number; column: number } {
  const { line, character } = sf.getLineAndCharacterOfPosition(pos);
  return { line: line + 1, column: character + 1 };
}

function literalText(node: ts.Node | undefined): string | null {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  return null;
}

function collectImports(sf: ts.SourceFile): ImportDecl[] {
  const out: ImportDecl[] = [];
  const add = (node: ts.Node, specifier: string | null, kind: ImportKind, isTypeOnly = false) =>
    out.push({ specifier, kind, isTypeOnly, ...position(sf, node.getStart(sf)) });

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = literalText(node.moduleSpecifier);
      const clause = node.importClause;
      if (!clause) {
        add(node, specifier, "side-effect");
      } else {
        const named = clause.namedBindings;
        const allNamedTypeOnly =
          !clause.name && named !== undefined && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
        const typeOnly = clause.isTypeOnly || allNamedTypeOnly;
        add(node, specifier, typeOnly ? "type-only" : "import", typeOnly);
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(node, literalText(node.moduleSpecifier), "re-export", node.isTypeOnly);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, literalText(node.moduleReference.expression), node.isTypeOnly ? "type-only" : "require", node.isTypeOnly);
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      const specifier = ts.isLiteralTypeNode(argument) ? literalText(argument.literal) : null;
      add(node, specifier, "type-only", true);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add(node, literalText(node.arguments[0]), "dynamic");
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1) {
        add(node, literalText(node.arguments[0]), "require");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);
}

function collectExports(sf: ts.SourceFile): ExportDecl[] {
  const out: ExportDecl[] = [];
  const add = (node: ts.Node, name: string, kind: ExportKind, isDefault = false) =>
    out.push({ name, kind, isDefault, ...position(sf, node.getStart(sf)) });

  for (const statement of sf.statements) {
    if (ts.isExportAssignment(statement)) {
      add(statement, "default", "value", true);
      continue;
    }
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) add(element, element.name.text, "value");
      continue;
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
    const named = (name: ts.Identifier | undefined, kind: ExportKind) =>
      add(statement, name?.text ?? "default", kind, isDefault);
    if (ts.isFunctionDeclaration(statement)) named(statement.name, "function");
    else if (ts.isClassDeclaration(statement)) named(statement.name, "class");
    else if (ts.isInterfaceDeclaration(statement)) named(statement.name, "interface");
    else if (ts.isTypeAliasDeclaration(statement)) named(statement.name, "type");
    else if (ts.isEnumDeclaration(statement)) named(statement.name, "enum");
    else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) named(statement.name, "namespace");
    else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) add(declaration, declaration.name.text, "variable");
      }
    }
  }
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}
