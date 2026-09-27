// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ArchitectureContractSchema } from "@engintel/config";
import { describe, expect, test } from "vitest";
import {
  GOLDEN_IDS,
  ScenarioSchema,
  fixtureTreeHash,
  goldenRoot,
  listFixtureDirs,
  readManifest,
} from "../src/index.js";

const root = goldenRoot();
const manifest = readManifest();
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

describe("golden manifest", () => {
  test("tests/golden contains exactly the reserved fixtures", () => {
    expect(listFixtureDirs()).toEqual([...GOLDEN_IDS].sort());
  });

  test.each(GOLDEN_IDS)("%s matches its recorded treeHash", (id) => {
    expect(
      fixtureTreeHash(join(root, id)),
      `fixture "${id}" changed. If intended, run: pnpm golden:update --version <greater than ${manifest.fixtureVersion}>`,
    ).toBe(manifest.fixtures[id].treeHash);
  });

  test("GOLDEN.md documents every fixture", () => {
    const doc = readFileSync(join(root, "GOLDEN.md"), "utf8");
    for (const id of GOLDEN_IDS) expect(doc).toContain(`\`${id}\``);
  });
});

describe.each(GOLDEN_IDS)("fixture %s", (id) => {
  const dir = join(root, id);

  test("has repo/, at least one scenario, and a JSON-object expected.json", () => {
    expect(existsSync(join(dir, "repo"))).toBe(true);
    expect(readdirSync(join(dir, "scenarios")).filter((f) => f.endsWith(".json")).length).toBeGreaterThan(0);
    const expected = readJson(join(dir, "expected.json"));
    expect(typeof expected === "object" && expected !== null && !Array.isArray(expected)).toBe(true);
  });

  test("its architecture contract is valid under the Phase 0 schema", () => {
    const parsed = ArchitectureContractSchema.safeParse(readJson(join(dir, "repo", ".engintel", "architecture.json")));
    expect(parsed.error?.issues ?? []).toEqual([]);
    const baseContract = join(dir, "base", ".engintel", "architecture.json");
    if (existsSync(baseContract)) expect(ArchitectureContractSchema.safeParse(readJson(baseContract)).success).toBe(true);
  });

  const scenarios = readdirSync(join(dir, "scenarios")).filter((f) => f.endsWith(".json"));
  test.each(scenarios)("scenario %s is well-formed and points at real files", (file) => {
    const scenario = ScenarioSchema.parse(readJson(join(dir, "scenarios", file)));
    if (scenario.base) expect(existsSync(join(dir, scenario.base))).toBe(true);
    if (scenario.overlay) expect(existsSync(join(dir, scenario.overlay))).toBe(true);
    for (const changed of scenario.changedFiles) {
      const inRepo = existsSync(join(dir, "repo", changed));
      const inOverlay = scenario.overlay !== null && existsSync(join(dir, scenario.overlay, changed));
      expect(inRepo || inOverlay, `${changed} not found in repo/ or the overlay`).toBe(true);
    }
  });
});
