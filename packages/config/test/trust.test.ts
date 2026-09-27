// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { describe, expect, test } from "vitest";
import { MERGE_AUTHORITY, TRUST_ZONES, findAuthorityClaims } from "../src/index.js";

describe("trust model", () => {
  test("the GitHub required check is the only final enforcement", () => {
    const final = Object.entries(TRUST_ZONES).filter(([, trust]) => trust === "final-enforcement");
    expect(final).toEqual([["githubRequiredCheck", "final-enforcement"]]);
    expect(MERGE_AUTHORITY).toBe("github-required-check");
  });

  test("agents, repository contents, and MCP transcripts are untrusted", () => {
    expect(TRUST_ZONES.agent).toMatch(/^untrusted-/);
    expect(TRUST_ZONES.repositoryContents).toMatch(/^untrusted-/);
    expect(TRUST_ZONES.mcpTranscripts).toMatch(/^untrusted-/);
  });
});

describe("findAuthorityClaims", () => {
  test("finds forbidden keys at any depth, with their paths", () => {
    const value = { ok: true, approved: false, nested: [{ fine: 1 }, { deep: { mayMerge: "yes" } }] };
    expect(findAuthorityClaims(value)).toEqual(["$.approved", "$.nested[1].deep.mayMerge"]);
  });

  test("returns nothing for clean values and primitives", () => {
    expect(findAuthorityClaims({ localOutcome: "pass", diagnostics: [] })).toEqual([]);
    expect(findAuthorityClaims(null)).toEqual([]);
    expect(findAuthorityClaims("approved")).toEqual([]);
  });

  test("survives cyclic objects", () => {
    const cyclic: Record<string, unknown> = { bypass: 1 };
    cyclic.self = cyclic;
    expect(findAuthorityClaims(cyclic)).toEqual(["$.bypass"]);
  });
});
