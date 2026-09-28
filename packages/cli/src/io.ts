// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

/** The process boundary the CLI talks to, injected so tests can run it in-process. */
export interface CliIO {
  readonly stdout: { write(chunk: string): unknown; readonly isTTY?: boolean | undefined };
  readonly stderr: { write(chunk: string): unknown };
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Today's UTC date, YYYY-MM-DD. The only place the CLI reads a clock. */
  readonly today: () => string;
}
