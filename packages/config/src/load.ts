// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type * as z from "zod";
import { ArchitectureContractSchema, type ArchitectureContract } from "./architecture.js";

/**
 * Loaders for the human-owned files in `.engintel/` (ENG-006).
 *
 * Every failure is a ConfigError, which the CLI maps to exit code 2: a
 * missing, unreadable, or invalid contract is a tool error, never a pass
 * (FR-004). Loaders only read; nothing here writes.
 */

export const CONTRACT_PATH = ".engintel/architecture.json";

/** Contracts and configs are small, hand-written files. Anything larger is refused before parsing. */
export const MAX_CONFIG_FILE_BYTES = 1024 * 1024;

export type ConfigErrorCode =
  | "E_CONTRACT_MISSING"
  | "E_CONTRACT_INVALID"
  | "E_CONTRACT_DRAFT"
  | "E_CONFIG_INVALID"
  | "E_CONFIG_UNREADABLE"
  | "E_CONFIG_INVALID_JSON"
  | "E_BASELINE_INVALID";

export interface ConfigIssue {
  /** Dotted path into the document, e.g. "rules[2].from.layer"; "" for the whole file. */
  readonly path: string;
  readonly message: string;
}

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  /** Repo path of the offending file. */
  readonly file: string;
  readonly issues: readonly ConfigIssue[];

  constructor(code: ConfigErrorCode, file: string, message: string, issues: readonly ConfigIssue[] = []) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.file = file;
    this.issues = issues;
  }
}

export function formatIssuePath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((out, key) => (typeof key === "number" ? `${out}[${key}]` : out ? `${out}.${String(key)}` : String(key)), "");
}

export function zodIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({ path: formatIssuePath(issue.path), message: issue.message }));
}

/** JSON with object keys sorted at every level: the input to content hashes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Read a small JSON file from inside the repository. Returns undefined when
 * the file does not exist. A symlink is refused: the file would be read from
 * wherever it points, outside review.
 */
export function readRepoJson(root: string, repoPath: string, invalidJson: ConfigErrorCode = "E_CONFIG_INVALID_JSON"): unknown {
  const absolute = join(resolve(root), ...repoPath.split("/"));
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError("E_CONFIG_UNREADABLE", repoPath, `${repoPath} cannot be read: ${(error as Error).message}`);
  }
  if (stat.isSymbolicLink()) throw new ConfigError("E_CONFIG_UNREADABLE", repoPath, `${repoPath} is a symlink; it must be a regular file`);
  if (!stat.isFile()) throw new ConfigError("E_CONFIG_UNREADABLE", repoPath, `${repoPath} is not a regular file`);
  if (stat.size > MAX_CONFIG_FILE_BYTES) {
    throw new ConfigError("E_CONFIG_UNREADABLE", repoPath, `${repoPath} is ${stat.size} bytes; the limit is ${MAX_CONFIG_FILE_BYTES}`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(absolute));
  } catch (error) {
    throw new ConfigError("E_CONFIG_UNREADABLE", repoPath, `${repoPath} cannot be read as UTF-8: ${(error as Error).message}`);
  }
  const json = text.replace(/^\uFEFF/, "");
  try {
    return JSON.parse(json) as unknown;
  } catch (error) {
    // V8's message can quote file content; report the position only.
    const position = /position (\d+)/.exec((error as Error).message)?.[1];
    let where = "";
    if (position !== undefined) {
      const before = json.slice(0, Number(position)).split("\n");
      where = ` at line ${before.length}, column ${(before[before.length - 1]?.length ?? 0) + 1}`;
    } else if (json.trim() === "") {
      where = ": the file is empty";
    }
    throw new ConfigError(invalidJson, repoPath, `${repoPath} is not valid JSON${where}`);
  }
}

export interface LoadedContract {
  /** Repo path the contract was read from. */
  readonly file: string;
  /** Parsed, with defaults applied. */
  readonly contract: ArchitectureContract;
  /** sha256 of the canonical JSON of the file as written (before defaults). */
  readonly contractHash: string;
  /** Valid but worth a reviewer's attention (doc 06: exceptions should live at most 180 days). */
  readonly warnings: readonly ConfigIssue[];
}

export const MAX_EXCEPTION_LIFETIME_DAYS = 180;

function contractWarnings(contract: ArchitectureContract): ConfigIssue[] {
  const day = 24 * 60 * 60 * 1000;
  return contract.exceptions.flatMap((ex, i) => {
    const days = Math.round((Date.parse(ex.expiresAt) - Date.parse(ex.addedAt)) / day);
    return days > MAX_EXCEPTION_LIFETIME_DAYS
      ? [{ path: `exceptions[${i}].expiresAt`, message: `exception "${ex.id}" lives ${days} days; the recommended maximum is ${MAX_EXCEPTION_LIFETIME_DAYS}` }]
      : [];
  });
}

/** Validate an already-parsed contract document. Pure. */
export function parseContract(document: unknown, file: string = CONTRACT_PATH): LoadedContract {
  const parsed = ArchitectureContractSchema.safeParse(document);
  if (!parsed.success) {
    const issues = zodIssues(parsed.error);
    const first = issues[0];
    const summary = first ? `${first.path || "(root)"}: ${first.message}` : "schema validation failed";
    const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : "";
    throw new ConfigError("E_CONTRACT_INVALID", file, `${file} is not a valid architecture contract: ${summary}${more}`, issues);
  }
  return { file, contract: parsed.data, contractHash: sha256Hex(canonicalJson(document)), warnings: contractWarnings(parsed.data) };
}

/**
 * Load `.engintel/architecture.json` from `root`. Missing, unreadable,
 * malformed, and schema-invalid contracts all throw ConfigError.
 */
export function loadContract(root: string, file: string = CONTRACT_PATH): LoadedContract {
  let document: unknown;
  try {
    document = readRepoJson(root, file, "E_CONTRACT_INVALID");
  } catch (error) {
    if (error instanceof ConfigError && error.code === "E_CONFIG_UNREADABLE") {
      throw new ConfigError("E_CONTRACT_INVALID", file, error.message);
    }
    throw error;
  }
  if (document === undefined) {
    throw new ConfigError(
      "E_CONTRACT_MISSING",
      file,
      `${file} not found. EngIntel does not guess architecture: write a contract (status "draft" until reviewed) and commit it.`,
    );
  }
  return parseContract(document, file);
}
