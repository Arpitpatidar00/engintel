// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BASELINE_PATH, CONFIG_PATH, CONTRACT_PATH, RepoPathError, loadConfig, loadContract, normalizeRepoPath, type LoadedConfig, type LoadedContract } from "@engintel/config";
import { findCycles, serializeGraph, type CruiseFn, type ModuleGraph } from "@engintel/graph";
import { IDENTITY_VERSION, LayerIndex, evaluate, withDiagnostics, type FileFacts, type Scope, type SourceFileState } from "@engintel/policy";
import { changedFilesSince, mergeBase, resolveCommit, scanRepository, showFileAt, type ScanResult, type ScannedFile } from "@engintel/scanner";
import { extractSymbols, parseSourceFiles, type ParsedFile } from "@engintel/symbols";
import { applyBaselineContext, loadBaselineContext } from "./baseline.js";
import { GRAPH_CACHE_FILE, buildGraphWithCache, type GraphCacheInfo } from "./graph-cache.js";
import { IGNORE_PATH, detectPolicyChanges, type PolicyBase } from "./policy-change.js";
import { ToolError, toToolError } from "./errors.js";
import { REPORT_SCHEMA_VERSION, type AnalysisReport, type ContractSummary, type ValidationReport } from "./report.js";

/**
 * The analysis pipeline shared by the CLI, and later the Action and the MCP
 * server (research doc 03): config -> contract -> scan -> parse -> graph ->
 * evaluate -> report. Every failure becomes a ToolError (exit 2); nothing
 * degrades into an empty, passing result.
 */

export const ENGINE_VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

export const GRAPH_CACHE_PATH = ".engintel/cache/graph.json";
export const SYMBOLS_CACHE_PATH = ".engintel/cache/symbols.json";

export interface PipelineOptions {
  /** Repository root. */
  readonly root: string;
  /** Test seam for the dependency-cruiser call. */
  readonly cruiseImpl?: CruiseFn;
  /** Force a listing strategy (tests). Default "auto". */
  readonly listing?: "auto" | "git" | "walk";
  /** Reuse and update .engintel/cache/graph-cache.json. Default true. */
  readonly graphCache?: boolean;
  /** Diagnostic log lines (cache statistics). Never part of a report. */
  readonly log?: (line: string) => void;
}

export interface ValidateOptions extends PipelineOptions {
  /** An explicit scope (tests, golden scenarios). Mutually exclusive with `changedSince`. */
  readonly scope?: Scope;
  /**
   * Validate only what changed since the merge base of HEAD and this git ref
   * (ENG-010): committed, uncommitted, and untracked changes.
   */
  readonly changedSince?: string;
  /** UTC date YYYY-MM-DD used for exception expiry. */
  readonly now: string;
  /**
   * Evaluate a draft contract as a preview instead of refusing it. For tests
   * and tooling only: the CLI never sets it, so a draft is never enforced.
   */
  readonly allowDraft?: boolean;
  /**
   * The policy files as they were at the merge base (raw text, null when
   * absent). Filled from git for `changedSince`; tests and scenarios pass it
   * directly. Its presence switches baseline comparison to merge-base rules.
   */
  readonly base?: PolicyBase;
  /** Owners approved this change (the Action maps pull request labels to these). */
  readonly approvals?: { readonly policyChange?: boolean; readonly baselineChange?: boolean };
}

export interface AnalyzeOptions extends PipelineOptions {
  /** Write .engintel/cache/graph.json. Default true. */
  readonly writeCache?: boolean;
}

export interface Analysis {
  readonly config: LoadedConfig;
  readonly scan: ScanResult;
  readonly graph: ModuleGraph;
  readonly files: SourceFileState[];
  readonly facts: Map<string, FileFacts>;
  readonly graphCache: GraphCacheInfo;
}

const DETAIL: Record<string, (file: ScannedFile, config: LoadedConfig) => string> = {
  permission: () => "The file cannot be read: permission denied.",
  "io-error": () => "The file cannot be read: I/O error.",
  "too-large": (_, config) => `The file is larger than the ${config.config.limits.maxFileBytes}-byte limit.`,
  binary: () => "The file contains NUL bytes, so it is not source text.",
  "invalid-utf8": () => "The file is not valid UTF-8.",
  symlink: () => "The file is a symbolic link. EngIntel does not follow links, which could point outside the repository.",
  "unportable-path": () => "The path contains characters that are not portable across operating systems.",
};

function syntaxDetail(parsed: ParsedFile): string {
  const first = parsed.syntaxErrors[0];
  if (!first) return "";
  const n = parsed.syntaxErrors.length;
  // Code and position only: compiler messages can quote source tokens.
  return `First syntax error: TS${first.code} at line ${first.line}, column ${first.column} (${n} syntax error${n === 1 ? "" : "s"}).`;
}

function summarize(loaded: LoadedContract): ContractSummary {
  return { file: loaded.file, status: loaded.contract.status, policyVersion: loaded.contract.policyVersion, contractHash: loaded.contractHash };
}

export async function analyzeTree(options: PipelineOptions): Promise<Analysis> {
  const root = resolve(options.root);
  const config = loadConfig(root);
  const { include, exclude, tsconfig, limits } = config.config;
  const scan = scanRepository(root, {
    ...(include ? { include } : {}),
    exclude,
    maxFiles: limits.maxFiles,
    maxTotalBytes: limits.maxTotalBytes,
    maxFileBytes: limits.maxFileBytes,
    listing: options.listing ?? "auto",
  });
  const sources = scan.files.filter((f) => f.kind === "source");
  let parsed: ParsedFile[];
  try {
    parsed = parseSourceFiles(
      root,
      sources.filter((f) => f.status === "ok").map((f) => f.path),
    );
  } catch (error) {
    throw new ToolError("E_PARSE_FAILED", `source files changed or vanished during analysis: ${(error as Error).message}`, { cause: error });
  }
  const byPath = new Map(parsed.map((p) => [p.path, p]));
  const analyzable = parsed.filter((p) => p.syntaxErrors.length === 0);

  const { graph, cache: graphCache } = await buildGraphWithCache({
    root,
    scan,
    analyzed: analyzable.map((p) => p.path),
    engineVersion: ENGINE_VERSION,
    useCache: options.graphCache ?? true,
    graph: {
      ...(tsconfig ? { tsconfig } : {}),
      timeoutMs: limits.graphTimeoutMs,
      ...(options.cruiseImpl ? { cruiseImpl: options.cruiseImpl } : {}),
    },
    writeCache: (content) => writeInsideEngintel(root, GRAPH_CACHE_FILE, content),
  });
  options.log?.(`graph cache: ${graphCache.status} (${graphCache.reused} files reused, ${graphCache.cruised} analyzed)`);

  const files: SourceFileState[] = sources
    .filter((f) => f.status === "ok" || f.status === "unreadable")
    .map((f) => {
      if (f.status === "unreadable") {
        const reason = f.reason ?? "io-error";
        return { path: f.path, unanalyzable: { reason, detail: (DETAIL[reason] ?? DETAIL["io-error"])?.(f, config) ?? "" } };
      }
      const p = byPath.get(f.path);
      return p && p.syntaxErrors.length > 0
        ? { path: f.path, unanalyzable: { reason: "syntax-error", detail: syntaxDetail(p) } }
        : { path: f.path, unanalyzable: null };
    });
  const facts = new Map<string, FileFacts>(analyzable.map((p) => [p.path, { imports: p.imports, exports: p.exports }]));
  return { config, scan, graph, files, facts, graphCache };
}

/** Canonical form of a changed path; an unportable path keeps its POSIX spelling, as the scanner reports it. */
function changedPath(path: string): string {
  try {
    return normalizeRepoPath(path);
  } catch (error) {
    if (error instanceof RepoPathError && error.code === "E_PATH_UNPORTABLE") return path.replaceAll("\\", "/");
    throw error;
  }
}

function normalizeScope(scope: Scope | undefined): Scope {
  if (!scope || scope.mode === "full") return { mode: "full" };
  const changedFiles = [...new Set(scope.changedFiles.map(changedPath))].sort();
  return { mode: "changed", changedFiles, contractChanged: scope.contractChanged };
}

export interface GitScope {
  readonly scope: Scope;
  readonly git: { readonly base: string; readonly baseCommit: string; readonly mergeBase: string };
}

/** Scope from git: everything that differs from the merge base of HEAD and `base`. */
export function changedScopeFromGit(rootInput: string, base: string): GitScope {
  const root = resolve(rootInput);
  const baseCommit = resolveCommit(root, base);
  const fork = mergeBase(root, base);
  const { changed } = changedFilesSince(root, fork);
  return {
    scope: normalizeScope({ mode: "changed", changedFiles: changed, contractChanged: changed.includes(CONTRACT_PATH) }),
    git: { base, baseCommit, mergeBase: fork },
  };
}

/** `engintel validate`: judge the repository against its active contract. */
export async function validateRepository(options: ValidateOptions): Promise<ValidationReport> {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.now) || Number.isNaN(Date.parse(options.now))) {
      throw new ToolError("E_USAGE", `now must be a UTC date (YYYY-MM-DD), got "${options.now}"`);
    }
    const root = resolve(options.root);
    if (options.scope && options.changedSince !== undefined) throw new ToolError("E_USAGE", "pass either a scope or changedSince, not both");
    const fromGit = options.changedSince === undefined ? null : changedScopeFromGit(root, options.changedSince);
    const scope = fromGit ? fromGit.scope : normalizeScope(options.scope);
    const loaded = loadContract(root);
    if (loaded.contract.status !== "active" && !options.allowDraft) {
      throw new ToolError(
        "E_CONTRACT_DRAFT",
        `${loaded.file} has status "draft". Draft contracts are never enforced: review the layers, set status to "active", and commit.`,
        { file: loaded.file },
      );
    }
    if (options.base && fromGit) throw new ToolError("E_USAGE", "base is read from git when changedSince is set");
    const at = (path: string) => (fromGit ? showFileAt(root, fromGit.git.mergeBase, path) : null);
    const base: PolicyBase | undefined =
      options.base ??
      (fromGit ? { contract: at(CONTRACT_PATH), baseline: at(BASELINE_PATH), config: at(CONFIG_PATH), ignore: at(IGNORE_PATH) } : undefined);
    const baselineContext = loadBaselineContext(root, base, fromGit ? showFileAt(root, fromGit.git.baseCommit, BASELINE_PATH) : undefined);
    const { config, scan, graph, files, facts } = await analyzeTree(options);
    const evaluated = evaluate({ contract: loaded.contract, graph, files, facts, scope, now: options.now });
    const baselined = applyBaselineContext(evaluated, baselineContext, {
      scope,
      baselineChangeApproved: options.approvals?.baselineChange ?? false,
    });
    const section = baselined.section;
    const policyChange = base
      ? detectPolicyChanges({
          root,
          base,
          head: { contract: loaded.contract, config: config.config },
          baselines: baselineContext,
          fullFindings: () =>
            scope.mode === "full" ? evaluated.findings : evaluate({ contract: loaded.contract, graph, files, facts, scope: { mode: "full" }, now: options.now }).findings,
          approvals: { policyChange: options.approvals?.policyChange ?? false, baselineChange: options.approvals?.baselineChange ?? false },
        })
      : null;
    const result = policyChange ? withDiagnostics(baselined.result, policyChange.violations) : baselined.result;
    const baselineNotices =
      section?.comparedWith === "working-copy"
        ? [`Compared with the working copy of ${section.file}. With --changed, CI compares with the baseline at the merge base.`]
        : [];
    if (section?.stale && section.stale.length > 0) {
      baselineNotices.push(`${section.stale.length} baseline ${section.stale.length === 1 ? "entry no longer occurs" : "entries no longer occur"}; a human can remove them with engintel baseline prune.`);
    }
    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      command: "validate",
      engineVersion: ENGINE_VERSION,
      identityVersion: IDENTITY_VERSION,
      outcome: result.outcome,
      exitCode: result.outcome === "fail" ? 1 : 0,
      now: options.now,
      scope,
      git: fromGit ? fromGit.git : null,
      contract: summarize(loaded),
      repository: { treeHash: scan.treeHash },
      counts: result.counts,
      baseline: section,
      policyChange: policyChange ? { items: policyChange.items } : null,
      diagnostics: result.diagnostics,
      exceptionsApplied: result.exceptionsApplied,
      unanalyzable: result.unanalyzable,
      stats: result.stats,
      notices: [...config.notices, ...loaded.warnings.map((w) => `${loaded.file} ${w.path}: ${w.message}`), ...baselineNotices],
    };
  } catch (error) {
    throw toToolError(error);
  }
}

/** `engintel analyze`: build the graph, summarize it, and cache it in .engintel/cache/. Enforces nothing. */
export async function analyzeRepository(options: AnalyzeOptions): Promise<AnalysisReport> {
  try {
    const root = resolve(options.root);
    let loaded: LoadedContract | null = null;
    try {
      loaded = loadContract(root);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "E_CONTRACT_MISSING")) throw error;
    }
    const { config, scan, graph, files, graphCache } = await analyzeTree({ ...options, graphCache: options.graphCache ?? options.writeCache ?? true });
    const analyzable = files.filter((f) => f.unanalyzable === null).map((f) => f.path);
    const tsconfig = config.config.tsconfig;
    const symbols = extractSymbols(root, analyzable, tsconfig ? { tsconfig } : {});
    const writeCache = options.writeCache ?? true;
    if (writeCache) {
      writeInsideEngintel(root, GRAPH_CACHE_PATH, serializeGraph(graph));
      writeInsideEngintel(root, SYMBOLS_CACHE_PATH, `${JSON.stringify({ schemaVersion: 1, ...symbols }, null, 2)}\n`);
    }

    const index = loaded ? new LayerIndex(loaded.contract) : null;
    const count = (kind: string) => graph.nodes.filter((n) => n.kind === kind).length;
    const sources = scan.files.filter((f) => f.kind === "source");
    const status = (s: ScannedFile["status"]) => sources.filter((f) => f.status === s).length;
    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      command: "analyze",
      engineVersion: ENGINE_VERSION,
      outcome: "ok",
      exitCode: 0,
      contract: loaded ? summarize(loaded) : null,
      repository: {
        treeHash: scan.treeHash,
        files: {
          total: scan.files.length,
          source: sources.length,
          ok: status("ok"),
          unreadable: status("unreadable"),
          ignored: status("ignored"),
          other: scan.files.length - sources.length,
        },
      },
      graph: {
        file: writeCache ? GRAPH_CACHE_PATH : null,
        modules: count("module"),
        external: count("external"),
        core: count("core"),
        unresolved: count("unresolved"),
        edges: graph.edges.length,
        cycles: findCycles(graph).length,
        cache: graphCache,
      },
      symbols: {
        file: writeCache ? SYMBOLS_CACHE_PATH : null,
        exported: symbols.symbols.length,
        projects: symbols.projects.map((p) => ({ configFile: p.configFile, files: p.files })),
      },
      layers: loaded && index ? loaded.contract.layers.map((l) => ({ id: l.id, files: analyzable.filter((p) => index.layerOf(p) === l.id).length })) : [],
      unlayered: index ? analyzable.filter((p) => index.layersOf(p).length === 0).length : 0,
      unanalyzable: files.flatMap((f) => (f.unanalyzable ? [{ path: f.path, reason: f.unanalyzable.reason }] : [])),
      notices: [...config.notices, ...(loaded ? [] : ["No .engintel/architecture.json yet: analyze ran without a contract, so no layers are reported."])],
    };
  } catch (error) {
    throw toToolError(error);
  }
}

/**
 * Every write EngIntel makes goes through here: only below `.engintel/`, never
 * through a symlink (which could redirect the write outside the repository),
 * and atomically (temp file + rename).
 */
export function writeInsideEngintel(root: string, repoPath: string, content: string): void {
  const canonical = normalizeRepoPath(repoPath);
  if (!canonical.startsWith(".engintel/")) throw new ToolError("E_WRITE_OUTSIDE_ENGINTEL", `refusing to write ${repoPath}: EngIntel only writes inside .engintel/`);
  const segments = canonical.split("/");
  let dir = resolve(root);
  for (const segment of segments.slice(0, -1)) {
    dir = join(dir, segment);
    try {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new ToolError("E_WRITE_UNSAFE", `refusing to write ${repoPath}: ${dir} is not a real directory`);
      }
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(dir);
    }
  }
  const target = join(dir, segments[segments.length - 1] as string);
  try {
    if (lstatSync(target).isSymbolicLink()) throw new ToolError("E_WRITE_UNSAFE", `refusing to write ${repoPath}: it is a symlink`);
  } catch (error) {
    if (error instanceof ToolError) throw error;
  }
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, content, { flag: "wx" });
  renameSync(temp, target);
}
