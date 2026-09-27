// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

/**
 * Runs the engintel CLI for end-to-end tests. Phase 0 has no CLI, so this is a
 * stub with the final signature: every call returns exit code 2 (tool error)
 * and the coded error E_NOT_IMPLEMENTED. ENG-008 replaces the body; tests
 * written against this signature keep working.
 */

export interface CliRunOptions {
  /** Working directory, usually a materialized scenario. */
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface CliRunResult {
  /** 0 pass, 1 blocking violations, 2 tool error, 3 invalid config (research doc 17). */
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly stdout: string;
  readonly stderr: string;
  /** Machine-readable failure code when the run could not complete. */
  readonly errorCode: string | null;
}

export const E_NOT_IMPLEMENTED = "E_NOT_IMPLEMENTED";

export function runCli(args: readonly string[], _options: CliRunOptions): Promise<CliRunResult> {
  return Promise.resolve({
    exitCode: 2,
    stdout: "",
    stderr: `engintel ${args.join(" ")}: not implemented in Phase 0 (ENG-008)\n`,
    errorCode: E_NOT_IMPLEMENTED,
  });
}
