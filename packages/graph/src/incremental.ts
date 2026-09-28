// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EDGE_KINDS } from "@engintel/config";
import { compareEdges, GRAPH_SCHEMA_VERSION, type GraphEdge, type GraphNode, type ModuleGraph, type NodeKind } from "./model.js";

/**
 * Incremental graph reuse (ENG-037; research docs 20 and 23).
 *
 * A file's outgoing edges depend only on its own bytes and on the resolution
 * environment: which files exist, the tsconfig and package manifests, and
 * what is installed. The environment is hashed into one key; while the key
 * holds, a file whose sha256 is unchanged keeps its cached edges and only the
 * edited files are cruised again. Any change to the environment is a full
 * rebuild. A stale entry is never served, and the cache is never an
 * authority: anything unexpected in it is a miss.
 */

export const GRAPH_CACHE_FORMAT = 1;

/**
 * The installed version of a package, found by walking up from its resolved
 * entry point (packages need not export package.json). Throws when it cannot
 * be determined: an unknown version must disable the cache, not reuse it.
 */
function installedVersion(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.resolve(name)));
  while (dir !== dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; version?: string };
      if (pkg.name === name && typeof pkg.version === "string") return pkg.version;
    }
    dir = dirname(dir);
  }
  throw new Error(`cannot determine the installed version of ${name}`);
}

/** Versions that change what the graph means. */
export function toolVersions(): { readonly dependencyCruiser: string; readonly typescript: string } {
  return { dependencyCruiser: installedVersion("dependency-cruiser"), typescript: installedVersion("typescript") };
}

export interface CacheKeyParts {
  readonly engineVersion: string;
  /** Repo path of the tsconfig used for resolution, or null. */
  readonly tsconfig: string | null;
  /** Every scanned path, any kind or status: adding or removing a file can change resolution. */
  readonly paths: readonly string[];
  /** sha256 of every file that steers resolution: tsconfigs, package.json files, .engintel config. */
  readonly configHashes: Readonly<Record<string, string>>;
  /** sha256 of lockfiles and install-state files (node_modules/.modules.yaml, ...), or null when absent. */
  readonly installHashes: Readonly<Record<string, string | null>>;
  /** The files handed to the graph adapter. */
  readonly analyzed: readonly string[];
}

const sortedObject = <T>(o: Readonly<Record<string, T>>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export function graphCacheKey(parts: CacheKeyParts): string {
  const canonical = JSON.stringify({
    format: GRAPH_CACHE_FORMAT,
    graphSchema: GRAPH_SCHEMA_VERSION,
    engineVersion: parts.engineVersion,
    tools: toolVersions(),
    tsconfig: parts.tsconfig,
    paths: [...parts.paths].sort(),
    configHashes: sortedObject(parts.configHashes),
    installHashes: sortedObject(parts.installHashes),
    analyzed: [...parts.analyzed].sort(),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface CachedFile {
  readonly sha256: string;
  readonly edges: readonly GraphEdge[];
  /** Kinds of the nodes this file's edges point to. */
  readonly targets: readonly GraphNode[];
}

export interface GraphCache {
  readonly format: typeof GRAPH_CACHE_FORMAT;
  readonly key: string;
  readonly files: Readonly<Record<string, CachedFile>>;
}

const NODE_KINDS: readonly NodeKind[] = ["module", "external", "core", "unresolved"];
const isString = (v: unknown): v is string => typeof v === "string";
const isHex = (v: unknown): v is string => isString(v) && /^[0-9a-f]{64}$/.test(v);

function isEdge(v: unknown, from: string): v is GraphEdge {
  const e = v as Record<string, unknown>;
  return (
    typeof v === "object" &&
    v !== null &&
    e["from"] === from &&
    isString(e["to"]) &&
    isString(e["specifier"]) &&
    (EDGE_KINDS as readonly unknown[]).includes(e["kind"]) &&
    typeof e["isTypeOnly"] === "boolean" &&
    typeof e["isDynamic"] === "boolean" &&
    typeof e["isReExport"] === "boolean" &&
    Object.keys(e).length === 7
  );
}

function isNode(v: unknown): v is GraphNode {
  const n = v as Record<string, unknown>;
  return typeof v === "object" && v !== null && isString(n["id"]) && (NODE_KINDS as readonly unknown[]).includes(n["kind"]) && Object.keys(n).length === 2;
}

/** Parse cache file content. Anything malformed is null (a miss), never an error. */
export function parseGraphCache(text: string): GraphCache | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const c = raw as Record<string, unknown>;
  if (typeof raw !== "object" || raw === null || c["format"] !== GRAPH_CACHE_FORMAT || !isHex(c["key"])) return null;
  const files = c["files"];
  if (typeof files !== "object" || files === null || Array.isArray(files)) return null;
  for (const [path, entry] of Object.entries(files as Record<string, unknown>)) {
    const f = entry as Record<string, unknown>;
    if (typeof entry !== "object" || entry === null || !isHex(f["sha256"])) return null;
    if (!Array.isArray(f["edges"]) || !f["edges"].every((e) => isEdge(e, path))) return null;
    if (!Array.isArray(f["targets"]) || !f["targets"].every(isNode)) return null;
  }
  return raw as GraphCache;
}

export interface ReusePlan {
  /** Files whose cached edges are still valid. */
  readonly reused: ReadonlyMap<string, CachedFile>;
  /** Files that must be cruised. */
  readonly toCruise: readonly string[];
  readonly status: "hit" | "partial" | "miss";
}

/** Decide which files can keep their cached edges. A different key reuses nothing. */
export function planReuse(cache: GraphCache | null, key: string, files: ReadonlyMap<string, string>): ReusePlan {
  const reused = new Map<string, CachedFile>();
  const toCruise: string[] = [];
  const valid = cache !== null && cache.key === key;
  for (const [path, sha] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const entry = valid ? cache.files[path] : undefined;
    if (entry && entry.sha256 === sha) reused.set(path, entry);
    else toCruise.push(path);
  }
  const status = !valid || reused.size === 0 ? "miss" : toCruise.length === 0 ? "hit" : "partial";
  return { reused, toCruise, status };
}

/**
 * Combine reused entries with a fresh graph of the re-cruised files into the
 * graph a full cruise would have produced: every analyzed file is a module
 * node, and each edge target keeps its kind (a module wins over other kinds).
 */
export function mergeGraph(analyzed: readonly string[], reused: ReadonlyMap<string, CachedFile>, fresh: ModuleGraph): ModuleGraph {
  const nodes = new Map<string, NodeKind>();
  const edges: GraphEdge[] = [];
  const addNode = (node: GraphNode) => {
    if (!nodes.has(node.id) || node.kind === "module") nodes.set(node.id, node.kind);
  };
  for (const node of fresh.nodes) addNode(node);
  edges.push(...fresh.edges);
  for (const entry of reused.values()) {
    for (const node of entry.targets) addNode(node);
    edges.push(...entry.edges);
  }
  for (const path of analyzed) if (nodes.has(path) || reused.has(path)) nodes.set(path, "module");
  const unique = new Map(edges.map((e) => [`${e.from}\0${e.to}\0${e.kind}\0${e.specifier}`, e]));
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    nodes: [...nodes].map(([id, kind]) => ({ id, kind })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    edges: [...unique.values()].sort(compareEdges),
  };
}

/** The cache to store after a run: one entry per analyzed file. */
export function cacheFromGraph(key: string, files: ReadonlyMap<string, string>, graph: ModuleGraph): GraphCache {
  const kinds = new Map(graph.nodes.map((n) => [n.id, n.kind]));
  const byFile = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    let list = byFile.get(edge.from);
    if (!list) byFile.set(edge.from, (list = []));
    list.push(edge);
  }
  const entries: Record<string, CachedFile> = {};
  for (const [path, sha256] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const own = byFile.get(path) ?? [];
    const targets = [...new Set(own.map((e) => e.to))].sort().map((id) => ({ id, kind: kinds.get(id) ?? ("unresolved" as NodeKind) }));
    entries[path] = { sha256, edges: own, targets };
  }
  return { format: GRAPH_CACHE_FORMAT, key, files: entries };
}
