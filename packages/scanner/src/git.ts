// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { execFileSync } from "node:child_process";

/**
 * The only place EngIntel runs git. Repository configuration is untrusted, so
 * every call disables hooks, fsmonitor, external diff drivers, and textconv
 * filters: nothing a repository configures can run code while we read it
 * (research doc 14). Paths are relative to the root passed in, even when that
 * root is a subdirectory of the work tree.
 */

export type GitErrorCode = "E_GIT_FAILED" | "E_GIT_NOT_A_REPO" | "E_GIT_BAD_REF" | "E_GIT_NO_MERGE_BASE";

export class GitError extends Error {
  readonly code: GitErrorCode;

  constructor(code: GitErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GitError";
    this.code = code;
  }
}

const GIT_SAFETY = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.quotePath=false",
  "-c",
  "diff.external=",
  "-c",
  "core.pager=cat",
];

export function git(root: string, args: readonly string[]): string {
  return execFileSync("git", [...GIT_SAFETY, "-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 512 * 1024 * 1024,
    timeout: 60_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
}

export function isGitWorkTree(root: string): boolean {
  try {
    return git(root, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

/** Refs come from the command line: reject anything git could read as an option or a path. */
const SAFE_REF = /^(?!-)[A-Za-z0-9._/@{}^~+-]{1,255}$/;

/** Resolve a ref (branch, tag, remote branch, sha) to a commit sha. */
export function resolveCommit(root: string, ref: string): string {
  if (!SAFE_REF.test(ref)) throw new GitError("E_GIT_BAD_REF", `not a valid git ref: ${JSON.stringify(ref)}`);
  if (!isGitWorkTree(root)) throw new GitError("E_GIT_NOT_A_REPO", `${root} is not inside a git work tree`);
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
  } catch (error) {
    throw new GitError("E_GIT_BAD_REF", `git cannot resolve "${ref}" to a commit. Fetch it first (e.g. git fetch origin ${ref.replace(/^origin\//, "")}).`, {
      cause: error,
    });
  }
}

/** The merge base of HEAD and `ref`: the commit a pull request branched from. */
export function mergeBase(root: string, ref: string): string {
  const base = resolveCommit(root, ref);
  try {
    return git(root, ["merge-base", "HEAD", base]).trim();
  } catch (error) {
    throw new GitError(
      "E_GIT_NO_MERGE_BASE",
      `HEAD and ${ref} have no common history in this clone. In CI, check out with full history (actions/checkout fetch-depth: 0).`,
      { cause: error },
    );
  }
}

export interface ChangedFiles {
  /** Every path the change touches, sorted: added, modified, deleted, both sides of renames and copies, untracked. */
  readonly changed: readonly string[];
  /** Paths that no longer exist, including the old side of renames. */
  readonly deleted: readonly string[];
}

/**
 * Files that differ between `baseSha` and the working tree (committed and
 * uncommitted changes), plus untracked files git does not ignore. Paths are
 * POSIX and relative to `root`.
 */
export function changedFilesSince(root: string, baseSha: string): ChangedFiles {
  if (!/^[0-9a-f]{7,64}$/.test(baseSha)) throw new GitError("E_GIT_BAD_REF", `not a commit sha: ${baseSha}`);
  let diff: string;
  let untracked: string;
  try {
    diff = git(root, ["diff", "--name-status", "-z", "-M", "--no-ext-diff", "--no-textconv", "--relative", baseSha, "--", "."]);
    untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", "."]);
  } catch (error) {
    throw new GitError("E_GIT_FAILED", `git diff failed in ${root}: ${(error as Error).message}`, { cause: error });
  }
  const changed = new Set<string>();
  const deleted = new Set<string>();
  const fields = diff.split("\0");
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++] ?? "";
    if (status === "") continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = fields[i++] ?? "";
      const to = fields[i++] ?? "";
      changed.add(from).add(to);
      if (status.startsWith("R")) deleted.add(from);
    } else {
      const path = fields[i++] ?? "";
      changed.add(path);
      if (status.startsWith("D")) deleted.add(path);
    }
  }
  for (const path of untracked.split("\0")) if (path) changed.add(path);
  changed.delete("");
  const sort = (s: Set<string>) => [...s].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { changed: sort(changed), deleted: sort(deleted) };
}

/** Content of `path` (relative to root) at commit `sha`, or null when it does not exist there. */
export function showFileAt(root: string, sha: string, path: string): string | null {
  if (!/^[0-9a-f]{7,64}$/.test(sha)) throw new GitError("E_GIT_BAD_REF", `not a commit sha: ${sha}`);
  const spec = `${sha}:./${path}`;
  try {
    git(root, ["cat-file", "-e", spec]);
  } catch {
    return null;
  }
  try {
    return git(root, ["cat-file", "blob", spec]);
  } catch (error) {
    throw new GitError("E_GIT_FAILED", `git could not read ${path} at ${sha.slice(0, 12)}`, { cause: error });
  }
}
