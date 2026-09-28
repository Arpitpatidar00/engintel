// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

// Cache keys for the EngIntel GitHub Action (ENG-040). Plain JavaScript on
// purpose: it runs before EngIntel is built, to restore that build.
//
// Keys are made only of the runner OS, versions, content hashes, and the
// commit sha. No environment value, token, or secret ever reaches a key.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const KEY_VERSION = "v1";

/** Lockfiles that pin what a repository installs. */
export const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lockb", "bun.lock"];

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === "dist" || name === ".turbo") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** sha256 over "path\0sha256(content)" lines of the given files, in path order. */
export function hashFiles(root, files) {
  const lines = [...new Set(files)]
    .filter((f) => existsSync(join(root, f)) && statSync(join(root, f)).isFile())
    .sort()
    .map((f) => `${f}\0${createHash("sha256").update(readFileSync(join(root, f))).digest("hex")}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** Every file that determines EngIntel's own build output. */
export function engintelSources(engintelRoot) {
  const files = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", "turbo.json", ".npmrc"];
  const packages = join(engintelRoot, "packages");
  for (const pkg of readdirSync(packages).sort()) {
    for (const top of ["package.json", "tsconfig.json", "tsconfig.build.json"]) files.push(`packages/${pkg}/${top}`);
    for (const dir of ["src", "schema"]) {
      const abs = join(packages, pkg, dir);
      if (existsSync(abs)) for (const f of walk(abs)) files.push(relative(engintelRoot, f).split(sep).join("/"));
    }
  }
  return files;
}

const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "-");

/**
 * @param {{ engintelRoot: string, workspace: string, os: string, nodeVersion: string, sha: string }} input
 */
export function computeKeys({ engintelRoot, workspace, os, nodeVersion, sha }) {
  const engineVersion = JSON.parse(readFileSync(join(engintelRoot, "packages", "orchestrator", "package.json"), "utf8")).version;
  const nodeMajor = /^v?(\d+)/.exec(nodeVersion)?.[1] ?? "unknown";
  const build = `engintel-build-${KEY_VERSION}-${safe(os)}-node${nodeMajor}-${hashFiles(engintelRoot, engintelSources(engintelRoot))}`;
  const graphPrefix = `engintel-graph-${KEY_VERSION}-${safe(os)}-${safe(engineVersion)}-${hashFiles(workspace, LOCKFILES).slice(0, 32)}-`;
  return { buildKey: build, graphKey: `${graphPrefix}${safe(sha)}`, graphRestorePrefix: graphPrefix, engineVersion };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const keys = computeKeys({
    engintelRoot: process.env.ENGINTEL_HOME ?? process.cwd(),
    workspace: process.env.ENGINTEL_WORKSPACE ?? process.cwd(),
    os: process.env.RUNNER_OS ?? process.platform,
    nodeVersion: process.version,
    sha: process.env.GITHUB_SHA ?? "local",
  });
  const lines = [`build-key=${keys.buildKey}`, `graph-key=${keys.graphKey}`, `graph-restore-prefix=${keys.graphRestorePrefix}`];
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(out, `${lines.join("\n")}\n`);
  } else {
    process.stdout.write(`${lines.join("\n")}\n`);
  }
}
