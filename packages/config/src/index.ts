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

export {
  ARCHITECTURE_SCHEMA_VERSION,
  ArchitectureContractSchema,
  CONTRACT_SEVERITIES,
  ExceptionSchema,
  GLOB_PATTERN,
  LayerRefSchema,
  LayerSchema,
  NamingRuleSchema,
  RuleSchema,
  UnsupportedPathSchema,
  architectureJsonSchema,
  type ArchitectureContract,
  type ArchitectureContractInput,
  type ArchitectureRule,
  type LayerRef,
} from "./architecture.js";

export {
  FORBIDDEN_AUTHORITY_KEYS,
  MERGE_AUTHORITY,
  TRUST_ZONES,
  findAuthorityClaims,
  type ForbiddenAuthorityKey,
  type NoAuthorityClaims,
  type TrustZone,
} from "./trust.js";

export {
  CONTRACT_PATH,
  ConfigError,
  MAX_CONFIG_FILE_BYTES,
  MAX_EXCEPTION_LIFETIME_DAYS,
  canonicalJson,
  formatIssuePath,
  loadContract,
  parseContract,
  readRepoJson,
  sha256Hex,
  zodIssues,
  type ConfigErrorCode,
  type ConfigIssue,
  type LoadedContract,
} from "./load.js";
