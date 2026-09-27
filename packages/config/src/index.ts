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
