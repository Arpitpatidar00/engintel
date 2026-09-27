// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { RepoPathError, normalizeRepoPath, type EdgeKind } from "@engintel/config";
import { compareEdges, GRAPH_SCHEMA_VERSION, type GraphEdge, type GraphNode, type ModuleGraph, type NodeKind } from "./model.js";

/**
 * The dependency-cruiser adapter (D-001, research doc 05). Cruiser owns module
 * resolution; this file owns turning its JSON into a ModuleGraph and failing
 * closed when it cannot.
 *
 * The adapter never loads a repository's .dependency-cruiser.js, webpack, or
 * babel config: those are code, and repository content is untrusted. All
 * options are built here, in memory.
 */

export type GraphErrorCode = "E_GRAPH_FAILED" | "E_GRAPH_TIMEOUT" | "E_GRAPH_MALFORMED" | "E_TSCONFIG_INVALID";

export class GraphError extends Error {
  readonly code: GraphErrorCode;

  constructor(code: GraphErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GraphError";
    this.code = code;
  }
}

export interface BuildGraphOptions {
  /** Absolute repository root. */
  readonly root: string;
  /** Canonical repo paths of the source files to analyze. */
  readonly files: readonly string[];
  /**
   * Files that may be imported but must never be parsed: unanalyzable and
   * ignored files. Edges into them are kept; edges out of them are not read.
   */
  readonly doNotFollow?: readonly string[];
  /** Repo path of the tsconfig used for path mapping. Default: tsconfig.json when present. */
  readonly tsconfig?: string | null;
  /** Default 120 000 ms (research doc 05, section 13). */
  readonly timeoutMs?: number;
  /** Test seam: replaces the real dependency-cruiser call. */
  readonly cruiseImpl?: CruiseFn;
}

export type CruiseFn = (
  files: string[],
  cruiseOptions: Record<string, unknown>,
  resolveOptions: Record<string, unknown>,
  transpileOptions: Record<string, unknown>,
) => Promise<{ output: unknown }>;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function realCruise(...args: Parameters<CruiseFn>): Promise<{ output: unknown }> {
  const { cruise } = await import("dependency-cruiser");
  return cruise(...(args as Parameters<typeof cruise>));
}

async function loadTsConfig(absolutePath: string): Promise<unknown> {
  const { default: extractTSConfig } = await import("dependency-cruiser/config-utl/extract-ts-config");
  return extractTSConfig(absolutePath);
}

export async function buildModuleGraph(options: BuildGraphOptions): Promise<ModuleGraph> {
  // Cruiser reports resolved paths relative to baseDir after following symlinks,
  // so a symlinked root (macOS /var -> /private/var) must be resolved first.
  const root = realpathSync(resolve(options.root));
  if (options.files.length === 0) return { schemaVersion: GRAPH_SCHEMA_VERSION, nodes: [], edges: [] };

  const tsconfigPath = options.tsconfig === null ? null : (options.tsconfig ?? (existsSync(join(root, "tsconfig.json")) ? "tsconfig.json" : null));
  let tsConfig: unknown;
  if (tsconfigPath) {
    try {
      tsConfig = await loadTsConfig(join(root, ...tsconfigPath.split("/")));
    } catch (error) {
      throw new GraphError("E_TSCONFIG_INVALID", `could not read ${tsconfigPath}: ${(error as Error).message}`, { cause: error });
    }
  }

  const doNotFollow = [
    "(^|/)node_modules/",
    ...(options.doNotFollow ?? []).map((p) => `^${escapeRegex(p)}$`),
  ];
  const cruiseOptions: Record<string, unknown> = {
    baseDir: root,
    outputType: "json",
    tsPreCompilationDeps: true,
    doNotFollow: { path: doNotFollow },
    exoticRequireStrings: [],
    combinedDependencies: false,
    preserveSymlinks: false,
    cache: false,
    ...(tsconfigPath ? { tsConfig: { fileName: join(root, ...tsconfigPath.split("/")) } } : {}),
  };

  const cruise = options.cruiseImpl ?? realCruise;
  const timeoutMs = options.timeoutMs ?? 120_000;
  let timer: NodeJS.Timeout | undefined;
  let result: { output: unknown };
  try {
    result = await Promise.race([
      cruise([...options.files].sort(), cruiseOptions, {}, tsConfig === undefined ? {} : { tsConfig }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new GraphError("E_GRAPH_TIMEOUT", `dependency-cruiser did not finish within ${timeoutMs} ms`)), timeoutMs);
        timer.unref();
      }),
    ]);
  } catch (error) {
    if (error instanceof GraphError) throw error;
    throw new GraphError("E_GRAPH_FAILED", `dependency-cruiser failed: ${(error as Error).message}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }

  let output = result.output;
  if (typeof output === "string") {
    try {
      output = JSON.parse(output) as unknown;
    } catch (error) {
      throw new GraphError("E_GRAPH_MALFORMED", "dependency-cruiser returned output that is not JSON", { cause: error });
    }
  }
  return normalizeCruiseResult(output);
}

interface CruiseDependency {
  resolved: string;
  module: string;
  dependencyTypes?: string[];
  dynamic?: boolean;
  typeOnly?: boolean;
  coreModule?: boolean;
  couldNotResolve?: boolean;
}
interface CruiseModule {
  source: string;
  dependencies: CruiseDependency[];
  coreModule?: boolean;
  couldNotResolve?: boolean;
  dependencyTypes?: string[];
}

function isCruiseResult(value: unknown): value is { modules: CruiseModule[] } {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { modules?: unknown }).modules)) return false;
  return (value as { modules: unknown[] }).modules.every(
    (m) =>
      typeof m === "object" &&
      m !== null &&
      typeof (m as CruiseModule).source === "string" &&
      Array.isArray((m as CruiseModule).dependencies),
  );
}

const NPM_TYPES = new Set(["npm", "npm-dev", "npm-optional", "npm-peer", "npm-bundled", "npm-no-pkg", "npm-unknown"]);

/** "lodash/get" -> "lodash"; "@scope/pkg/sub" -> "@scope/pkg". */
export function packageName(specifier: string): string {
  const parts = specifier.replace(/^node:/, "").split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function isRelative(specifier: string): boolean {
  return specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
}

/**
 * Module specifiers come from repository source, which is untrusted. An
 * unresolved specifier is echoed into node ids and from there into
 * diagnostics, so one that does not look like a module path (whitespace,
 * control characters, prose, over-long) is replaced by a digest. Legitimate
 * specifiers pass through unchanged.
 */
const PLAUSIBLE_SPECIFIER = /^[A-Za-z0-9@._~#$%+=,!/-]{1,214}$/;

export function safeSpecifier(specifier: string): string {
  if (PLAUSIBLE_SPECIFIER.test(specifier)) return specifier;
  return `*invalid-specifier:${createHash("sha256").update(specifier, "utf8").digest("hex").slice(0, 16)}*`;
}

/** The node id for a module cruiser reports, from the importer's point of view when it is unresolved. */
function nodeFor(
  entry: { resolved: string; module?: string; coreModule?: boolean; couldNotResolve?: boolean; dependencyTypes?: string[] },
  importer: string | null,
): GraphNode {
  const spec = entry.module ?? entry.resolved;
  if (entry.coreModule) return { id: `core:${spec.replace(/^node:/, "")}`, kind: "core" };
  if (entry.couldNotResolve) {
    if (importer !== null && isRelative(spec)) {
      try {
        if (PLAUSIBLE_SPECIFIER.test(spec)) {
          return { id: `unresolved:${normalizeRepoPath(posix.join(dirname(importer), spec))}`, kind: "unresolved" };
        }
      } catch {
        // escapes the root: keep the specifier as written
      }
    }
    return { id: `unresolved:${safeSpecifier(spec)}`, kind: "unresolved" };
  }
  const resolvedPath = entry.resolved.replaceAll("\\", "/");
  const isNpm = entry.dependencyTypes?.some((t) => NPM_TYPES.has(t)) ?? false;
  if (isNpm || /(^|\/)node_modules\//.test(resolvedPath)) {
    const fromModules = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(resolvedPath)?.[1];
    return { id: `external:${fromModules ?? packageName(spec)}`, kind: "external" };
  }
  try {
    return { id: normalizeRepoPath(resolvedPath), kind: "module" };
  } catch (error) {
    if (!(error instanceof RepoPathError)) throw error;
    return { id: `external:${resolvedPath}`, kind: "external" }; // resolved outside the repository root
  }
}

function edgeKindOf(dep: CruiseDependency): { kind: EdgeKind; isTypeOnly: boolean; isDynamic: boolean; isReExport: boolean } {
  const types = new Set(dep.dependencyTypes ?? []);
  const isTypeOnly = dep.typeOnly === true || types.has("type-only") || types.has("type-import");
  const isDynamic = dep.dynamic === true || types.has("dynamic-import");
  const isReExport = types.has("export");
  let kind: EdgeKind = "import";
  if (isReExport) kind = "re-export";
  else if (isDynamic) kind = "dynamic";
  else if (types.has("require") || types.has("exotic-require") || types.has("import-equals")) kind = "require";
  else if ([...types].some((t) => t.startsWith("triple-slash"))) kind = "triple-slash";
  else if (isTypeOnly) kind = "type-only";
  return { kind, isTypeOnly, isDynamic, isReExport };
}

/**
 * Pure: dependency-cruiser JSON -> ModuleGraph. Throws GraphError on anything
 * that is not a cruise result. Cruiser merges repeated imports of one specifier
 * into a single dependency, so an edge's flags describe every use of it.
 */
export function normalizeCruiseResult(output: unknown): ModuleGraph {
  if (!isCruiseResult(output)) {
    throw new GraphError("E_GRAPH_MALFORMED", "dependency-cruiser output has no valid modules array");
  }
  const nodes = new Map<string, NodeKind>();
  const edges = new Map<string, GraphEdge>();
  for (const mod of output.modules) {
    const self = nodeFor({ ...mod, resolved: mod.source, module: mod.source }, null);
    // Cruiser also lists every dependency target as a module. Only local modules
    // own nodes and outgoing edges here; other nodes exist as edge targets, where
    // the importer is known (an unresolved "../x" is only meaningful relative to it).
    if (self.kind !== "module") continue;
    nodes.set(self.id, "module");
    for (const dep of mod.dependencies) {
      const target = nodeFor(dep, self.id);
      if (!nodes.has(target.id) || target.kind === "module") nodes.set(target.id, target.kind);
      const edge: GraphEdge = { from: self.id, to: target.id, specifier: safeSpecifier(dep.module), ...edgeKindOf(dep) };
      edges.set(`${edge.from}\0${edge.to}\0${edge.kind}\0${edge.specifier}`, edge);
    }
  }
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    nodes: [...nodes].map(([id, kind]) => ({ id, kind })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    edges: [...edges.values()].sort(compareEdges),
  };
}
