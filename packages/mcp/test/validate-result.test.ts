// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { FORBIDDEN_AUTHORITY_KEYS, MERGE_AUTHORITY, type Diagnostic } from "@engintel/config";
import { describe, expect, test } from "vitest";
import {
  AuthorityClaimError,
  McpValidateResultSchema,
  createMcpValidateResult,
  type McpValidateResult,
} from "../src/index.js";

const violation: Diagnostic = {
  schemaVersion: 1,
  identity: "b".repeat(64),
  adapter: "architecture",
  ruleId: "no-controller-to-repository",
  severity: "error",
  blocking: true,
  file: "src/controllers/order.controller.ts",
  message: "controllers may not import repositories",
  why: "Do not skip the service layer.",
  suggest: { kind: "use-layer", layers: ["controllers", "services", "repositories"], explanation: "Use OrderService." },
};

const failing = {
  schemaVersion: 1,
  localOutcome: "fail",
  exitEquivalent: 1,
  blocking: 1,
  advisory: 0,
  unanalyzable: [],
  diagnostics: [violation],
  mergeAuthority: MERGE_AUTHORITY,
} as const;

const passing = { ...failing, localOutcome: "pass", exitEquivalent: 0, blocking: 0, diagnostics: [] } as const;

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "ok";
  } catch (error) {
    if (error instanceof AuthorityClaimError) return error.code;
    return error instanceof Error ? error.name : "unknown";
  }
}

describe("McpValidateResult type", () => {
  test("cannot hold an authority claim, even when built from a variable", () => {
    const result: McpValidateResult = createMcpValidateResult(passing);

    const approved = { ...result, approved: true };
    // @ts-expect-error `approved` is typed `never`: no value of it is assignable.
    const a: McpValidateResult = approved;

    const mayMerge = { ...result, mayMerge: true };
    // @ts-expect-error `mayMerge` is typed `never`.
    const b: McpValidateResult = mayMerge;

    const explicitUndefined = { ...result, approved: undefined };
    // @ts-expect-error even `undefined` is rejected under exactOptionalPropertyTypes.
    const c: McpValidateResult = explicitUndefined;

    // Runtime is irrelevant here; `pnpm typecheck` fails if any directive above goes unused.
    expect([a, b, c]).toHaveLength(3);
  });

  test("the schema shape has no authority keys", () => {
    const keys = Object.keys(McpValidateResultSchema.shape);
    for (const key of FORBIDDEN_AUTHORITY_KEYS) expect(keys).not.toContain(key);
    expect(McpValidateResultSchema.shape.mergeAuthority.value).toBe("github-required-check");
  });
});

describe("createMcpValidateResult", () => {
  test("accepts consistent passing and failing results", () => {
    expect(createMcpValidateResult(passing).localOutcome).toBe("pass");
    expect(createMcpValidateResult(failing).blocking).toBe(1);
  });

  test.each(FORBIDDEN_AUTHORITY_KEYS)("rejects a top-level %s field, whatever its value", (key) => {
    for (const value of [true, false, null, "yes"]) {
      expect(codeOf(() => createMcpValidateResult({ ...passing, [key]: value }))).toBe("E_AUTHORITY_CLAIM");
    }
  });

  test("rejects an authority claim nested inside a diagnostic", () => {
    const nested = { ...failing, diagnostics: [{ ...violation, approved: true }] };
    try {
      createMcpValidateResult(nested);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorityClaimError);
      expect((error as AuthorityClaimError).paths).toEqual(["$.diagnostics[0].approved"]);
    }
  });

  test("the schema alone also rejects authority claims (strict objects)", () => {
    expect(McpValidateResultSchema.safeParse({ ...passing, approved: false }).success).toBe(false);
  });

  test.each([
    ["merge authority other than the GitHub check", { ...passing, mergeAuthority: "mcp" }],
    ["pass with a blocking finding", { ...failing, localOutcome: "pass", exitEquivalent: 0 }],
    ["pass with an unanalyzable changed file", { ...passing, unanalyzable: ["src/broken.ts"] }],
    ["fail with nothing blocking", { ...passing, localOutcome: "fail", exitEquivalent: 1 }],
    ["exit code that contradicts the outcome", { ...failing, exitEquivalent: 0 }],
    ["blocking count that contradicts the diagnostics", { ...failing, blocking: 0 }],
    ["advisory count that contradicts the diagnostics", { ...failing, advisory: 3 }],
    ["unanalyzable path outside the repository", { ...failing, unanalyzable: ["../etc/passwd"] }],
  ])("rejects %s", (_name, input) => {
    expect(codeOf(() => createMcpValidateResult(input))).toBe("ZodError");
  });

  test("an unanalyzable changed file fails the run on its own", () => {
    const result = createMcpValidateResult({ ...passing, localOutcome: "fail", exitEquivalent: 1, unanalyzable: ["src/broken.ts"] });
    expect(result.localOutcome).toBe("fail");
  });
});
