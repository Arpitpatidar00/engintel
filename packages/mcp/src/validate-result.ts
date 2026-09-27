// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import {
  DiagnosticSchema,
  MERGE_AUTHORITY,
  RepoPathSchema,
  findAuthorityClaims,
  type NoAuthorityClaims,
} from "@engintel/config";
import * as z from "zod";

/**
 * The result of the `validate_changes` MCP tool (research docs 03, 12).
 *
 * It reports what a local run computed. It is not a merge permit and cannot
 * be made to look like one: there is no approval field, of any value, and
 * `mergeAuthority` always names the GitHub required check.
 */
export const McpValidateResultSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    /** What this local run computed. Never merge evidence. */
    localOutcome: z.enum(["pass", "fail", "error"]),
    /** The exit code `engintel validate` would have returned: 0 pass, 1 violations, 2 tool error. */
    exitEquivalent: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    blocking: z.number().int().min(0),
    advisory: z.number().int().min(0),
    /** Changed files the analyzer could not judge. Any entry fails closed. */
    unanalyzable: z.array(RepoPathSchema),
    diagnostics: z.array(DiagnosticSchema),
    mergeAuthority: z.literal(MERGE_AUTHORITY),
  })
  .superRefine((r, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    const expectedExit = { pass: 0, fail: 1, error: 2 }[r.localOutcome];
    if (r.exitEquivalent !== expectedExit) {
      issue("exitEquivalent", `localOutcome "${r.localOutcome}" means exit ${expectedExit}`);
    }
    const blocking = r.diagnostics.filter((d) => d.blocking).length;
    if (r.blocking !== blocking) issue("blocking", `diagnostics contain ${blocking} blocking findings`);
    if (r.advisory !== r.diagnostics.length - blocking) {
      issue("advisory", `diagnostics contain ${r.diagnostics.length - blocking} non-blocking findings`);
    }
    const failsClosed = blocking > 0 || r.unanalyzable.length > 0;
    if (r.localOutcome === "pass" && failsClosed) {
      issue("localOutcome", "a run with blocking findings or unanalyzable files cannot pass");
    }
    if (r.localOutcome === "fail" && !failsClosed) {
      issue("localOutcome", "a failing run must report a blocking finding or an unanalyzable file");
    }
  });

/** The parsed result. Forbidden authority keys are typed `never`, so no object carrying one is assignable. */
export type McpValidateResult = z.output<typeof McpValidateResultSchema> & NoAuthorityClaims;

export class AuthorityClaimError extends Error {
  readonly code = "E_AUTHORITY_CLAIM";
  readonly paths: string[];

  constructor(paths: string[]) {
    super(`MCP results cannot claim merge authority; found ${paths.join(", ")}`);
    this.name = "AuthorityClaimError";
    this.paths = paths;
  }
}

/**
 * The only way to build a result for the wire. Rejects authority claims at any
 * depth before schema validation, so a loosely typed field added later cannot
 * smuggle one through.
 */
export function createMcpValidateResult(input: unknown): McpValidateResult {
  const claims = findAuthorityClaims(input);
  if (claims.length > 0) throw new AuthorityClaimError(claims);
  return McpValidateResultSchema.parse(input);
}
