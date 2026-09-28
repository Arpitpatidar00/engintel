// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BASELINE_PATH, ConfigError, baselineJsonSchema, isAgentAuthor, loadBaseline, parseBaseline, parseBaselineText, serializeBaseline } from "../src/index.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const entry = (identity: string, extra: Record<string, unknown> = {}) => ({
  identity,
  ruleId: "no-controller-to-repository",
  source: "src/controllers/legacy.controller.ts",
  target: "src/repositories/order.repository.ts",
  cycleSignature: null,
  firstSeenAt: "2026-03-02",
  lastSeenAt: "2026-03-02",
  ...extra,
});

const valid = {
  schemaVersion: 1,
  engineIdentityVersion: 1,
  policyVersionAtWrite: "1.0.0",
  writtenAt: "2026-03-02",
  writtenBy: "alice",
  entries: [entry("b".repeat(64)), entry("a".repeat(64), { owner: "@payments", ticket: "PAY-4401", justification: "Predates the service layer." })],
};

function issueOf(document: unknown): string {
  try {
    parseBaseline(document);
  } catch (error) {
    if (error instanceof ConfigError) {
      expect(error.code).toBe("E_BASELINE_INVALID");
      return JSON.stringify(error.issues) + error.message;
    }
    throw error;
  }
  throw new Error("expected parseBaseline to throw");
}

describe("baseline file (ENG-009)", () => {
  test("a valid baseline parses and hashes", () => {
    const loaded = parseBaseline(valid);
    expect(loaded.baseline.entries).toHaveLength(2);
    expect(loaded.baselineHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each([
    ["unknown top-level key", { ...valid, autoApprove: true }, "autoApprove"],
    ["unknown entry key", { ...valid, entries: [entry("a".repeat(64), { waived: true })] }, "waived"],
    ["future identity version", { ...valid, engineIdentityVersion: 2 }, "engineIdentityVersion"],
    ["uppercase identity", { ...valid, entries: [entry("A".repeat(64))] }, "identity"],
    ["duplicate identity", { ...valid, entries: [entry("a".repeat(64)), entry("a".repeat(64))] }, "duplicate identity"],
    ["lastSeenAt before firstSeenAt", { ...valid, entries: [entry("a".repeat(64), { lastSeenAt: "2026-01-01" })] }, "lastSeenAt"],
    ["impossible date", { ...valid, writtenAt: "2026-02-30" }, "writtenAt"],
    ["target is not a node", { ...valid, entries: [entry("a".repeat(64), { target: "../outside.ts" })] }, "target"],
    ["agent author", { ...valid, writtenBy: "Copilot" }, "agent or bot"],
    ["bot author", { ...valid, writtenBy: "renovate[bot]" }, "writtenBy"],
    ["not a login", { ...valid, writtenBy: "alice smith" }, "GitHub login"],
  ])("%s is rejected", (_, document, needle) => {
    expect(issueOf(document)).toContain(needle);
  });

  test("agent authors are recognised case-insensitively", () => {
    for (const login of ["claude", "CURSOR", "engintel-bot", "dependabot[bot]", "my-ci-bot"]) expect(isAgentAuthor(login), login).toBe(true);
    for (const login of ["alice", "bob-smith", "claudette"]) expect(isAgentAuthor(login), login).toBe(false);
  });

  test("loadBaseline: missing is null; broken JSON and symlinks fail closed", () => {
    const root = mkdtempSync(join(tmpdir(), "engintel-baseline-"));
    created.push(root);
    expect(loadBaseline(root)).toBeNull();
    mkdirSync(join(root, ".engintel"));
    writeFileSync(join(root, BASELINE_PATH), "{");
    expect(() => loadBaseline(root)).toThrow(expect.objectContaining({ code: "E_BASELINE_INVALID" }));
    writeFileSync(join(root, BASELINE_PATH), JSON.stringify(valid));
    expect(loadBaseline(root)?.baseline.writtenBy).toBe("alice");
    expect(() => parseBaselineText("nope", BASELINE_PATH, " at the merge base")).toThrow(/at the merge base is not valid JSON/);
  });

  test("serializeBaseline is canonical: entries sorted by identity, stable key order, parses back", () => {
    const text = serializeBaseline(parseBaseline(valid).baseline);
    expect(text.indexOf("a".repeat(64))).toBeLessThan(text.indexOf("b".repeat(64)));
    expect(Object.keys(JSON.parse(text) as object)).toEqual(["schemaVersion", "engineIdentityVersion", "policyVersionAtWrite", "writtenAt", "writtenBy", "entries"]);
    expect(serializeBaseline(parseBaseline(JSON.parse(text)).baseline)).toBe(text);
  });

  test("matches the committed schema file", async () => {
    await expect(`${JSON.stringify(baselineJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../schema/baseline.schema.json");
  });
});
