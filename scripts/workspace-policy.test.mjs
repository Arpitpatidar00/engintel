// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

// Workspace policy: invariants from the locked decisions that no single
// package test can see. Runs with `node --test` so it needs no dependencies.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED_PACKAGES = [
  "action",
  "cli",
  "config",
  "graph",
  "mcp",
  "obs",
  "orchestrator",
  "policy",
  "repair",
  "scanner",
  "symbols",
  "testkit",
];

// Names that must never appear anywhere in the install graph, on any platform.
const BANNED = [
  { match: /^nx$|^@nx\//, why: "D-011: Nx is a repo we analyze, not our build system" },
  { match: /^ts-morph$|^@ts-morph\//, why: "D-002: no ts-morph in MVP" },
  { match: /tree-sitter/, why: "D-002: no tree-sitter in MVP" },
  { match: /^madge$/, why: "locked: do not depend on Madge" },
  { match: /^better-sqlite3$/, why: "D-012: sql.js (WASM), never a native SQLite addon" },
  { match: /^neo4j-driver/, why: "D-004: no graph database" },
  { match: /^(pg|postgres|pgvector)$/, why: "D-004: no Postgres in MVP" },
  {
    match: /^(chromadb|vectordb|sqlite-vss|sqlite-vec|hnswlib-node|faiss-node|@pinecone-database\/.*|@qdrant\/.*|@lancedb\/.*)$/,
    why: "D-005: no vector database",
  },
  {
    match:
      /^(openai|ai|ollama|cohere-ai|langchain|@anthropic-ai\/.*|@langchain\/.*|@ai-sdk\/.*|@google\/generative-ai|@google\/genai|@mistralai\/.*)$/,
    why: "the agent is never the authority: no LLM SDKs anywhere, including CI",
  },
  {
    match: /^(onnxruntime-node|onnxruntime-web|@xenova\/transformers|@huggingface\/transformers)$/,
    why: "D-005: no embedding models",
  },
];

// Third-party packages that only one workspace package may depend on.
const SOLE_CONSUMER = {
  "dependency-cruiser": "packages/graph",
};

// Workspace edges the architecture forbids (research doc 03, section 8).
const FORBIDDEN_WORKSPACE_EDGES = [
  ["packages/action", "@engintel/mcp"],
  ["packages/mcp", "@engintel/action"],
];

const SPDX = "// SPDX-License-Identifier: Apache-2.0";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Parse the two sections of pnpm-lock.yaml (v9) this test needs. */
function parseLockfile() {
  const lines = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8").split("\n");
  const packages = new Set();
  const importers = new Map(); // importer -> Set(dependency name)
  let section = null;
  let importer = null;
  for (const line of lines) {
    const top = /^([a-zA-Z]+):/.exec(line);
    if (top) {
      section = top[1];
      continue;
    }
    if (section === "packages") {
      const m = /^ {2}'?(.+?)'?:$/.exec(line);
      if (m) {
        const key = m[1];
        const at = key.lastIndexOf("@");
        packages.add(at > 0 ? key.slice(0, at) : key);
      }
    } else if (section === "importers") {
      const imp = /^ {2}(\S.*):$/.exec(line);
      if (imp) {
        importer = imp[1];
        importers.set(importer, new Set());
        continue;
      }
      const dep = /^ {6}'?(.+?)'?:$/.exec(line);
      if (dep && importer) importers.get(importer).add(dep[1]);
    }
  }
  return { packages, importers };
}

function* walkFiles(dir, skip = new Set(["node_modules", "dist", ".turbo"])) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full, skip);
    else if (entry.isFile()) yield full;
  }
}

describe("workspace shape", () => {
  const dirs = readdirSync(join(ROOT, "packages")).filter((d) =>
    statSync(join(ROOT, "packages", d)).isDirectory(),
  );

  test("exactly the twelve Phase 0 packages exist", () => {
    assert.deepEqual([...dirs].sort(), [...EXPECTED_PACKAGES].sort());
  });

  for (const dir of EXPECTED_PACKAGES) {
    test(`packages/${dir} manifest follows the workspace contract`, () => {
      const pkg = readJson(join(ROOT, "packages", dir, "package.json"));
      assert.equal(pkg.name, `@engintel/${dir}`);
      assert.equal(pkg.license, "Apache-2.0");
      assert.equal(pkg.type, "module");
      assert.equal(pkg.private, true, "Phase 0 packages must not be publishable");
      assert.ok(pkg.engines?.node, "engines.node is required");
    });
  }

  test("root is Apache-2.0 and pins its package manager", () => {
    const pkg = readJson(join(ROOT, "package.json"));
    assert.equal(pkg.license, "Apache-2.0");
    assert.match(pkg.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
    assert.ok(readFileSync(join(ROOT, "LICENSE"), "utf8").includes("Apache License"));
  });
});

describe("license headers", () => {
  test("every source file starts with the SPDX Apache-2.0 header (after a shebang, if any)", () => {
    const roots = [
      ...EXPECTED_PACKAGES.flatMap((p) => [
        join(ROOT, "packages", p, "src"),
        join(ROOT, "packages", p, "test"),
      ]),
      join(ROOT, "scripts"),
    ];
    const missing = [];
    for (const r of roots) {
      for (const file of walkFiles(r)) {
        if (!/\.(ts|mts|cts|js|mjs|cjs)$/.test(file)) continue;
        const [first, second] = readFileSync(file, "utf8").split("\n", 2);
        const header = first?.startsWith("#!") ? second : first;
        if (header !== SPDX) missing.push(relative(ROOT, file));
      }
    }
    assert.deepEqual(missing, [], `files missing "${SPDX}" on line 1 (line 2 after a shebang)`);
  });
});

describe("dependency graph", () => {
  const { packages, importers } = parseLockfile();

  test("the lockfile was parsed", () => {
    assert.ok(packages.size > 0, "no packages found in pnpm-lock.yaml");
    assert.ok(importers.has("."), "no root importer found in pnpm-lock.yaml");
  });

  for (const { match, why } of BANNED) {
    test(`banned: ${match} (${why})`, () => {
      const hits = [...packages].filter((name) => match.test(name));
      assert.deepEqual(hits, [], why);
    });
  }

  test("TypeScript stays on 6.x (7.x has no JS compiler API; D-002)", () => {
    const yaml = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
    const pin = /^\s+typescript:\s*(\S+)/m.exec(yaml)?.[1];
    assert.match(pin ?? "", /^6\.\d+\.\d+$/);
  });

  for (const [dep, owner] of Object.entries(SOLE_CONSUMER)) {
    test(`${dep} is only depended on by ${owner}`, () => {
      const users = [...importers].filter(([, deps]) => deps.has(dep)).map(([imp]) => imp);
      assert.ok(users.every((u) => u === owner), `unexpected consumers: ${users.join(", ")}`);
    });
  }

  for (const [from, to] of FORBIDDEN_WORKSPACE_EDGES) {
    test(`${from} does not depend on ${to}`, () => {
      assert.ok(!importers.get(from)?.has(to));
    });
  }

  test("the shipped (production) graph contains no native addons", () => {
    // Dev tooling (vite/rolldown, turbo) ships prebuilt native binaries. That is
    // acceptable: it never reaches users. What we publish must be pure JS/WASM.
    const pnpm = process.env.npm_execpath ?? "pnpm";
    const runner = pnpm.endsWith(".js") || pnpm.endsWith(".cjs") ? process.execPath : pnpm;
    const args = runner === pnpm ? [] : [pnpm];
    const out = execFileSync(runner, [...args, "-r", "ls", "--prod", "--depth", "Infinity", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const offenders = [];
    const seen = new Set();
    const visit = (deps) => {
      for (const [name, info] of Object.entries(deps ?? {})) {
        if (!info.path || seen.has(info.path)) continue;
        seen.add(info.path);
        const reason = nativeIndicator(info.path);
        if (reason) offenders.push(`${name}: ${reason}`);
        visit(info.dependencies);
      }
    };
    for (const project of JSON.parse(out)) visit(project.dependencies);
    assert.deepEqual(offenders, []);
  });

  test("the native-addon detector is not vacuous (it flags dev-only tooling)", () => {
    // turbo installs exactly one prebuilt platform binary package on any
    // supported OS/arch. If the detector cannot see it, the check above is empty.
    const store = join(ROOT, "node_modules", ".pnpm");
    const platformDirs = readdirSync(store).filter((d) => d.startsWith("@turbo+"));
    assert.ok(platformDirs.length > 0, "no @turbo/<platform> package installed");
    const flagged = platformDirs.filter((d) => {
      const name = d.slice(0, d.lastIndexOf("@")).replace("+", "/");
      return nativeIndicator(join(store, d, "node_modules", name)) !== null;
    });
    assert.ok(flagged.length > 0, `detector missed ${platformDirs.join(", ")}`);
  });
});

describe("CI and ownership", () => {
  const workflowDir = join(ROOT, ".github", "workflows");
  const workflows = readdirSync(workflowDir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => ({ file: f, text: readFileSync(join(workflowDir, f), "utf8") }));

  test("at least one workflow exists", () => {
    assert.ok(workflows.length > 0);
  });

  for (const { file, text } of workflows) {
    test(`${file} uses no secrets and never pull_request_target`, () => {
      assert.ok(!/\$\{\{[^}]*\bsecrets\./.test(text), "workflows must not read secrets");
      assert.ok(!/^\s*secrets:\s*inherit/m.test(text), "workflows must not pass secrets to reusable workflows");
      assert.ok(!/pull_request_target/.test(text), "pull_request_target runs untrusted code with secrets (doc 16)");
    });

    test(`${file} defaults to read-only repository contents`, () => {
      assert.match(text, /^permissions:\s*\n\s+contents:\s*read\s*$/m);
    });

    test(`${file} pins every action to a full commit SHA`, () => {
      const unpinned = [...text.matchAll(/uses:\s*(\S+)/g)]
        .map((m) => m[1])
        .filter((ref) => !ref.startsWith("./") && !/@[0-9a-f]{40}$/.test(ref));
      assert.deepEqual(unpinned, []);
    });
  }

  test("ci.yml runs lint, typecheck, and test on pull requests", () => {
    const ci = workflows.find((w) => w.file === "ci.yml")?.text ?? "";
    assert.match(ci, /^\s+pull_request:/m);
    for (const step of ["pnpm lint", "pnpm typecheck", "pnpm test"]) assert.ok(ci.includes(step), `missing ${step}`);
  });

  test("CODEOWNERS covers the contract, policy code, and the published schemas", () => {
    const owners = readFileSync(join(ROOT, ".github", "CODEOWNERS"), "utf8")
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .map((line) => line.trim().split(/\s+/));
    for (const path of ["/.engintel/", "/packages/policy/", "/packages/config/schema/"]) {
      const entry = owners.find(([pattern]) => pattern === path);
      assert.ok(entry && entry.length > 1 && entry.slice(1).every((o) => o.startsWith("@")), `${path} needs an owner`);
    }
  });
});

/** Returns why a package directory looks native, or null if it looks pure JS/WASM. */
function nativeIndicator(dir) {
  if (existsSync(join(dir, "binding.gyp"))) return "has binding.gyp";
  const pkg = readJson(join(dir, "package.json"));
  if (pkg.gypfile) return "gypfile: true";
  for (const hook of ["preinstall", "install", "postinstall"]) {
    if (pkg.scripts?.[hook]) return `runs a ${hook} script`;
  }
  if (pkg.os || pkg.cpu) return "is platform-specific (os/cpu)";
  for (const file of walkFiles(dir)) {
    if (file.endsWith(".node")) return `ships ${relative(dir, file)}`;
  }
  return null;
}
