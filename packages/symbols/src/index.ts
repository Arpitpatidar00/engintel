// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

export {
  parseSourceFiles,
  scriptKindOf,
  type ExportDecl,
  type ExportKind,
  type ImportDecl,
  type ImportKind,
  type ParseDiagnostic,
  type ParsedFile,
} from "./parse.js";

export { DEFAULT_COMPILER_OPTIONS, TsConfigError, createProjectProgram, discoverProjects, type TsProject } from "./program.js";
export { extractSymbols, type SymbolExtraction, type SymbolRecord } from "./symbols.js";
