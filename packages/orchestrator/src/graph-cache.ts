// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildModuleGraph,
  cacheFromGraph,
  graphCacheKey,
  mergeGraph,
  parseGraphCache,
  planReuse,
  type BuildGraphOptions,
  type ModuleGraph,
} from "@engintel/graph";
import { git, isGitWorkTree, type ScanResult } from "@engintel/scanner";

/**
 * The graph cache in `.engintel/cache/graph-cache.json` (ENG-037). Derived,
 * gitignored, and never an authority: a missing, malformed, or stale cache is
 * a rebuild. A cache file committed to the repository is refused outright,
 * because a pull request could otherwise ship forged edges that hide its own
 * violations.
 */

export const GRAPH_CACHE_FILE = ".engintel/cache/graph-cache.json";

/** Files whose content changes what is installed, beyond the repository's own manifests. */
const INSTALL_STATE = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "node_modules/.modules.yaml",
  "node_modules/.pnpm/lock.yaml",
  "node_modules/.package-lock.json",
  "node_modules/.yarn-state.yml",
];

export interface GraphCacheInfo {
  readonly status: "hit" | "partial" | "miss" | "off" | "refused";
  readonly reused: number;
  readonly cruised: number;
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function hashIfFile(root: string, path: string): string | null {
  const absolute = join(root, ...path.split("/"));
  try {
    return lstatSync(absolute).isFile() ? sha256(readFileSync(absolute)) : null;
  } catch {
    return null;
  }
}

/** True when anything under .engintel/cache/ is tracked by git: the cache then comes from the pull request itself. */
export function cacheIsCommitted(root: string): boolean {
  if (!isGitWorkTree(root)) return false;
  try {
    return git(root, ["ls-files", "-z", "--", ".engintel/cache"]).length > 0;
  } catch {
    return true; // cannot tell: do not trust it
  }
}

export async function buildGraphWithCache(options: {
  readonly root: string;
  readonly scan: ScanResult;
  readonly analyzed: readonly string[];
  readonly engineVersion: string;
  readonly useCache: boolean;
  readonly graph: Omit<BuildGraphOptions, "root" | "files">;
  readonly writeCache: (content: string) => void;
}): Promise<{ graph: ModuleGraph; cache: GraphCacheInfo }> {
  const { root, scan, analyzed } = options;
  const full = () => buildModuleGraph({ ...options.graph, root, files: analyzed });
  if (!options.useCache) return { graph: await full(), cache: { status: "off", reused: 0, cruised: analyzed.length } };
  if (cacheIsCommitted(root)) return { graph: await full(), cache: { status: "refused", reused: 0, cruised: analyzed.length } };

  const shas = new Map<string, string>();
  const analyzedSet = new Set(analyzed);
  for (const f of scan.files) if (analyzedSet.has(f.path) && f.sha256) shas.set(f.path, f.sha256);
  let key: string;
  try {
    key = graphCacheKey({
      engineVersion: options.engineVersion,
      tsconfig: options.graph.tsconfig ?? (existsSync(join(root, "tsconfig.json")) ? "tsconfig.json" : null),
      paths: scan.files.map((f) => f.path),
      configHashes: Object.fromEntries(scan.files.filter((f) => f.kind === "config" && f.sha256).map((f) => [f.path, f.sha256 as string])),
      installHashes: Object.fromEntries(INSTALL_STATE.map((p) => [p, hashIfFile(root, p)])),
      analyzed,
    });
  } catch {
    return { graph: await full(), cache: { status: "off", reused: 0, cruised: analyzed.length } };
  }

  const cacheText = (() => {
    const absolute = join(root, ...GRAPH_CACHE_FILE.split("/"));
    try {
      return lstatSync(absolute).isFile() ? readFileSync(absolute, "utf8") : null;
    } catch {
      return null;
    }
  })();
  const plan = planReuse(cacheText === null ? null : parseGraphCache(cacheText), key, shas);
  const fresh = plan.toCruise.length > 0 ? await buildModuleGraph({ ...options.graph, root, files: plan.toCruise }) : { schemaVersion: 1 as const, nodes: [], edges: [] };
  const graph = plan.status === "miss" ? fresh : mergeGraph(analyzed, plan.reused, fresh);
  const next = `${JSON.stringify(cacheFromGraph(key, shas, graph))}\n`;
  if (next !== cacheText) options.writeCache(next);
  return { graph, cache: { status: plan.status, reused: plan.reused.size, cruised: plan.toCruise.length } };
}
