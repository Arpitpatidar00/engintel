// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

/**
 * The trust model (research docs 00 section 12, 03 section 5, 28).
 *
 * The agent is never the authority. MCP informs and requests validation. The
 * GitHub required check independently re-runs `engintel validate --changed`
 * and is the only thing that can allow a merge. A PASS claimed by an agent, an
 * MCP transcript, or a local CLI run is untrusted evidence.
 */
export const TRUST_ZONES = {
  agent: "untrusted-decision-maker",
  repositoryContents: "untrusted-input",
  mcpTranscripts: "untrusted-evidence",
  architectureContract: "trusted-policy",
  localValidator: "trusted-local-enforcement",
  githubRequiredCheck: "final-enforcement",
} as const;

export type TrustZone = keyof typeof TRUST_ZONES;

/** The only merge authority. Stamped on results so no reader can mistake local output for permission. */
export const MERGE_AUTHORITY = "github-required-check";

/** Field names that would let a result claim merge authority. No EngIntel result may carry them, at any depth. */
export const FORBIDDEN_AUTHORITY_KEYS = ["approved", "mayMerge", "canMerge", "mergeable", "bypass"] as const;

export type ForbiddenAuthorityKey = (typeof FORBIDDEN_AUTHORITY_KEYS)[number];

/** Makes every forbidden key unassignable: `{ approved: true }` does not type-check, nor does `{ approved: undefined }`. */
export type NoAuthorityClaims = { readonly [K in ForbiddenAuthorityKey]?: never };

/** JSON-path-like locations of every forbidden key in `value`, e.g. `["$.approved", "$.diagnostics[0].mayMerge"]`. */
export function findAuthorityClaims(value: unknown): string[] {
  const forbidden = new Set<string>(FORBIDDEN_AUTHORITY_KEYS);
  const found: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (node: unknown, path: string): void => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (forbidden.has(key)) found.push(`${path}.${key}`);
      visit(child, `${path}.${key}`);
    }
  };
  visit(value, "$");
  return found;
}
