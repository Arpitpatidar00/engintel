// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import * as z from "zod";
import { GLOB_PATTERN } from "./architecture.js";
import { ConfigError, readRepoJson, zodIssues, type ConfigIssue } from "./load.js";
import { isCanonicalRepoPath } from "./paths.js";

/**
 * `.engintel/config.json` (ENG-034; research doc 18). Optional. Tool settings
 * only: what to scan, which tsconfig, and resource budgets. Policy lives in
 * the architecture contract, which CODEOWNERS protects, so nothing here can
 * weaken enforcement (there is deliberately no opaqueImports or severity knob).
 *
 * Strict: unknown keys are errors, not silently dropped. Secret-looking keys
 * and values are refused (secrets never live in repository files), and
 * `telemetry.enable` is accepted but ignored: a repository cannot turn on
 * upload for whoever runs the tool (doc 22).
 */

export const CONFIG_PATH = ".engintel/config.json";
export const CONFIG_SCHEMA_VERSION = 1;

export const DEFAULT_LIMITS = {
  maxFiles: 200_000,
  maxTotalBytes: 1.5 * 1024 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  graphTimeoutMs: 120_000,
} as const;

const GlobSchema = z.string().max(500).regex(GLOB_PATTERN, "must be a repo-relative POSIX glob");

export const EngintelConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  /** Source globs to analyze. Default: every JS/TS source file git does not ignore. */
  include: z.array(GlobSchema).min(1).optional(),
  /** Source globs to skip (reported as ignored, never as passed). */
  exclude: z.array(GlobSchema).default([]),
  /** Repo path of the tsconfig used for path mapping. Default: tsconfig.json when present. */
  tsconfig: z.string().refine(isCanonicalRepoPath, "must be a canonical repo-relative path").optional(),
  limits: z
    .strictObject({
      maxFiles: z.number().int().min(1).max(5_000_000),
      maxTotalBytes: z.number().int().min(1),
      maxFileBytes: z.number().int().min(1).max(256 * 1024 * 1024),
      graphTimeoutMs: z.number().int().min(1_000).max(3_600_000),
    })
    .partial()
    .optional(),
  /** Accepted for compatibility and ignored: only the operator can enable telemetry. */
  telemetry: z.strictObject({ enable: z.boolean() }).optional(),
});

export type EngintelConfigInput = z.input<typeof EngintelConfigSchema>;

export interface ResolvedConfig {
  readonly include: readonly string[] | undefined;
  readonly exclude: readonly string[];
  readonly tsconfig: string | undefined;
  readonly limits: { readonly maxFiles: number; readonly maxTotalBytes: number; readonly maxFileBytes: number; readonly graphTimeoutMs: number };
  /** Always false: repository files cannot enable telemetry upload. */
  readonly telemetryUpload: false;
}

export interface LoadedConfig {
  readonly file: string;
  /** False when .engintel/config.json does not exist and defaults apply. */
  readonly present: boolean;
  readonly config: ResolvedConfig;
  /** Things the user should know that are not errors. */
  readonly notices: readonly string[];
}

const SECRET_KEY = /(secret|token|passw(or)?d|api[-_]?key|credential|private[-_]?key|auth)/i;
const SECRET_VALUE = /^(ghp_|gho_|ghu_|ghs_|github_pat_|sk-|sk_live_|AKIA|ASIA|xox[abprs]-|-----BEGIN)/;

function secretIssues(value: unknown, path: string[] = []): ConfigIssue[] {
  if (typeof value === "string") {
    return SECRET_VALUE.test(value) ? [{ path: path.join("."), message: "looks like a credential; secrets never belong in repository files" }] : [];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => secretIssues(v, [...path.slice(0, -1), `${path[path.length - 1] ?? ""}[${i}]`]));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) => {
    const here = [...path, key];
    const own = SECRET_KEY.test(key) ? [{ path: here.join("."), message: "secret-looking keys are not allowed; secrets never belong in repository files" }] : [];
    return [...own, ...secretIssues(v, here)];
  });
}

const DEFAULT_CONFIG: ResolvedConfig = { include: undefined, exclude: [], tsconfig: undefined, limits: DEFAULT_LIMITS, telemetryUpload: false };

/** Validate an already-parsed config document. Pure. */
export function parseConfig(document: unknown, file: string = CONFIG_PATH): LoadedConfig {
  const fail = (message: string, issues: ConfigIssue[]) => new ConfigError("E_CONFIG_INVALID", file, `${file}: ${message}`, issues);
  if (document !== null && typeof document === "object" && !Array.isArray(document)) {
    for (const reserved of ["extends", "overlays"]) {
      if (reserved in document) {
        throw fail(`"${reserved}" is reserved for organization overlays, which are not supported yet`, [
          { path: reserved, message: "reserved for organization overlays" },
        ]);
      }
    }
  }
  const secrets = secretIssues(document);
  if (secrets.length > 0) throw fail(`${secrets[0]?.path}: ${secrets[0]?.message}`, secrets);
  const parsed = EngintelConfigSchema.safeParse(document);
  if (!parsed.success) {
    const issues = zodIssues(parsed.error);
    throw fail(`${issues[0]?.path || "(root)"}: ${issues[0]?.message ?? "invalid"}`, issues);
  }
  const data = parsed.data;
  const notices = data.telemetry?.enable
    ? ["telemetry.enable in the repository config is ignored; only the operator can enable telemetry."]
    : [];
  return {
    file,
    present: true,
    config: {
      include: data.include,
      exclude: data.exclude,
      tsconfig: data.tsconfig,
      limits: {
        maxFiles: data.limits?.maxFiles ?? DEFAULT_LIMITS.maxFiles,
        maxTotalBytes: data.limits?.maxTotalBytes ?? DEFAULT_LIMITS.maxTotalBytes,
        maxFileBytes: data.limits?.maxFileBytes ?? DEFAULT_LIMITS.maxFileBytes,
        graphTimeoutMs: data.limits?.graphTimeoutMs ?? DEFAULT_LIMITS.graphTimeoutMs,
      },
      telemetryUpload: false,
    },
    notices,
  };
}

/** Load `.engintel/config.json`, or defaults when it does not exist. Invalid files throw ConfigError. */
export function loadConfig(root: string, file: string = CONFIG_PATH): LoadedConfig {
  const document = readRepoJson(root, file);
  if (document === undefined) return { file, present: false, config: DEFAULT_CONFIG, notices: [] };
  return parseConfig(document, file);
}

export function configJsonSchema(): Record<string, unknown> {
  const { $schema, ...generated } = z.toJSONSchema(EngintelConfigSchema, { target: "draft-2020-12", io: "input" });
  return {
    $schema,
    $id: "https://engintel.dev/schema/config.v1.json",
    title: "EngIntel tool configuration",
    description:
      "Tool settings (.engintel/config.json). Policy belongs in architecture.json. The reference loader " +
      "also refuses secret-looking keys and values, and reserves \"extends\" and \"overlays\".",
    ...generated,
  };
}
