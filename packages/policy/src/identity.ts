// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { createHash } from "node:crypto";
import { normalizeRepoPath, toPosix } from "@engintel/config";

/**
 * Violation identity (ENG-035; research doc 08, section 3; FR-009).
 *
 *   identity = sha256_hex(utf8(ruleId US source US target US cycleSignature))
 *
 * where US is U+001F (UNIT SEPARATOR), source and target are normalized node
 * ids, and cycleSignature is "" for non-cycle rules. The research documents
 * proposed \0, \n, and \u001f; ENG-035 is the implementation ticket and fixes
 * \u001f. Line numbers, messages, severity, edge kind, and engine or policy
 * versions are deliberately not part of the identity: none of them change
 * which debt a violation is.
 *
 * Changing anything here changes every baseline entry. That requires a new
 * IDENTITY_VERSION and a human-run migration, never a quiet edit. The
 * known-answer vectors in testdata/identity-vectors.json are append-only.
 */

export const IDENTITY_VERSION = 1;
export const IDENTITY_SEPARATOR = "\u001f";

/**
 * Built-in targets that are not paths (doc 08, section 3.3). They normalize to
 * themselves. Appending a token is safe: `<name>` is already a fixed point of
 * repo-path normalization, so no existing identity changes.
 */
export const IDENTITY_TOKENS = ["<missing>", "<unanalyzable>", "<unreachable-from>", "<unlayered>", "<overlapping-layers>"] as const;

export interface IdentityInput {
  readonly ruleId: string;
  readonly source: string;
  readonly target: string;
  /** Canonical cycle signature for cycle rules. null, undefined, and "" are the same. */
  readonly cycleSignature?: string | null;
}

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

const PACKAGE_NAME = /^(?:@[^/\\]+\/)?[^/\\]+$/;

/**
 * Normalize a graph node id for hashing. Repo paths become canonical POSIX
 * (so a Windows spelling hashes like its POSIX twin); package names are
 * case-folded because npm treats them case-insensitively; tokens, core
 * modules, and unresolved specifiers keep their spelling apart from
 * separators and Unicode form.
 */
export function normalizeIdentityNode(node: string): string {
  if ((IDENTITY_TOKENS as readonly string[]).includes(node)) return node;
  if (node.startsWith("external:")) {
    const rest = node.slice("external:".length);
    return `external:${PACKAGE_NAME.test(rest) ? rest.toLowerCase() : toPosix(rest).normalize("NFC")}`;
  }
  for (const prefix of ["core:", "unresolved:"]) {
    if (node.startsWith(prefix)) return `${prefix}${toPosix(node.slice(prefix.length)).normalize("NFC")}`;
  }
  try {
    return normalizeRepoPath(node);
  } catch (error) {
    throw new IdentityError(`cannot normalize "${node}" for a violation identity: ${(error as Error).message}`);
  }
}

/** Separators and Unicode form only: a signature is already canonically rotated and must not be re-rotated. */
export function normalizeCycleSignature(signature: string | null | undefined): string {
  return signature ? toPosix(signature).normalize("NFC") : "";
}

/** The exact UTF-8 payload that is hashed. Exposed for the vector file and for debugging. */
export function identityPayload(input: IdentityInput): string {
  if (!input.ruleId) throw new IdentityError("ruleId is empty");
  const fields = [
    input.ruleId,
    normalizeIdentityNode(input.source),
    normalizeIdentityNode(input.target),
    normalizeCycleSignature(input.cycleSignature),
  ];
  for (const field of fields) {
    if (field.includes(IDENTITY_SEPARATOR)) throw new IdentityError("identity fields may not contain U+001F");
  }
  return fields.join(IDENTITY_SEPARATOR);
}

/** Lowercase hex sha256 identity of a violation. */
export function violationIdentity(input: IdentityInput): string {
  return createHash("sha256").update(identityPayload(input), "utf8").digest("hex");
}
