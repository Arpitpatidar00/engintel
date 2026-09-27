// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

export {
  CANONICAL_REPO_PATH_PATTERN,
  RepoPathError,
  isCanonicalRepoPath,
  isInsideRoot,
  normalizeRepoPath,
  resolveInsideRoot,
  toPosix,
  toRepoRelative,
  type RepoPathErrorCode,
} from "./paths.js";

export {
  ADAPTERS,
  DIAGNOSTIC_SCHEMA_VERSION,
  DiagnosticSchema,
  EDGE_KINDS,
  FORBIDDEN_DIAGNOSTIC_KEYS,
  NodeRefSchema,
  RepoPathSchema,
  SEVERITIES,
  SUGGESTION_KINDS,
  diagnosticJsonSchema,
  type Adapter,
  type Diagnostic,
  type EdgeKind,
  type Severity,
} from "./diagnostic.js";
