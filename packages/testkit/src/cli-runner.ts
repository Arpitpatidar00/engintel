// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findWorkspaceRoot } from "./golden.js";

/**
 * Runs the built engintel CLI (packages/cli/dist/bin.js) in a child process
 * for end-to-end tests. Build the CLI first; the cli package's test task
 * depends on its own build.
 */

export interface CliRunOptions {
  /** Working directory, usually a materialized scenario. */
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Default 60 000 ms. */
  readonly timeoutMs?: number;
}

export interface CliRunResult {
  /** 0 pass, 1 blocking violations, 2 tool, configuration, contract, or usage error. */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Machine-readable failure code ("E_CONTRACT_MISSING", ...) when the run could not complete. */
  readonly errorCode: string | null;
}

/** Returned when the CLI has not been built; tests should fail loudly rather than skip. */
export const E_CLI_NOT_BUILT = "E_CLI_NOT_BUILT";

export function cliBinPath(workspaceRoot: string = findWorkspaceRoot()): string {
  return join(workspaceRoot, "packages", "cli", "dist", "bin.js");
}

export function runCli(args: readonly string[], options: CliRunOptions): Promise<CliRunResult> {
  const bin = cliBinPath();
  if (!existsSync(bin)) {
    return Promise.resolve({ exitCode: 2, stdout: "", stderr: `${bin} does not exist; run pnpm build first\n`, errorCode: E_CLI_NOT_BUILT });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: options.cwd,
      // A clean, color-free environment so output is comparable across machines.
      env: { PATH: process.env["PATH"] ?? "", NO_COLOR: "1", ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs ?? 60_000,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      const errorCode = /engintel: error (E_[A-Z0-9_]+)/.exec(stderr)?.[1] ?? null;
      resolve({ exitCode: code ?? (signal ? 128 : 2), stdout, stderr, errorCode });
    });
  });
}
