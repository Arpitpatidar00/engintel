// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

// Usage: pnpm golden:update --version <x.y.z>
//
// Recomputes every golden fixture's treeHash. If any fixture changed, the
// manifest is only rewritten together with a higher fixtureVersion, so a
// changed fixture can never silently keep the old version.

import { existsSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  GOLDEN_IDS,
  GoldenManifestSchema,
  TREE_HASH_DEFINITION,
  compareSemver,
  computeFixtureHashes,
  listFixtureDirs,
  manifestPath,
  readManifest,
  type GoldenManifest,
} from "../golden.js";

function fail(message: string): never {
  console.error(`golden:update: ${message}`);
  process.exit(1);
}

const { values } = parseArgs({ options: { version: { type: "string" } } });

const dirs = listFixtureDirs();
const expected = [...GOLDEN_IDS].sort();
if (JSON.stringify(dirs) !== JSON.stringify(expected)) {
  fail(`tests/golden must contain exactly ${expected.join(", ")}; found ${dirs.join(", ")}`);
}

const hashes = computeFixtureHashes();
const current: GoldenManifest | null = existsSync(manifestPath()) ? readManifest() : null;
const changed = GOLDEN_IDS.filter((id) => current?.fixtures[id]?.treeHash !== hashes[id]);

if (current && changed.length === 0) {
  console.log(`golden:update: up to date (fixtureVersion ${current.fixtureVersion})`);
  process.exit(0);
}

const version = values.version ?? fail(`fixtures changed (${changed.join(", ")}); pass --version <x.y.z>`);
if (current && compareSemver(version, current.fixtureVersion) <= 0) {
  fail(`--version ${version} must be greater than the current fixtureVersion ${current.fixtureVersion}`);
}

const manifest = GoldenManifestSchema.parse({
  fixtureVersion: version,
  treeHash: { algorithm: "sha256", definition: TREE_HASH_DEFINITION },
  fixtures: Object.fromEntries(GOLDEN_IDS.map((id) => [id, { treeHash: hashes[id] }])),
});
writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`golden:update: fixtureVersion ${version}; changed: ${changed.join(", ")}`);
