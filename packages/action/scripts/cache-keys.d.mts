// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

export declare const LOCKFILES: readonly string[];
export declare function hashFiles(root: string, files: readonly string[]): string;
export declare function engintelSources(engintelRoot: string): string[];
export declare function computeKeys(input: {
  engintelRoot: string;
  workspace: string;
  os: string;
  nodeVersion: string;
  sha: string;
}): { buildKey: string; graphKey: string; graphRestorePrefix: string; engineVersion: string };
