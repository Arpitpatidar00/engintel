// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { ConfigError, RepoPathError } from "@engintel/config";
import { GraphError } from "@engintel/graph";
import { ScanError } from "@engintel/scanner";

/**
 * A run that could not produce a trustworthy verdict. Always exit code 2:
 * a tool, configuration, or contract problem is never reported as a pass
 * (FR-004, D-009, doc 23).
 */
export class ToolError extends Error {
  readonly code: string;
  /** Repo path of the offending file, when there is one. */
  readonly file: string | null;
  readonly issues: readonly { readonly path: string; readonly message: string }[];

  constructor(code: string, message: string, options: { file?: string | null; issues?: ToolError["issues"]; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "ToolError";
    this.code = code;
    this.file = options.file ?? null;
    this.issues = options.issues ?? [];
  }
}

/** Map any failure from the pipeline's packages to a ToolError. Unknown errors keep their message. */
export function toToolError(error: unknown): ToolError {
  if (error instanceof ToolError) return error;
  if (error instanceof ConfigError) return new ToolError(error.code, error.message, { file: error.file, issues: error.issues, cause: error });
  if (error instanceof ScanError || error instanceof GraphError) return new ToolError(error.code, error.message, { cause: error });
  if (error instanceof RepoPathError) return new ToolError(error.code, error.message, { cause: error });
  return new ToolError("E_INTERNAL", `internal error: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}
