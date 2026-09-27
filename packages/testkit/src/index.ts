// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

export {
  IGNORED_NAMES,
  computeTreeHash,
  listTree,
  sha256Hex,
  treeHashOf,
  type TreeEntry,
} from "./tree-hash.js";

export {
  EXCLUDED_FROM_TREE_HASH,
  GOLDEN_IDS,
  GoldenManifestSchema,
  ScenarioSchema,
  TREE_HASH_DEFINITION,
  compareSemver,
  computeFixtureHashes,
  findWorkspaceRoot,
  fixtureTreeHash,
  goldenRoot,
  listFixtureDirs,
  manifestPath,
  readManifest,
  type GoldenId,
  type GoldenManifest,
  type Scenario,
} from "./golden.js";

export { loadGoldens, materializeScenario, type GoldenFixture, type MaterializedScenario } from "./loader.js";

export { E_NOT_IMPLEMENTED, runCli, type CliRunOptions, type CliRunResult } from "./cli-runner.js";
