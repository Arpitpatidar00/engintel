// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, type Stats } from "node:fs";
import { basename, join, resolve } from "node:path";
import { RepoPathError, normalizeRepoPath } from "@engintel/config";
import ignore, { type Ignore } from "ignore";
import picomatch from "picomatch";

/**
 * Repository file inventory (ENG-003, research doc 04 section 3).
 *
 * Deterministic: the same bytes, ignore files, and options always produce
 * the same sorted list and the same treeHash. Nothing here follows
 * symlinks, executes repository code, or writes to disk.
 *
 * Every file that could matter to architecture analysis is listed with a
 * status, never silently dropped:
 *   ok          readable source or config file, hashed
 *   unreadable  a JS/TS file the analyzer cannot judge (fail-closed input)
 *   unsupported not JS/TS, so not architecture-analyzed
 *   ignored     excluded by .engintel/ignore or the config include/exclude globs
 * Files ignored by git (.gitignore, .git/info/exclude, global excludes) and
 * files under ALWAYS_SKIPPED directories are not listed at all.
 */

export type FileStatus = "ok" | "unreadable" | "unsupported" | "ignored";
export type FileKind = "source" | "config" | "other";

export type UnreadableReason =
  | "permission"
  | "io-error"
  | "too-large"
  | "binary"
  | "invalid-utf8"
  | "symlink"
  | "unportable-path";

export interface ScannedFile {
  /** Canonical repo path (POSIX, repo-relative, NFC). For unportable paths, the raw POSIX spelling. */
  readonly path: string;
  readonly kind: FileKind;
  readonly status: FileStatus;
  /** Why the file is not `ok`, or null. */
  readonly reason: UnreadableReason | "engintel-ignore" | "config-exclude" | "not-included" | "not-js-ts" | null;
  readonly bytes: number | null;
  /** sha256 of the raw bytes, for `ok` files. */
  readonly sha256: string | null;
}

export interface ScanOptions {
  /** Globs a file must match to be analyzed. Empty means everything. */
  readonly include?: readonly string[];
  /** Globs subtracted after `include`. */
  readonly exclude?: readonly string[];
  /** Refuse to scan more files than this (fail-closed). Default 200 000. */
  readonly maxFiles?: number;
  /** Refuse to read more bytes than this in total (fail-closed). Default 1.5 GiB. */
  readonly maxTotalBytes?: number;
  /** Larger files are listed as unreadable/too-large. Default 2 MiB. */
  readonly maxFileBytes?: number;
  /** "auto" uses git when the root is inside a work tree. */
  readonly listing?: "auto" | "git" | "walk";
}

export interface ScanResult {
  /** Absolute repository root. */
  readonly root: string;
  readonly listing: "git" | "walk";
  /** Sorted by path (UTF-16 code units). */
  readonly files: readonly ScannedFile[];
  /** sha256 over "path\0sha256" lines of every hashed file (research doc 04, section 3.3). */
  readonly treeHash: string;
}

export class ScanError extends Error {
  readonly code: "E_REPO_TOO_LARGE" | "E_ROOT_NOT_FOUND" | "E_GIT_LISTING_FAILED";

  constructor(code: ScanError["code"], message: string) {
    super(message);
    this.name = "ScanError";
    this.code = code;
  }
}

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

/**
 * Never listed, at any depth. Deliberately short: build output such as dist/
 * is left to .gitignore, because silently skipping a real source directory
 * named build/ or out/ would be a fail-open hole.
 */
export const ALWAYS_SKIPPED = ["node_modules", ".git", ".turbo", ".next"] as const;
const SKIPPED_PREFIXES = [".engintel/cache/", ".engintel/index/"];

const DEFAULTS = { maxFiles: 200_000, maxTotalBytes: 1.5 * 1024 ** 3, maxFileBytes: 2 * 1024 ** 2 };

export function isSourcePath(path: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

function kindOf(path: string): FileKind {
  if (isSourcePath(path)) return "source";
  const name = basename(path);
  if (/^tsconfig(\..+)?\.json$/.test(name) || name === "package.json") return "config";
  if (/^\.engintel\/[^/]+\.json$/.test(path)) return "config";
  return "other";
}

function isSkipped(path: string): boolean {
  const segments = path.split("/");
  if (segments.some((s) => (ALWAYS_SKIPPED as readonly string[]).includes(s))) return true;
  return SKIPPED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

export function scanRepository(rootInput: string, options: ScanOptions = {}): ScanResult {
  const root = resolve(rootInput);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new ScanError("E_ROOT_NOT_FOUND", `repository root is not a directory: ${root}`);
  }
  const limits = { ...DEFAULTS, ...options };
  const listing = options.listing === "walk" ? "walk" : options.listing === "git" || insideGitWorkTree(root) ? "git" : "walk";
  const candidates = (listing === "git" ? listWithGit(root) : listByWalking(root)).filter((p) => !isSkipped(p));
  if (candidates.length > limits.maxFiles) {
    throw new ScanError("E_REPO_TOO_LARGE", `repository has ${candidates.length} files; the limit is ${limits.maxFiles}`);
  }

  const engintelIgnore = loadIgnoreFile(join(root, ".engintel", "ignore"));
  const include = options.include?.length ? picomatch([...options.include], { dot: true }) : null;
  const exclude = options.exclude?.length ? picomatch([...options.exclude], { dot: true }) : null;

  let totalBytes = 0;
  const files: ScannedFile[] = [];
  for (const raw of candidates) {
    const file = inspect(root, raw, { engintelIgnore, include, exclude, maxFileBytes: limits.maxFileBytes });
    if (file === null) continue;
    totalBytes += file.bytes ?? 0;
    if (totalBytes > limits.maxTotalBytes) {
      throw new ScanError("E_REPO_TOO_LARGE", `repository exceeds ${limits.maxTotalBytes} bytes of analyzable files`);
    }
    files.push(file);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const treeHash = sha256(
    Buffer.from(
      files
        .filter((f) => f.sha256 !== null)
        .map((f) => `${f.path}\0${f.sha256}`)
        .join("\n"),
    ),
  );
  return { root, listing, files, treeHash };
}

interface Filters {
  readonly engintelIgnore: Ignore;
  readonly include: picomatch.Matcher | null;
  readonly exclude: picomatch.Matcher | null;
  readonly maxFileBytes: number;
}

/** Classify one listed path. Returns null for paths that no longer exist or are directories. */
function inspect(root: string, rawPath: string, filters: Filters): ScannedFile | null {
  const posix = rawPath.replaceAll("\\", "/");
  const kind = kindOf(posix);
  let path: string;
  try {
    path = normalizeRepoPath(posix);
  } catch (error) {
    if (!(error instanceof RepoPathError)) throw error;
    return kind === "source" ? unreadable(posix, kind, "unportable-path", null) : other(posix, "unsupported", "not-js-ts");
  }

  let stats: Stats;
  try {
    stats = lstatSync(join(root, ...path.split("/")));
  } catch {
    return null; // tracked in the index but deleted from the working tree
  }
  if (stats.isDirectory()) return null; // e.g. a submodule gitlink
  if (stats.isSymbolicLink()) {
    return kind === "source" ? unreadable(path, kind, "symlink", null) : other(path, "unsupported", "not-js-ts");
  }
  if (!stats.isFile()) return null;

  if (filters.engintelIgnore.ignores(path)) return other(path, "ignored", "engintel-ignore", kind);
  if (kind === "source" && filters.include && !filters.include(path)) return other(path, "ignored", "not-included", kind);
  if (kind === "source" && filters.exclude?.(path)) return other(path, "ignored", "config-exclude", kind);
  if (kind === "other") return other(path, "unsupported", "not-js-ts");

  if (stats.size > filters.maxFileBytes) return unreadable(path, kind, "too-large", stats.size);
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(root, ...path.split("/")));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return unreadable(path, kind, code === "EACCES" || code === "EPERM" ? "permission" : "io-error", stats.size);
  }
  if (bytes.includes(0)) return unreadable(path, kind, "binary", bytes.length);
  try {
    utf8.decode(bytes);
  } catch {
    return unreadable(path, kind, "invalid-utf8", bytes.length);
  }
  return { path, kind, status: "ok", reason: null, bytes: bytes.length, sha256: sha256(bytes) };
}

function unreadable(path: string, kind: FileKind, reason: UnreadableReason, bytes: number | null): ScannedFile {
  return { path, kind, status: "unreadable", reason, bytes, sha256: null };
}

function other(path: string, status: "ignored" | "unsupported", reason: ScannedFile["reason"], kind: FileKind = "other"): ScannedFile {
  return { path, kind, status, reason, bytes: null, sha256: null };
}

function loadIgnoreFile(path: string): Ignore {
  const matcher = ignore();
  if (existsSync(path)) matcher.add(readFileSync(path, "utf8"));
  return matcher;
}

// Repository config is untrusted: never let it run code while we list files.
const GIT_SAFETY = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=false"];

function git(root: string, args: string[]): string {
  return execFileSync("git", [...GIT_SAFETY, "-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 512 * 1024 * 1024,
    timeout: 60_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

function insideGitWorkTree(root: string): boolean {
  try {
    return git(root, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

/** Tracked plus untracked-but-not-ignored files under root, relative to root. */
function listWithGit(root: string): string[] {
  try {
    const out = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    return [...new Set(out.split("\0").filter((p) => p.length > 0))];
  } catch (error) {
    throw new ScanError("E_GIT_LISTING_FAILED", `git ls-files failed in ${root}: ${(error as Error).message}`);
  }
}

/**
 * Directory walk for roots outside a git work tree. Honors nested .gitignore
 * files: a pattern applies to paths below the directory that declares it.
 */
function listByWalking(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string, matchers: Array<{ base: string; ig: Ignore }>): void => {
    const gitignore = join(dir, ".gitignore");
    const scoped = existsSync(gitignore) ? [...matchers, { base: rel, ig: ignore().add(readFileSync(gitignore, "utf8")) }] : matchers;
    const ignored = (path: string, isDir: boolean): boolean =>
      scoped.some(({ base, ig }) => {
        const relative = base === "" ? path : path.slice(base.length + 1);
        return ig.ignores(isDir ? `${relative}/` : relative);
      });
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if ((ALWAYS_SKIPPED as readonly string[]).includes(entry.name)) continue;
      if (entry.isDirectory()) {
        if (!ignored(path, true)) walk(join(dir, entry.name), path, scoped);
      } else if (!ignored(path, false)) {
        out.push(path);
      }
    }
  };
  walk(root, "", []);
  return out;
}
