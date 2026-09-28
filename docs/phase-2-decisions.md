# Phase 2 decisions

Decisions made while building the Phase 2 architecture gate, where the
research package left a choice open or two documents disagree. `_LOCKED.md`
still wins over anything here, and the Phase 0 and Phase 1 decisions still
apply. Each entry names the ticket that introduced it.

## Changed-file scope (ENG-010)

- **What counts as changed:** everything that differs between the merge base
  (`git merge-base HEAD <base>`) and the working tree: committed, uncommitted,
  and untracked (not ignored) files, deletions, and both sides of renames. CI
  checkouts are clean, so there this is exactly the pull request's diff;
  locally it also covers work in progress.
- **Deleted files bring their importers into scope.** An import of a deleted
  file becomes unresolved, and its node id no longer names the deleted path.
  The rule engine maps each changed path to the unresolved ids an import of
  it would produce (the path without its extension, and the directory for an
  `index` file).
- **Default base:** `origin/$GITHUB_BASE_REF` in GitHub Actions, otherwise
  `origin/HEAD`. `--base` implies `--changed`.
- **git runs hardened.** Hooks, `core.fsmonitor`, external diff drivers, and
  textconv are disabled on every call, and refs from the command line are
  checked before git sees them. A test proves that a repository-configured
  script, which plain git runs, never executes.
- **The git layer lives in `@engintel/scanner`**, next to the existing file
  listing, so there is one audited place where EngIntel runs git.

## Baselines (ENG-009, ENG-038)

- **Fail-closed findings can never be baselined** (ENG-009, overriding doc 07,
  which allowed baselining `engintel.unanalyzable`). Forbidden rules:
  `engintel.unanalyzable`, `engintel.opaque-import`,
  `engintel.unresolved-import`, `engintel.overlapping-layers`, and the policy
  rules. Messy files go on the contract's reviewed `unsupportedPaths` list
  instead. `baseline write` refuses to run while any of these fire.
- **Only blocking errors are baseline-eligible** (doc 08, section 5).
- **Integrity:** every entry's identity must recompute from its stored fields.
  A hand-edited entry, or a smuggled fail-closed rule, fails closed (exit 2).
- **`writtenAt`, `firstSeenAt`, and `lastSeenAt` are dates, not timestamps,**
  so writing is deterministic for a given tree, clock, and author. Rewriting
  keeps each surviving entry's `firstSeenAt`, owner, ticket, and justification.
- **Merge-base semantics** (doc 08, section 7): with `--changed` (or a
  scenario base), suppression uses the baseline at the merge base, not the
  pull request's copy. Debt the default branch baselined after the fork is
  tolerated only for findings that touch no changed file. A local run without
  `--changed` uses the working copy and says so in a notice.
- **Human guards:** `--written-by` must be a GitHub login; agent and bot
  names are refused (a seatbelt, not a boundary). `write` and `prune` are dry
  runs without `--yes` and refuse to write when `CI` is set, unless
  `ENGINTEL_ALLOW_BASELINE_WRITE=1` (BD-7). Matching `--written-by` against
  the git author (doc 08, section 15) is not implemented; CODEOWNERS review
  is the control.
- The `existing-violations` golden gained its baseline at `fixtureVersion`
  0.2.0, written by the CLI.

## Policy-change detection (ENG-012)

- **Rule ids** use the built-in namespace: `engintel.policy-weakening`
  (blocking unless approved), `engintel.policy-change` (advisory, for
  tightenings), and `engintel.baseline-drop`. FR-012 said `policy.weakening`;
  ENG-012 and doc 24 said `policy.change`.
- **Conservative classification.** A change whose effect cannot be proven
  harmless is a weakening: any edit to a rule's `from`, `to`, or `within`,
  any change to a layer's globs, and a merge-base contract that no longer
  parses.
- **Covered files:** the contract, `baseline.json`, and also `config.json`
  and `ignore`. Excluding or ignoring files hides them from analysis just as
  well as deleting a rule does. Other files in `.engintel/` are left to
  CODEOWNERS review.
- **Approval** is two flags, `--policy-change-approved` and
  `--baseline-change-approved`, which the Action sets from the
  `policy-change` and `baseline-change` labels. An approved weakening is
  still reported, as a warning. Dropping a baseline entry whose violation
  still exists is never approvable.
- **The weakened contract is the one enforced** (the golden
  `policy-change`): the pull request fails on the weakening itself.

## SARIF and reports (ENG-039)

- SARIF 2.1.0 with relative `%SRCROOT%` URIs (segments percent-encoded), and
  the EngIntel identity as partial fingerprint (`engintelIdentity/v1`), so
  code-scanning alerts track exactly like baseline entries. Findings without
  a file are anchored to the contract, because code scanning needs a
  location.
- The official SARIF schema was used to validate output during development
  but is not vendored, because its redistribution terms are unclear. Tests
  pin the properties GitHub relies on; types come from `@types/sarif` (MIT).
- `engintel report <saved.json>` renders a saved report in any format, so
  the Action analyzes once and emits human, Markdown, and SARIF output.
- Reports gained `git`, `baseline`, `policyChange`, and
  `counts.suppressedByBaseline`. They still contain no timestamps, cache
  state, or absolute paths.

## Graph cache (ENG-037)

- **Key:** engine version, the installed dependency-cruiser and TypeScript
  versions, the tsconfig in use, every scanned path, the hash of every
  config-kind file (tsconfigs, `package.json` files, `.engintel/*.json`),
  lockfiles, and install-state files (`node_modules/.modules.yaml` and the
  like). Same key: unchanged files keep their edges. Any other key: full
  rebuild. If a tool version cannot be determined, caching is off.
- **Never trusted into a pass.** A malformed cache is a miss. A cache tracked
  by git is refused outright, because a pull request could otherwise commit
  forged edges that hide its own violations.
- `validate` now writes `.engintel/cache/graph-cache.json` (still only inside
  `.engintel/`); `--no-cache` restores the Phase 1 "writes nothing" behaviour.
  Cache statistics go to stderr with `--verbose` and to the `analyze` report,
  never to the `validate` report, which stays byte-identical.

## GitHub Action (ENG-011, ENG-040)

- **Distribution:** a composite action at `packages/action`, used as
  `Arpitpatidar00/engintel/packages/action@<sha>`. It builds EngIntel from its
  own checkout (cached). Publishing to npm and a separate
  `engintel/validate@v1` repository are later decisions.
- **All logic is in `scripts/run.sh` and `scripts/cache-keys.mjs`,** so it
  runs in tests under a simulated GitHub Actions environment. Nothing was run
  against live GitHub (doc 24 allows a recorded fixture).
- The SARIF upload is left to the user's workflow (it needs
  `security-events: write` and code scanning availability); the action only
  produces the file.
- `pull_request_target` is refused by the action and banned from this
  repository's workflows.
- A nightly job runs the path and identity tests on `windows-latest`
  (Phase 2 acceptance). It has not run yet; the first scheduled run is its
  first test.

## Not done in Phase 2

- **Dogfood exit criterion** ("EngIntel enables the Action as a required
  check on main"): EngIntel's own contract is still `draft`, so the check
  would refuse every pull request with exit 2. Setting it `active`, adding
  the workflow, and creating the ruleset are the owners' decisions.
- `engintel drift`, `baseline add --identity`, and `baseline rehash` (doc 08)
  are not implemented.
