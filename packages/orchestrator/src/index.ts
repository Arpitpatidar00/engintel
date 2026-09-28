// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

export { ToolError, toToolError } from "./errors.js";
export {
  ENGINE_VERSION,
  GRAPH_CACHE_PATH,
  SYMBOLS_CACHE_PATH,
  analyzeRepository,
  changedScopeFromGit,
  validateRepository,
  writeInsideEngintel,
  type AnalyzeOptions,
  type GitScope,
  type PipelineOptions,
  type ValidateOptions,
} from "./pipeline.js";
export {
  REPORT_SCHEMA_VERSION,
  type BaselineSection,
  serializeReport,
  type AnalysisReport,
  type ContractSummary,
  type ErrorReport,
  type Report,
  type ValidationReport,
} from "./report.js";
export { buildBaseline, writeBaseline, type BaselineWriteOptions, type BaselineWriteResult } from "./baseline-write.js";
