# Phase 1 decisions

Decisions made while building the Phase 1 analysis MVP, where the research
package left a choice open or two documents disagree. `_LOCKED.md` still wins
over anything here, and `docs/phase-0-decisions.md` still applies. Each entry
names the ticket that introduced it.

## Exit codes and fail-closed (ENG-008, ENG-006, D-009)

- **Three exit codes: 0 pass, 1 blocking violations, 2 no verdict.** Doc 17
  proposed a separate 3 for invalid configuration. The Phase 1 brief and ENG-006
  both say a missing or invalid contract exits 2, so 2 covers every run that
  could not produce a trustworthy verdict: tool errors, config and contract
  errors, a draft contract, and usage errors.
- **Unanalyzable files are violations (exit 1), not tool errors (exit 2).** This
  follows FR-020 and doc 07 over docs 23 and 30. A file EngIntel cannot read or
  parse is reported as `engintel.unanalyzable`, blocking, unless a reviewed
  `unsupportedPaths` entry covers it. A crash, timeout, or malformed output
  from dependency-cruiser is a tool error (exit 2) and never an empty graph.
- **A draft contract is refused, not enforced and not passed** (doc 30: "draft
  refuses validate"). `analyze` works with a draft or with no contract at all.

## Built-in rules (ENG-007, ENG-032)

All built-in rule ids start with `engintel.`. Contract ids cannot contain dots,
so no contract rule or exception can collide with or waive a built-in rule.

| Rule | Severity | When |
| --- | --- | --- |
| `engintel.unanalyzable` | error | An in-scope source file is unreadable (binary, invalid UTF-8, too large, permission, symlink, unportable path) or has syntax errors |
| `engintel.opaque-import` | `opaqueImports` | A non-literal `import()` or `require()` |
| `engintel.unresolved-import` | `opaqueImports` | An unresolved specifier that no contract rule already reported and `externals.allowUnresolved` does not list |
| `engintel.overlapping-layers` | error | A file matches more than one layer |
| `engintel.intra-layer` | error | Two files in a layer with `intraAllowed: false` and no exclusive allowed rule |
| `engintel.unlayered` | `unlayered.severity`, default advisory | A file in no layer |

- Non-exclusive `allowed` rules produce no violations on their own. They extend
  an exclusive rule from the same layer and shape the allowed-layer graph used
  for suggested routes.
- Targets that are external packages, core modules, or unresolved specifiers are
  judged only by rules that name them (`external`, `unresolved`), never by
  layer rules.

## Violation identity (ENG-035)

- `sha256_hex(utf8(ruleId US source US target US cycleSignature))`, with US =
  U+001F, `identityVersion: 1`. Doc 08 (`\0`) and doc 19 (`\n`) disagreed.
  ENG-035 is the implementation ticket and fixes U+001F.
- Paths are normalized before hashing (canonical POSIX, NFC), package names are
  case-folded, and tokens (`<missing>`, `<unanalyzable>`, `<unreachable-from>`,
  `<unlayered>`, `<overlapping-layers>`, `<unportable-path>`) hash as
  themselves. Cycle signatures are never re-rotated. An empty cycle signature
  is the same as an omitted one.
- A field containing U+001F is refused, so the separator cannot be used to
  forge a collision.
- `packages/policy/testdata/identity-vectors.json` holds known-answer vectors
  computed independently (Python `hashlib`). The test freezes a digest of the
  existing vectors, so the file can only grow.

## Cycles (ENG-031)

- Every elementary cycle is its own violation: A→B→A and A→B→C→A are different
  debts (doc 08). Enumeration is Tarjan SCC plus Johnson's algorithm. Searching
  from each component's nodes in sorted order yields each cycle once, already
  in canonical rotation.
- A component with more than 2 000 nodes (doc 05) or more than 1 000 cycles is
  reported as one coarse cycle. Its signature is `{a, b, c}`, the sorted node
  set in braces, so it can never equal an exact signature.
- The violation's source is the first node of the rotation and its target is
  the last (doc 07, section 6.3).

## Graph adapter (ENG-005, ENG-030)

- **Only listed files are parsed.** Cruiser receives the explicit list of files
  the scanner listed and the parse pass accepted, with `doNotFollow: ".+"`.
  Gitignored build output, unanalyzable files, and `node_modules` appear only
  as edge targets and are never read.
- **Conditional exports resolve.** Cruiser's default resolver has no `exports`
  conditions, so every package with conditional `exports` came out unresolved,
  and failing closed turned that into false violations. The adapter resolves
  with `import`, `require`, `node`, and `default`. This was found by running
  EngIntel on itself.
- **Duplicate imports collapse.** Cruiser keeps one dependency per specifier
  and import kind. A later `import("./x")` after a static import of `./x` is
  merged into the static edge. Type-only and value imports of the same module
  stay separate, so `ignoreTypeOnly` cannot hide a value import.
- **Untrusted specifiers are replaced.** A specifier that does not look like a
  module path (whitespace, control characters, prose) becomes
  `*invalid-specifier:<sha256 prefix>*` before it can reach a node id or a
  diagnostic.
- **Package names use the last `node_modules` segment,** so pnpm's
  `.pnpm/<pkg>@<ver>/node_modules/<pkg>` layout names the real package.
- **tsconfig path mapping needs `baseUrl`.** Cruiser applies `paths` only
  with `baseUrl`, which TypeScript 6 deprecates. A tsconfig used for path
  mapping must set `"ignoreDeprecations": "6.0"` (see `.engintel/tsconfig.json`).
  Revisit before TypeScript 7.

## Contract and config loading (ENG-006, ENG-034)

- `contractHash` is sha256 of canonical JSON (keys sorted) of the file as
  written, so formatting and key order do not change it.
- Contract and config files must be regular files. Symlinks, non-UTF-8 files,
  and files over 1 MiB are refused. JSON errors report line and column only,
  because V8's parse messages can quote file content.
- Exceptions that live longer than 180 days produce a loader warning (doc 06).
- `.engintel/config.json` is tool settings only: include/exclude, tsconfig, and
  limits. Policy knobs (`opaqueImports`, severities) stay in the
  CODEOWNERS-protected contract, so config cannot weaken enforcement. Keys and
  values that look like secrets are refused, `extends` and `overlays` are
  reserved, and `telemetry.enable` is accepted but never enables upload.

## Rule engine scope (ENG-007)

- Scope is either `full`, or `changed` with a file list. An edge is in scope
  when either end changed. A cycle is in scope when any member changed. A
  contract change re-evaluates everything (doc 07, section 6.2).
- The core implements `changed` scope so golden scenarios stay hermetic. The
  git-driven `--changed` CLI flag is Phase 2 (ENG-010). The Phase 1 CLI always
  runs full scope.
- Exceptions are active while `now <= expiresAt` (UTC dates). The CLI reads the
  clock once (`--now` overrides it), and the engine never reads it.

## Diagnostics and reports (ENG-032, ENG-033)

- Messages come from fixed templates filled with node ids, layer ids, and
  contract text only. They never contain repository source text or compiler
  message text; syntax errors are reported as `TS<code>` plus position.
- A unique shortest legal layer route becomes `use-layer`, with an example
  export from the intermediate layer. The example prefers files that already
  import the target and that sibling files in the source layer use. When
  several routes tie, the diagnostic lists them as `kind: "none"` rather than
  picking one.
- Reports contain no timestamps, durations, hostnames, or absolute paths.
  Diagnostics are sorted by file, position, rule, and identity. The same input
  gives byte-identical output, which the golden and CLI tests check by running
  every scenario twice.
- The human reporter uses color only on a TTY (and honors `NO_COLOR`) and never
  uses emoji.

## Symbols (ENG-004, ENG-029)

- `validate` uses the fast parse-only pass (syntax errors, imports, top-level
  exports). The checker-backed extraction (`ts.createProgram` + `TypeChecker`,
  project references, one program per project) runs only in `analyze`, which
  caches it in `.engintel/cache/symbols.json` for later search.
- Type strings are printed relative to the declaration and never contain an
  absolute path. JSDoc is not extracted: it is free repository text.
- `plugins` in any tsconfig are cleared, and the compiler host never writes.

## Golden fixtures (ENG-025)

- `expected.json` holds, per scenario, the full validate report minus
  `engineVersion`. The golden test pins the pass/fail table separately, so a
  regenerated `expected.json` cannot silently flip a verdict.
- `existing-violations` and `policy-change` stay `{}` until baselines (ENG-009)
  and policy-change detection (ENG-012) land in Phase 2.

## Dogfood

- `.engintel/architecture.json` describes EngIntel's own package layers and is
  `draft`, so `engintel validate` refuses it until the owners review it. The
  orchestrator's dogfood test previews it (`allowDraft`, which the CLI never
  sets). The repository currently conforms, and each rule is shown to fail on
  an injected edge.
