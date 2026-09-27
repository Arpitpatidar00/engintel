// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GOLDEN_IDS,
  ScenarioSchema,
  findWorkspaceRoot,
  goldenRoot,
  readManifest,
  type GoldenId,
  type Scenario,
} from "./golden.js";

export interface GoldenFixture {
  readonly id: GoldenId;
  /** Absolute path of tests/golden/<id>. */
  readonly dir: string;
  /** Absolute path of the repository EngIntel analyzes. */
  readonly repoDir: string;
  /** treeHash recorded in manifest.json. */
  readonly treeHash: string;
  readonly scenarios: Readonly<Record<string, Scenario>>;
  /** Parsed expected.json, or null while it is still `{}` (Phase 0). */
  readonly expected: Readonly<Record<string, unknown>> | null;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Load every golden fixture, in GOLDEN_IDS order. Throws on any malformed file. */
export function loadGoldens(workspaceRoot: string = findWorkspaceRoot()): GoldenFixture[] {
  const root = goldenRoot(workspaceRoot);
  const manifest = readManifest(workspaceRoot);
  return GOLDEN_IDS.map((id) => {
    const dir = join(root, id);
    const scenarios: Record<string, Scenario> = {};
    for (const file of readdirSync(join(dir, "scenarios")).filter((f) => f.endsWith(".json")).sort()) {
      scenarios[file.replace(/\.json$/, "")] = ScenarioSchema.parse(readJson(join(dir, "scenarios", file)));
    }
    const expected = readJson(join(dir, "expected.json"));
    if (typeof expected !== "object" || expected === null || Array.isArray(expected)) {
      throw new Error(`${id}/expected.json must be a JSON object`);
    }
    return {
      id,
      dir,
      repoDir: join(dir, "repo"),
      treeHash: manifest.fixtures[id].treeHash,
      scenarios,
      expected: Object.keys(expected).length === 0 ? null : (expected as Record<string, unknown>),
    };
  });
}

export interface MaterializedScenario {
  /** A throwaway copy of repo/ with the scenario's overlay applied. Safe to mutate. */
  readonly dir: string;
  readonly scenario: Scenario;
  /** Absolute path of base/ when the scenario has one. */
  readonly baseDir: string | null;
  cleanup(): void;
}

/**
 * Copy a fixture's repo/ into a fresh temporary directory and apply the
 * scenario's overlay. Tests run against the copy, never the committed fixture,
 * so nothing a test does can change a treeHash.
 */
export function materializeScenario(fixture: GoldenFixture, scenarioName: string): MaterializedScenario {
  const scenario = fixture.scenarios[scenarioName];
  if (!scenario) throw new Error(`fixture ${fixture.id} has no scenario "${scenarioName}"`);
  const dir = mkdtempSync(join(tmpdir(), `engintel-golden-${fixture.id}-`));
  cpSync(fixture.repoDir, dir, { recursive: true, verbatimSymlinks: true });
  if (scenario.overlay) cpSync(join(fixture.dir, scenario.overlay), dir, { recursive: true, verbatimSymlinks: true });
  const baseDir = scenario.base ? join(fixture.dir, scenario.base) : null;
  if (baseDir && !existsSync(baseDir)) throw new Error(`fixture ${fixture.id} is missing ${scenario.base}/`);
  return { dir, scenario, baseDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
