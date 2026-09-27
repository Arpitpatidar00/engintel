// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { CONFIG_PATH, ConfigError, DEFAULT_LIMITS, configJsonSchema, loadConfig, parseConfig } from "../src/index.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoWithConfig(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "engintel-cfg-"));
  created.push(dir);
  if (content !== undefined) {
    mkdirSync(join(dir, ".engintel"));
    writeFileSync(join(dir, CONFIG_PATH), content);
  }
  return dir;
}

function parseError(document: unknown): ConfigError {
  try {
    parseConfig(document);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected parseConfig to throw");
}

describe("loadConfig (ENG-034)", () => {
  test("a missing config means defaults", () => {
    expect(loadConfig(repoWithConfig())).toEqual({
      file: ".engintel/config.json",
      present: false,
      config: { include: undefined, exclude: [], tsconfig: undefined, limits: DEFAULT_LIMITS, telemetryUpload: false },
      notices: [],
    });
  });

  test("a full config resolves, merging limits over defaults", () => {
    const loaded = loadConfig(
      repoWithConfig(JSON.stringify({ schemaVersion: 1, include: ["src/**"], exclude: ["**/*.gen.ts"], tsconfig: "tsconfig.app.json", limits: { graphTimeoutMs: 30_000 } })),
    );
    expect(loaded.present).toBe(true);
    expect(loaded.config).toEqual({
      include: ["src/**"],
      exclude: ["**/*.gen.ts"],
      tsconfig: "tsconfig.app.json",
      limits: { ...DEFAULT_LIMITS, graphTimeoutMs: 30_000 },
      telemetryUpload: false,
    });
  });

  test("invalid JSON is E_CONFIG_INVALID_JSON", () => {
    expect(() => loadConfig(repoWithConfig("{"))).toThrow(expect.objectContaining({ code: "E_CONFIG_INVALID_JSON" }));
  });

  test.each([
    ["unknown key", { schemaVersion: 1, ignoreAll: true }, "ignoreAll"],
    ["wrong schemaVersion", { schemaVersion: 2 }, "schemaVersion"],
    ["negated glob", { schemaVersion: 1, exclude: ["!src/**"] }, "exclude[0]"],
    ["absolute tsconfig", { schemaVersion: 1, tsconfig: "/etc/tsconfig.json" }, "tsconfig"],
    ["tsconfig outside the repo", { schemaVersion: 1, tsconfig: "../tsconfig.json" }, "tsconfig"],
    ["unknown limit", { schemaVersion: 1, limits: { maxCpu: 4 } }, "limits"],
    ["zero timeout", { schemaVersion: 1, limits: { graphTimeoutMs: 0 } }, "limits.graphTimeoutMs"],
    ["policy knob", { schemaVersion: 1, opaqueImports: "warn" }, ""],
  ])("%s is rejected", (_, document, path) => {
    const error = parseError(document);
    expect(error.code).toBe("E_CONFIG_INVALID");
    expect(JSON.stringify(error.issues)).toContain(path);
  });

  test.each([
    ["secret key", { schemaVersion: 1, apiKey: "x" }, "apiKey"],
    ["nested secret key", { schemaVersion: 1, limits: { githubToken: 1 } }, "limits.githubToken"],
    ["credential value", { schemaVersion: 1, include: ["ghp_abcdefghijklmnop"] }, "include[0]"],
    ["private key value", { schemaVersion: 1, tsconfig: "-----BEGIN PRIVATE KEY-----" }, "tsconfig"],
  ])("%s is refused before schema validation", (_, document, path) => {
    const error = parseError(document);
    expect(error.issues[0]?.path).toBe(path);
    expect(error.message).toContain("secret");
  });

  test("overlays are reserved", () => {
    expect(parseError({ schemaVersion: 1, extends: "@org/policy" }).message).toContain("reserved for organization overlays");
    expect(parseError({ schemaVersion: 1, overlays: [] }).message).toContain("reserved for organization overlays");
  });

  test("telemetry.enable cannot turn on upload", () => {
    const loaded = parseConfig({ schemaVersion: 1, telemetry: { enable: true } });
    expect(loaded.config.telemetryUpload).toBe(false);
    expect(loaded.notices).toEqual(["telemetry.enable in the repository config is ignored; only the operator can enable telemetry."]);
  });
});

describe("configJsonSchema", () => {
  test("matches the committed schema file", async () => {
    await expect(`${JSON.stringify(configJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../schema/config.schema.json");
  });
});
