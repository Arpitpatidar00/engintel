// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import * as z from "zod";
import { CANONICAL_REPO_PATH_PATTERN } from "./paths.js";

/**
 * The one diagnostic shape shared by the CLI, the MCP server, SARIF output,
 * and every adapter (research FR-007, docs 07, 13).
 *
 * Every diagnostic answers: what (`message`), why (`why`), where (`file`,
 * `range`), which rule (`ruleId`), which edge (`edge`), and the permitted
 * alternative (`suggest`, which is explicitly `kind: "none"` when there is
 * none).
 *
 * Diagnostics never carry repository source text. The object is strict, so
 * fields like `snippet` or `sourceText` are rejected, not silently dropped.
 */

export const DIAGNOSTIC_SCHEMA_VERSION = 1;

export const ADAPTERS = [
  "architecture",
  "policy",
  "analyzer",
  "tsc",
  "eslint",
  "test",
  "semgrep",
  "jscpd",
  "knip",
  "pattern",
] as const;

export const SEVERITIES = ["error", "warning", "info", "advisory"] as const;

/** Module edge kinds, as normalized from dependency-cruiser (research doc 05). */
export const EDGE_KINDS = [
  "import",
  "type-only",
  "re-export",
  "dynamic",
  "require",
  "triple-slash",
  "implicit",
] as const;

export const SUGGESTION_KINDS = [
  "use-layer",
  "introduce-facade",
  "move-file",
  "split-module",
  "none",
] as const;

/** Field names that would carry repository source text. Never allowed. */
export const FORBIDDEN_DIAGNOSTIC_KEYS = ["snippet", "sourceText", "sourceCode", "excerpt"] as const;

export const RepoPathSchema = z
  .string()
  .regex(CANONICAL_REPO_PATH_PATTERN, "must be a canonical repo-relative POSIX path")
  .refine((p) => p === p.normalize("NFC"), "must be Unicode NFC");

/**
 * An edge endpoint: a canonical repo path, or one of the non-file node ids
 * (`external:lodash`, `core:fs`, `unresolved:<specifier>`) or a placeholder
 * token such as `<missing>` or `<unanalyzable>` (research docs 05, 08).
 */
export const NodeRefSchema = z.union([
  RepoPathSchema,
  z.string().regex(/^(external|core|unresolved):\S.*$/, "must be external:, core:, or unresolved:"),
  z.string().regex(/^<[a-z][a-z-]*>$/, "must be a <token>"),
]);

const PositionSchema = z.strictObject({
  line: z.number().int().min(1),
  column: z.number().int().min(1),
});

const RangeSchema = z
  .strictObject({ start: PositionSchema, end: PositionSchema })
  .refine(
    ({ start, end }) => end.line > start.line || (end.line === start.line && end.column >= start.column),
    "range end must not precede range start",
  );

const EdgeSchema = z.strictObject({
  source: NodeRefSchema,
  target: NodeRefSchema,
  kind: z.enum(EDGE_KINDS),
});

const SuggestionSchema = z.strictObject({
  kind: z.enum(SUGGESTION_KINDS),
  explanation: z.string().min(1).max(2000),
  /** Allowed layer route, e.g. ["controllers", "services", "repositories"]. */
  layers: z.array(z.string().min(1)).optional(),
});

export const DiagnosticSchema = z
  .strictObject({
    schemaVersion: z.literal(DIAGNOSTIC_SCHEMA_VERSION),
    /** sha256 hex. Architecture uses the violation identity; other adapters hash their fingerprint. */
    identity: z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase sha256 hex digest"),
    adapter: z.enum(ADAPTERS),
    ruleId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9@][A-Za-z0-9._:/@-]*$/, "ruleId contains unsupported characters"),
    severity: z.enum(SEVERITIES),
    /** True only when this diagnostic can fail the gate. */
    blocking: z.boolean(),
    /** null for project-level findings with no single file. */
    file: RepoPathSchema.nullable(),
    range: RangeSchema.optional(),
    /** What happened. One line, stable wording. */
    message: z.string().min(1).max(2000),
    /** Why it is a problem: the rule's comment or the adapter's reason. */
    why: z.string().min(1).max(4000),
    edge: EdgeSchema.optional(),
    /** Canonical rotation, e.g. "src/a.ts -> src/b.ts". */
    cycleSignature: z.string().min(1).optional(),
    suggest: SuggestionSchema,
  })
  .superRefine((d, ctx) => {
    if (d.blocking && d.severity !== "error") {
      ctx.addIssue({ code: "custom", path: ["blocking"], message: "only severity \"error\" may block" });
    }
    if (d.range !== undefined && d.file === null) {
      ctx.addIssue({ code: "custom", path: ["range"], message: "a range requires a file" });
    }
  });

export type Diagnostic = z.infer<typeof DiagnosticSchema>;
export type Adapter = (typeof ADAPTERS)[number];
export type Severity = (typeof SEVERITIES)[number];
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** JSON Schema (2020-12) for non-TypeScript consumers. Cross-field rules live only in Zod. */
export function diagnosticJsonSchema(): Record<string, unknown> {
  const { $schema, ...generated } = z.toJSONSchema(DiagnosticSchema, { target: "draft-2020-12", io: "output" });
  return {
    $schema,
    $id: "https://engintel.dev/schema/diagnostic.v1.json",
    title: "EngIntel diagnostic",
    description:
      "One finding from any EngIntel adapter. Additional rules enforced by the reference " +
      "implementation: blocking implies severity \"error\"; a range requires a file.",
    ...generated,
  };
}
