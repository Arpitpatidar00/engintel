# Phase 0 decisions

Decisions made while scaffolding Phase 0 that the research package left open, or
where two research documents disagree. `_LOCKED.md` still wins over anything here.
Each entry names the ticket that introduced it.

## Toolchain (ENG-001)

- **TypeScript is pinned to 6.0.3, not 7.x.** `typescript@latest` is 7.0.x, the
  native Go port. Its main entry exports only a version string; the compiler API
  lives under `typescript/unstable/*` and the package ships per-platform native
  binaries. D-002 depends on the JS API (`ts.createProgram` + `TypeChecker`), so
  6.0 is the last compatible line. `scripts/workspace-policy.test.mjs` fails if the
  catalog pin leaves 6.x. Revisit only with a measured plan for the 7.x API.
- **Every third-party version is an exact pin in the pnpm catalog**
  (`pnpm-workspace.yaml`). Packages reference `catalog:`.
  `dependency-cruiser@18.4.0` is pinned there now but not installed; ENG-005 adds
  it to `@engintel/graph`, the only package allowed to depend on it (enforced).
- **Node `>=22.13.0`.** vitest 5 and ESLint 10 both require 22.12/22.13+. CI runs
  Node 22 (`.nvmrc`). Node 25 is rejected by `engine-strict`; it is past end of life.
- **pnpm 10.7.1.** The newest 10.x (10.34.5) could not be fetched by the local
  Corepack because its npm signing keys are out of date. Bump `packageManager`
  after running `npm install -g corepack@latest`.
- **Install scripts never run.** `.npmrc` sets `ignore-scripts=true`; the
  workspace sets `strictDepBuilds: true` with an empty `onlyBuiltDependencies`.
- **"No native addons" applies to the shipped graph.** The dev toolchain
  (vite/rolldown, lightningcss, turbo) uses prebuilt platform binaries. That never
  reaches users. The policy test checks every production dependency for
  `binding.gyp`, `gypfile`, install hooks, `os`/`cpu` restrictions and `.node`
  files, and self-tests that the detector does flag turbo's binary. The ban list
  (Nx, ts-morph, tree-sitter, Madge, better-sqlite3, graph/vector DBs, LLM SDKs) is
  checked across the entire lockfile, for every platform.
- **Packages build to `dist/` and export only `dist/`.** Turbo runs `^build`
  before `typecheck` and `test`, so cross-package imports resolve to real output.
- **Copyright line** in every SPDX header reads "The EngIntel Authors". Change it
  in one pass if a legal entity should hold the copyright.
