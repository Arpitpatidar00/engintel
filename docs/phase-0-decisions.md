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

## Paths (ENG-027)

- **Canonical repo paths exclude `:`.** On Windows it is a drive or
  alternate-data-stream separator (doc 04 already rejects ADS paths), and in the
  graph it separates node-id namespaces (`external:`, `core:`, `unresolved:`). A
  file with `:` in its name is unportable and will be reported as unanalyzable.
- Paths are also NFC-normalized (doc 19), so macOS and Linux checkouts produce
  the same violation identities.

## Diagnostic (ENG-002)

- Docs 01 (FR-007), 13, and 27 each define a different Diagnostic. The schema
  follows **FR-007**: every diagnostic answers what, why, where, which rule,
  which edge, and the permitted alternative. `suggest` is required and says
  `kind: "none"` explicitly when there is no legal route.
- The adapter field is `adapter` (FR-007), not `source` (doc 13).
- `identity` is always a sha256 hex digest. Adapters without a natural identity
  hash their fingerprint.
- Only `severity: "error"` may block. The schema is strict, so `snippet`,
  `sourceText`, and similar fields are rejected rather than dropped.

## Architecture contract (ENG-023)

- **Doc 06 is the base**, plus `status` (`draft` | `active`, required),
  `opaqueImports` (`error` | `warn`, default `error`), and `unsupportedPaths`
  (owned, reasoned allowlist entries).
- **JSON Schema 2020-12, generated from Zod.** ENG-023 says draft-07 with a Zod
  mirror; doc 06 says 2020-12 with Zod as the source. Doc 06 wins: it is the
  normative contract document, and generating the file removes a second source
  of truth. `schema/*.json` is drift-tested and CODEOWNERS-protected.
- Globs may not start with `!` (use `excludeGlobs`) and may not contain
  backslashes (escape with character classes, e.g. `app/[(]marketing[)]/**`).
- An exclusive `allowed` rule must start from a single `{ layer }`, and each
  layer may have at most one. The complement semantics in doc 06 are otherwise
  ambiguous.
- Rule and layer ids are lowercase kebab-case with no dots, so the `engintel.*`
  namespace stays reserved for built-in rules.
- Not yet enforced (Phase 1 loader): micromatch syntax validation, the 180-day
  exception lifetime warning, and overlapping-layer detection (which needs the
  file list).

## Trust model (ENG-024)

- **MCP results carry no approval field of any value.** Doc 12 sketched
  `approved: false`; ENG-024 and the Phase 0 brief say the type must be impossible
  to construct with `approved` or `mayMerge`. Results instead carry
  `mergeAuthority: "github-required-check"` (doc 03).

## Golden fixtures (ENG-025)

- Doc 24 says Phase 0 only designs the goldens. They are populated now so that
  `treeHash` protects real inputs and Phase 1 inherits concrete test cases.
  `expected.json` stays `{}`.
- No `baseline.json` yet: the identity function is not settled (see below).
- Four conflicts between research documents must be resolved before
  `expected.json` is filled. They are listed in `tests/golden/GOLDEN.md` under
  *Open questions*: unanalyzable exit code (1 or 2), unanalyzable rule id,
  policy-weakening rule id, and the identity separator (`\0`, `\n`, or
  `\u001f`).

## CI (ENG-026)

- Actions are pinned to commit SHAs. Turbo telemetry is disabled in CI.
- `.github/CODEOWNERS` names `@engintel/architecture-owners`, a placeholder.
  Replace it before enabling required code-owner review.
