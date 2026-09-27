// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import nodePath from "node:path";

/**
 * Canonical repository paths.
 *
 * Every path EngIntel stores, hashes, or reports is canonical: POSIX
 * separators, repo-relative, Unicode NFC, case preserved, no leading "./",
 * no "." or ".." segments, no empty segments, no trailing slash, no ":". Two
 * checkouts of the same bytes on Windows and Linux produce identical paths,
 * so violation identities do not churn (research docs 04, 08, 19).
 *
 * Conversion happens once, at the operating-system boundary (`toPosix`,
 * `toRepoRelative`). Serialized data must already be canonical
 * (`isCanonicalRepoPath`, `CANONICAL_REPO_PATH_PATTERN`).
 *
 * These helpers are lexical. They never touch the filesystem and never
 * follow symlinks; the scanner resolves real paths and then checks them with
 * `isInsideRoot`.
 */

export type RepoPathErrorCode =
  | "E_PATH_EMPTY"
  | "E_PATH_NUL"
  | "E_PATH_ABSOLUTE"
  | "E_PATH_UNPORTABLE"
  | "E_PATH_OUTSIDE_ROOT";

export class RepoPathError extends Error {
  readonly code: RepoPathErrorCode;
  readonly input: string;

  constructor(code: RepoPathErrorCode, input: string, message: string) {
    super(message);
    this.name = "RepoPathError";
    this.code = code;
    this.input = input;
  }
}

/**
 * Structural shape of a canonical repo path, for JSON Schema consumers.
 * Rejects: leading "/", backslashes, ":", "//", trailing "/", "." or ".."
 * segments, NUL, empty. NFC is checked separately.
 */
export const CANONICAL_REPO_PATH_PATTERN =
  /^(?!\/)(?!.*[\\:])(?!.*\/\/)(?!.*\/$)(?!(?:.*\/)?\.\.?(?:\/|$))[^\0]+$/;

/** Replace every backslash with "/". For paths that come from the OS. */
export function toPosix(input: string): string {
  return input.replaceAll("\\", "/");
}

function isAbsoluteLike(posix: string): boolean {
  // "/x", "//server/share" (UNC), "C:/x", and drive-relative "C:x".
  return posix.startsWith("/") || /^[A-Za-z]:/.test(posix);
}

/**
 * Convert any relative path spelling to its canonical form.
 * "a/../b" resolves to "b"; anything that climbs above the root throws.
 */
export function normalizeRepoPath(input: string): string {
  if (input.includes("\0")) {
    throw new RepoPathError("E_PATH_NUL", input, "path contains a NUL byte");
  }
  const posix = toPosix(input).normalize("NFC");
  if (isAbsoluteLike(posix)) {
    throw new RepoPathError("E_PATH_ABSOLUTE", input, `path must be repo-relative: ${input}`);
  }
  // ":" is a drive or alternate-data-stream separator on Windows, and it
  // separates node-id namespaces (external:, core:, unresolved:) in the graph.
  if (posix.includes(":")) {
    throw new RepoPathError("E_PATH_UNPORTABLE", input, `path contains ":", which is not portable: ${input}`);
  }
  const out: string[] = [];
  for (const segment of posix.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) {
        throw new RepoPathError("E_PATH_OUTSIDE_ROOT", input, `path escapes the repository root: ${input}`);
      }
      out.pop();
      continue;
    }
    out.push(segment);
  }
  if (out.length === 0) {
    throw new RepoPathError("E_PATH_EMPTY", input, "path is empty or refers to the repository root");
  }
  return out.join("/");
}

/** True when `p` is already canonical, i.e. a fixed point of `normalizeRepoPath`. */
export function isCanonicalRepoPath(p: string): boolean {
  try {
    return normalizeRepoPath(p) === p;
  } catch {
    return false;
  }
}

type PathApi = Pick<typeof nodePath, "resolve" | "relative" | "isAbsolute" | "join" | "sep">;

/**
 * Convert an absolute OS path under `root` to a canonical repo path.
 * `pathApi` defaults to the host platform; tests pass `path.win32`.
 */
export function toRepoRelative(root: string, absolutePath: string, pathApi: PathApi = nodePath): string {
  const rel = pathApi.relative(pathApi.resolve(root), pathApi.resolve(absolutePath));
  if (rel === "") {
    throw new RepoPathError("E_PATH_EMPTY", absolutePath, "path is the repository root itself");
  }
  // On Windows a path on another drive stays absolute after relative().
  const posix = toPosix(rel);
  if (pathApi.isAbsolute(rel) || posix === ".." || posix.startsWith("../")) {
    throw new RepoPathError("E_PATH_OUTSIDE_ROOT", absolutePath, `path is outside the repository: ${absolutePath}`);
  }
  return normalizeRepoPath(posix);
}

/** Join a repo path onto `root`. The result is lexically guaranteed to stay inside `root`. */
export function resolveInsideRoot(root: string, repoPath: string, pathApi: PathApi = nodePath): string {
  const canonical = normalizeRepoPath(repoPath);
  return pathApi.join(pathApi.resolve(root), ...canonical.split("/"));
}

/**
 * True when `candidate` is `root` or below it. Both must already be absolute
 * and, for symlink safety, already passed through `fs.realpath`.
 */
export function isInsideRoot(root: string, candidate: string, pathApi: PathApi = nodePath): boolean {
  const rel = pathApi.relative(pathApi.resolve(root), pathApi.resolve(candidate));
  if (rel === "") return true;
  if (pathApi.isAbsolute(rel)) return false;
  const posix = toPosix(rel);
  return posix !== ".." && !posix.startsWith("../");
}
