// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

export {
  IDENTITY_SEPARATOR,
  IDENTITY_TOKENS,
  IDENTITY_VERSION,
  IdentityError,
  identityPayload,
  normalizeCycleSignature,
  normalizeIdentityNode,
  violationIdentity,
  type IdentityInput,
} from "./identity.js";

export {
  compareDiagnostics,
  evaluate,
  type EvaluationInput,
  type EvaluationResult,
  type ExceptionApplication,
  type ExportedSymbol,
  type FileFacts,
  type Finding,
  type ImportSite,
  type Scope,
  type SourceFileState,
  type UnanalyzableEntry,
} from "./evaluate.js";

export {
  BUILTIN_RULES,
  cycleViolation,
  forbiddenEdge,
  intraLayerEdge,
  missingRequired,
  notAllowedEdge,
  opaqueImport,
  overlappingLayers,
  toDiagnostic,
  unanalyzableFile,
  unlayeredFile,
  unreachable,
  unresolvedImport,
  type ContractSeverity,
  type EdgeFacts,
  type ExampleSymbol,
  type Position,
  type Suggestion,
  type Violation,
} from "./diagnostics.js";

export { LayerIndex, describeRef, globMatcher, matchesAnyGlob, refLayers } from "./layers.js";
export { LayerGraph, allowedTargets } from "./routes.js";

export {
  BASELINE_FORBIDDEN_RULES,
  applyBaseline,
  baselineCandidates,
  checkBaselineIntegrity,
  isBaselineEligible,
  type BaselineIntegrityIssue,
} from "./baseline.js";
