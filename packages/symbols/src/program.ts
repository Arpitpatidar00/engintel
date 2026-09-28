// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isCanonicalRepoPath, normalizeRepoPath } from "@engintel/config";
import ts from "typescript";

/**
 * TypeScript program factory (ENG-004; research doc 04, section 4). One
 * program per tsconfig project, following project references; solution-style
 * roots (references only) contribute no files of their own. Configs are read
 * as data by the compiler's own parser: nothing in them can run code, and
 * `plugins` is always cleared. The host never writes.
 */

export class TsConfigError extends Error {
  readonly code = "E_TSCONFIG_INVALID";
  /** Repo path of the offending tsconfig. */
  readonly file: string;

  constructor(file: string, message: string) {
    super(message);
    this.name = "TsConfigError";
    this.file = file;
  }
}

export interface TsProject {
  /** Repo path of the tsconfig, or null for the default project. */
  readonly configFile: string | null;
  readonly options: ts.CompilerOptions;
  /** Canonical repo paths the project includes, sorted. */
  readonly fileNames: readonly string[];
}

/** Options for files no tsconfig claims. */
export const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  target: ts.ScriptTarget.Latest,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  jsx: ts.JsxEmit.Preserve,
  strict: true,
  types: [],
};

/** "No inputs were found in config file": an empty project is not an error. */
const NO_INPUTS = 18003;

function toRepoPath(root: string, absolute: string): string | null {
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || resolve(root, rel) !== resolve(absolute)) return null;
  const path = rel.split(sep).join("/");
  return isCanonicalRepoPath(path) ? path : null;
}

function formatDiagnostic(d: ts.Diagnostic): string {
  // Message and position only; compiler messages about configs quote option names, not source.
  return ts.flattenDiagnosticMessageText(d.messageText, " ");
}

/**
 * Parse `tsconfig` (a repo path) and every project it references,
 * depth-first in reference order. Returns [] when the entry tsconfig does not
 * exist; a missing referenced project is an error.
 */
export function discoverProjects(rootInput: string, tsconfig = "tsconfig.json"): TsProject[] {
  const root = resolve(rootInput);
  const projects: TsProject[] = [];
  const visited = new Set<string>();

  const visit = (absolute: string, isEntry: boolean): void => {
    // As tsc: a reference that is not a .json file names a directory holding tsconfig.json.
    const isDirectory = !absolute.endsWith(".json") || (existsSync(absolute) && statSync(absolute).isDirectory());
    const configPath = isDirectory ? join(absolute, "tsconfig.json") : absolute;
    const repoPath = toRepoPath(root, configPath);
    if (repoPath === null) return; // references outside the repository are not ours to analyze
    if (visited.has(repoPath)) return;
    visited.add(repoPath);
    if (!existsSync(configPath)) {
      if (isEntry) return; // no tsconfig at all: every file goes to the default project
      throw new TsConfigError(repoPath, `${repoPath} is referenced but does not exist`);
    }

    const read = ts.readConfigFile(configPath, (p) => ts.sys.readFile(p));
    if (read.error) throw new TsConfigError(repoPath, `${repoPath}: ${formatDiagnostic(read.error)}`);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath);
    const errors = parsed.errors.filter((e) => e.code !== NO_INPUTS && e.category === ts.DiagnosticCategory.Error);
    if (errors[0]) throw new TsConfigError(repoPath, `${repoPath}: ${formatDiagnostic(errors[0])}`);

    const fileNames = [...new Set(parsed.fileNames.map((f) => toRepoPath(root, resolve(f))).filter((p): p is string => p !== null))].sort();
    if (fileNames.length > 0) projects.push({ configFile: repoPath, options: { ...parsed.options, plugins: [] }, fileNames });
    for (const reference of parsed.projectReferences ?? []) visit(resolve(dirname(configPath), reference.path), false);
  };

  visit(join(root, ...normalizeRepoPath(tsconfig).split("/")), true);
  return projects;
}

/** A program over `rootNames` (repo paths) with the project's options. Never emits. */
export function createProjectProgram(rootInput: string, options: ts.CompilerOptions, rootNames: readonly string[]): ts.Program {
  const root = resolve(rootInput);
  const compilerOptions: ts.CompilerOptions = {
    ...options,
    noEmit: true,
    skipLibCheck: true,
    incremental: false,
    composite: false,
    declaration: false,
    plugins: [],
    types: options.types ?? [],
  };
  delete compilerOptions.tsBuildInfoFile;
  delete compilerOptions.outDir;
  const host = ts.createCompilerHost(compilerOptions, true);
  host.writeFile = () => {
    throw new Error("the symbols compiler host never writes");
  };
  host.useCaseSensitiveFileNames = () => true;
  host.getCurrentDirectory = () => root;
  return ts.createProgram({ rootNames: rootNames.map((p) => join(root, ...p.split("/"))), options: compilerOptions, host });
}
