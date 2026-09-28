// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import * as z from "zod";
import { NodeRefSchema } from "./diagnostic.js";
import { ConfigError, canonicalJson, readRepoJson, sha256Hex, zodIssues } from "./load.js";

/**
 * `.engintel/baseline.json` (ENG-009; research doc 08, section 4): the
 * committed, human-owned ledger of existing architecture debt. A pull request
 * fails only on violation identities that are not in it (D-008).
 *
 * The file is CODEOWNERS-protected policy. The loader is strict and fails
 * closed: a malformed baseline is a tool error (exit 2), never "no baseline".
 * Whether each identity really is the hash of its fields is checked by
 * @engintel/policy, which owns the identity function.
 */

export const BASELINE_PATH = ".engintel/baseline.json";
export const BASELINE_SCHEMA_VERSION = 1;
/** Must equal @engintel/policy IDENTITY_VERSION; checked there. */
export const BASELINE_IDENTITY_VERSION = 1;

/**
 * A seatbelt, not a security boundary (CODEOWNERS is): these authors may not
 * write the ledger. Compared case-insensitively; any "[bot]" account too.
 */
export const AGENT_AUTHORS = [
  "agent",
  "ai",
  "bot",
  "claude",
  "codex",
  "copilot",
  "cursor",
  "devin",
  "engintel",
  "engintel-agent",
  "engintel-bot",
  "gemini",
  "github-actions",
] as const;

export function isAgentAuthor(login: string): boolean {
  const lower = login.toLowerCase();
  return (AGENT_AUTHORS as readonly string[]).includes(lower) || lower.endsWith("[bot]") || lower.endsWith("-bot");
}

const IsoDateSchema = z.iso.date();
const OwnerSchema = z.string().regex(/^@[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9._-]+)?$/, "owners are @user or @org/team");
/** A GitHub login: letters, digits, and single hyphens, at most 39 characters. */
const LoginSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, "writtenBy must be a GitHub login")
  .refine((login) => !isAgentAuthor(login), "an agent or bot may not write the baseline; a human owner must");

export const BaselineEntrySchema = z.strictObject({
  identity: z.string().regex(/^[0-9a-f]{64}$/, "identity must be a lowercase sha256 hex digest"),
  ruleId: z.string().min(1).max(200).regex(/^[A-Za-z0-9@][A-Za-z0-9._:/@-]*$/, "ruleId contains unsupported characters"),
  source: NodeRefSchema,
  target: NodeRefSchema,
  cycleSignature: z.string().min(1).nullable(),
  firstSeenAt: IsoDateSchema,
  lastSeenAt: IsoDateSchema,
  owner: OwnerSchema.optional(),
  ticket: z.string().min(1).max(200).optional(),
  justification: z.string().min(1).max(2000).optional(),
});

export const BaselineFileSchema = z
  .strictObject({
    $schema: z.string().optional(),
    schemaVersion: z.literal(BASELINE_SCHEMA_VERSION),
    /** Bumped only when the identity function changes; unknown versions fail closed. */
    engineIdentityVersion: z.literal(BASELINE_IDENTITY_VERSION),
    policyVersionAtWrite: z.string().min(1).max(100),
    writtenAt: IsoDateSchema,
    writtenBy: LoginSchema,
    notes: z.string().max(4000).optional(),
    entries: z.array(BaselineEntrySchema),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.entries.forEach((entry, i) => {
      if (seen.has(entry.identity)) ctx.addIssue({ code: "custom", path: ["entries", i, "identity"], message: `duplicate identity ${entry.identity}` });
      seen.add(entry.identity);
      if (entry.lastSeenAt < entry.firstSeenAt) {
        ctx.addIssue({ code: "custom", path: ["entries", i, "lastSeenAt"], message: "lastSeenAt is before firstSeenAt" });
      }
    });
  });

export type BaselineFile = z.output<typeof BaselineFileSchema>;
export type BaselineEntry = BaselineFile["entries"][number];

export interface LoadedBaseline {
  readonly file: string;
  readonly baseline: BaselineFile;
  /** sha256 of the canonical JSON of the file as written. */
  readonly baselineHash: string;
}

/** Validate an already-parsed baseline document. Pure. `where` qualifies messages ("at the merge base"). */
export function parseBaseline(document: unknown, file: string = BASELINE_PATH, where = ""): LoadedBaseline {
  const parsed = BaselineFileSchema.safeParse(document);
  if (!parsed.success) {
    const issues = zodIssues(parsed.error);
    const first = issues[0];
    throw new ConfigError(
      "E_BASELINE_INVALID",
      file,
      `${file}${where} is not a valid baseline: ${first ? `${first.path || "(root)"}: ${first.message}` : "schema validation failed"}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ""}`,
      issues,
    );
  }
  return { file, baseline: parsed.data, baselineHash: sha256Hex(canonicalJson(document)) };
}

/** Parse baseline JSON text (e.g. read from git at the merge base). */
export function parseBaselineText(text: string, file: string = BASELINE_PATH, where = ""): LoadedBaseline {
  let document: unknown;
  try {
    document = JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
  } catch {
    throw new ConfigError("E_BASELINE_INVALID", file, `${file}${where} is not valid JSON`);
  }
  return parseBaseline(document, file, where);
}

/** Load `.engintel/baseline.json`, or null when there is none. Anything malformed is E_BASELINE_INVALID. */
export function loadBaseline(root: string, file: string = BASELINE_PATH): LoadedBaseline | null {
  let document: unknown;
  try {
    document = readRepoJson(root, file, "E_BASELINE_INVALID");
  } catch (error) {
    if (error instanceof ConfigError && error.code === "E_CONFIG_UNREADABLE") throw new ConfigError("E_BASELINE_INVALID", file, error.message);
    throw error;
  }
  return document === undefined ? null : parseBaseline(document, file);
}

/** Canonical file content: entries sorted by identity, keys in schema order, trailing newline. */
export function serializeBaseline(baseline: BaselineFile): string {
  const entries = [...baseline.entries]
    .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0))
    .map((e) => ({
      identity: e.identity,
      ruleId: e.ruleId,
      source: e.source,
      target: e.target,
      cycleSignature: e.cycleSignature,
      firstSeenAt: e.firstSeenAt,
      lastSeenAt: e.lastSeenAt,
      ...(e.owner ? { owner: e.owner } : {}),
      ...(e.ticket ? { ticket: e.ticket } : {}),
      ...(e.justification ? { justification: e.justification } : {}),
    }));
  const ordered = {
    ...(baseline.$schema ? { $schema: baseline.$schema } : {}),
    schemaVersion: baseline.schemaVersion,
    engineIdentityVersion: baseline.engineIdentityVersion,
    policyVersionAtWrite: baseline.policyVersionAtWrite,
    writtenAt: baseline.writtenAt,
    writtenBy: baseline.writtenBy,
    ...(baseline.notes ? { notes: baseline.notes } : {}),
    entries,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function baselineJsonSchema(): Record<string, unknown> {
  const { $schema, ...generated } = z.toJSONSchema(BaselineFileSchema, { target: "draft-2020-12", io: "input" });
  return {
    $schema,
    $id: "https://engintel.dev/schema/baseline.v1.json",
    title: "EngIntel architecture baseline",
    description:
      "Human-owned ledger of existing architecture violations (.engintel/baseline.json). The reference loader also " +
      "rejects duplicate identities, lastSeenAt before firstSeenAt, agent or bot authors, identities that do not " +
      "recompute from their fields, and fail-closed rule ids that can never be baselined.",
    ...generated,
  };
}
