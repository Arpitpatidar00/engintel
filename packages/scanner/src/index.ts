// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

export {
  ALWAYS_SKIPPED,
  SOURCE_EXTENSIONS,
  ScanError,
  isSourcePath,
  scanRepository,
  type FileKind,
  type FileStatus,
  type ScanOptions,
  type ScanResult,
  type ScannedFile,
  type UnreadableReason,
} from "./scan.js";

export {
  GitError,
  changedFilesSince,
  git,
  isGitWorkTree,
  mergeBase,
  resolveCommit,
  showFileAt,
  type ChangedFiles,
  type GitErrorCode,
} from "./git.js";
