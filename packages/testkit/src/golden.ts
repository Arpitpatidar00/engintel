// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RepoPathSchema } from "@engintel/config";
import * as z from "zod";
import { computeTreeHash } from "./tree-hash.js";

/** The nine golden repositories reserved in Phase 0 (research docs 21, 24). See tests/golden/GOLDEN.md. */
export const GOLDEN_IDS = [
  "valid-architecture",
  "circular",
  "invalid-layer",
  "unresolved",
  "existing-violations",
  "exceptions",
  "policy-change",
  "prompt-injection",
  "unreadable-files",
] as const;

export type GoldenId = (typeof GOLDEN_IDS)[number];

/** expected.json is the one file a fixture may change without changing what it tests. */
export const EXCLUDED_FROM_TREE_HASH = "expected.json";

export const TREE_HASH_DEFINITION =
  'sha256 of the lines "<posix path>\\0<sha256 of raw bytes>", sorted by path and joined by "\\n", ' +
  "for every regular file under the fixture directory except expected.json at its root";

const SemverSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "fixtureVersion is x.y.z");
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const GoldenManifestSchema = z.strictObject({
  fixtureVersion: SemverSchema,
  treeHash: z.strictObject({ algorithm: z.literal("sha256"), definition: z.string() }),
  fixtures: z.record(z.enum(GOLDEN_IDS), z.strictObject({ treeHash: Sha256Schema })),
});

export type GoldenManifest = z.infer<typeof GoldenManifestSchema>;

/**
 * One way to run a fixture. Replaces git history so tests are hermetic
 * (research doc 07, section 9): the changed-file scope, the clock, and
 * optional merge-base files and overlays.
 */
export const ScenarioSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    description: z.string().min(1),
    mode: z.enum(["full", "changed"]),
    /** Paths relative to the fixture's repo/ directory (after the overlay is applied). */
    changedFiles: z.array(RepoPathSchema),
    contractChanged: z.boolean(),
    /** Directory holding merge-base versions of changed files, or null. */
    base: z.literal("base").nullable(),
    /** Directory whose files are copied over repo/ before running, or null. */
    overlay: z.string().regex(/^overlays\/[a-z0-9-]+$/).nullable(),
    /** The injected clock (YYYY-MM-DD). Validation never reads the wall clock. */
    now: z.iso.date(),
  })
  .superRefine((s, ctx) => {
    if (s.mode === "full" && s.changedFiles.length > 0) {
      ctx.addIssue({ code: "custom", path: ["changedFiles"], message: "full mode takes no changed files" });
    }
    if (s.mode === "changed" && s.changedFiles.length === 0) {
      ctx.addIssue({ code: "custom", path: ["changedFiles"], message: "changed mode needs at least one changed file" });
    }
  });

export type Scenario = z.infer<typeof ScenarioSchema>;

/** The directory holding pnpm-workspace.yaml, found by walking up from `start`. */
export function findWorkspaceRoot(start: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no pnpm-workspace.yaml above ${start}`);
    dir = parent;
  }
}

export function goldenRoot(workspaceRoot: string = findWorkspaceRoot()): string {
  return join(workspaceRoot, "tests", "golden");
}

export function manifestPath(workspaceRoot?: string): string {
  return join(goldenRoot(workspaceRoot), "manifest.json");
}

export function readManifest(workspaceRoot?: string): GoldenManifest {
  return GoldenManifestSchema.parse(JSON.parse(readFileSync(manifestPath(workspaceRoot), "utf8")));
}

export function fixtureTreeHash(fixtureDir: string): string {
  return computeTreeHash(fixtureDir, (path) => path === EXCLUDED_FROM_TREE_HASH);
}

/** Directory names under tests/golden/ (the manifest and docs are files, not fixtures). */
export function listFixtureDirs(workspaceRoot?: string): string[] {
  return readdirSync(goldenRoot(workspaceRoot), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function computeFixtureHashes(workspaceRoot?: string): Record<GoldenId, string> {
  const root = goldenRoot(workspaceRoot);
  return Object.fromEntries(GOLDEN_IDS.map((id) => [id, fixtureTreeHash(join(root, id))])) as Record<
    GoldenId,
    string
  >;
}

/** -1, 0, or 1. Plain x.y.z only. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}
