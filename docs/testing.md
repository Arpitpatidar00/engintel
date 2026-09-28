# Testing EngIntel

How to check that EngIntel itself works: the whole suite, one package at a
time, and by hand against the example repositories. For using EngIntel on a
project, see `docs/usage.md`.

## Setup

Run this in every new terminal:

```sh
cd path/to/engintel
nvm use 22               # or: export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
pnpm install
pnpm build
```

The tests need Node 22; vitest refuses end-of-life releases such as Node 25.

Packages import each other's built output (`dist/`). **After changing a package
that others depend on, run `pnpm build` again** before testing the packages
that use it; otherwise they test the old code. `pnpm test` does this for you.

## Everything

```sh
pnpm lint          # ESLint
pnpm typecheck     # TypeScript, every package
pnpm test          # builds, runs every package's tests, then the workspace policy checks
```

It passed if you see `Tasks: 20 successful, 20 total` and `# fail 0` at the
end. CI (`.github/workflows/ci.yml`) runs the same three commands.

To bypass Turborepo's cache and rerun everything from scratch:

```sh
rm -rf packages/*/dist
pnpm turbo run test --force
```

## One package at a time

```sh
pnpm --filter @engintel/<package> test
```

| Package | What it does | What its tests cover |
| --- | --- | --- |
| `config` | Contract and config schemas and loaders, paths, shared diagnostic type | Valid and invalid contracts, loader errors, secret rejection, schema drift |
| `scanner` | Lists repository files and marks the unreadable ones; the only place git runs | git and walk listings agree, binary, too-large, symlink, permission, `.gitignore`; changed files, merge base, hostile refs, repository config that must not run |
| `symbols` | TypeScript parsing, tsconfig projects, exported symbols | Syntax errors, opaque imports, project references, symbol kinds |
| `graph` | Import graph via dependency-cruiser, cycles, incremental reuse | Type-only, dynamic, and unresolved edges; packages; crash and timeout; cycle signatures; cache keys and partial reuse |
| `policy` | Rule engine, messages, suggested routes, identity hash, baselines, policy changes | Every rule kind, exceptions, scope, fail-closed, identity vectors, baseline integrity, pairwise policy diffs |
| `orchestrator` | The full pipeline used by the CLI | Golden fixtures, exit-2 errors, write safety, `--changed` on real git repos, baselines, policy-change attacks, graph cache, EngIntel's own contract |
| `cli` | The `engintel` command | Exit codes end to end, reporters (human, JSON, SARIF, Markdown), `baseline` and `report` commands, usage errors |
| `action` | The GitHub Action | `action.yml` and the example workflow checked structurally; `run.sh` run under a simulated GitHub Actions environment; cache keys |
| `testkit` | Golden fixture loading and hashing | Manifest, tree hashes, scenario loading |
| `mcp` | Trust types for the future MCP server | No result can claim approval |

The workspace policy checks run on their own with `pnpm test:workspace`. They
cover license headers, banned dependencies (Nx, LLM SDKs, native addons),
package shape, and CODEOWNERS.

### Narrowing down

```sh
pnpm --filter @engintel/graph exec vitest run test/cycles.test.ts   # one file
pnpm --filter @engintel/policy exec vitest run -t "exceptions"      # tests whose name matches
pnpm --filter @engintel/policy exec vitest                          # watch mode: reruns on save
```

## Golden fixtures

`tests/golden/` holds nine small repositories that pin down required behaviour
(see `tests/golden/GOLDEN.md`). The golden test in
`packages/orchestrator/test/golden.test.ts` runs every scenario and compares
the full report with `expected.json`. It checks the pass or fail verdict
against a separate pinned table, and runs each scenario twice to prove the
output is identical.

- **Never edit a fixture's `repo/`** to make a test pass. Fixtures are hashed in
  `manifest.json`, and `pnpm test` fails if one changes. When a requirement
  really changes, update the fixture and record it with
  `pnpm golden:update --version <higher version>`.
- **After an intended change** to messages or behaviour, rebuild, regenerate
  `expected.json`, and review the diff line by line before committing:

  ```sh
  pnpm build
  ENGINTEL_UPDATE_EXPECTED=1 pnpm --filter @engintel/orchestrator test
  git diff tests/golden
  ```

## By hand

Build first, then make an alias from the repository root:

```sh
pnpm build
alias engintel="node '$PWD/packages/cli/dist/bin.js'"
```

Always copy a fixture before running commands in it:

```sh
mkdir -p ~/engintel-try
cp -R tests/golden/invalid-layer/repo ~/engintel-try/invalid-layer
engintel validate --root ~/engintel-try/invalid-layer; echo "exit: $?"
```

| Fixture | Expected exit |
| --- | --- |
| `valid-architecture` | 0 |
| `invalid-layer` | 1 |
| `circular` | 1 |
| `unresolved` | 1 |
| `unreadable-files` | 1 |
| `prompt-injection` | 1 |
| `exceptions` | 1 with `--now 2026-09-01`, 0 with `--now 2026-02-01` |

Things to check by hand, in a copy of `valid-architecture`:

| Do this | Expect |
| --- | --- |
| Add a file in `src/controllers/` that imports `../repositories/order.repository` | Exit 1, `no-controller-to-repository`, a route through `services` naming `OrderService` |
| Write an unfinished line into a new `src/services/*.ts` file | Exit 1, `engintel.unanalyzable` (`syntax-error`) |
| Remove a comma from `.engintel/architecture.json` | Exit 2, `E_CONTRACT_INVALID` with a line and column |
| Set `"status": "draft"` in the contract | Exit 2, `E_CONTRACT_DRAFT` |
| Delete the contract | Exit 2, `E_CONTRACT_MISSING` |
| Run `validate --format json` twice | Byte-identical output |
| Run `analyze` | Exit 0; `.engintel/cache/graph.json`, `symbols.json`, and `graph-cache.json` appear, nothing else changes |
| Run `validate --verbose` twice | The second run logs `graph cache: hit` |
| `engintel baseline write --written-by you --yes` in a copy of `invalid-layer`, then `validate` | Exit 0; add another skip-layer import and it fails again |
| Run `validate --format sarif` | SARIF 2.1.0 on stdout |

### Pull requests by hand

Turn a fixture copy into a small git repository with a branch, then check the
branch the way CI does:

```sh
cd ~/engintel-try/invalid-layer
git init -q -b main && git add -A && git commit -qm base && git checkout -qb pr
engintel validate --changed --base main; echo "exit: $?"    # 0: the existing debt is not in the diff
# add a new skip-layer import in src/controllers/, then run it again: exit 1
# delete no-controller-to-repository from .engintel/architecture.json: engintel.policy-weakening
engintel validate --changed --base main --policy-change-approved   # approved: a warning, not a failure
```

## EngIntel on itself

EngIntel's own contract is `.engintel/architecture.json`. It is a draft, so
`engintel validate` in this repository exits 2 by design. The test
`packages/orchestrator/test/dogfood.test.ts` previews it anyway. It checks that
the codebase still follows its package layering, and that each rule fails when
a forbidden import is injected. Run it with:

```sh
pnpm --filter @engintel/orchestrator exec vitest run test/dogfood.test.ts
```
