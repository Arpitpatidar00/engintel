# EngIntel

An architecture gate for JavaScript and TypeScript repositories that AI coding
agents modify. A versioned contract (`.engintel/architecture.json`), a
deterministic validator, and a GitHub required check that re-runs the validator
independently. The agent is never the authority.

**Status: Phase 2 (architecture gate).** `engintel validate` checks a
repository against its contract and exits 0 (pass), 1 (blocking violations),
or 2 (no verdict). Existing debt is recorded in a baseline so only new
violations fail; `--changed` checks what a pull request changed against the
merge base; edits that weaken `.engintel/` policy fail unless owners approve
them; results are available as SARIF; and a GitHub Action
([`packages/action`](packages/action/README.md)) runs it as a required check.
The MCP server for agents comes in Phase 3.

## Use

**Read [docs/usage.md](docs/usage.md)** for the full guide: setup, writing a
contract, commands, exit codes, reading results, and troubleshooting. To test
EngIntel itself, see [docs/testing.md](docs/testing.md).

Quick start:

```sh
pnpm install && pnpm build
node packages/cli/dist/bin.js validate --root path/to/repo            # human report
node packages/cli/dist/bin.js validate --root path/to/repo --format json
node packages/cli/dist/bin.js analyze  --root path/to/repo            # graph + symbols, no enforcement
```

- `validate` needs an active `.engintel/architecture.json`
  (schema: `packages/config/schema/architecture.schema.json`). A `draft`
  contract is refused.
- `--now YYYY-MM-DD` sets the date that exceptions are judged against
  (default: today, UTC).
- Files EngIntel cannot read or parse fail closed as `engintel.unanalyzable`,
  unless the contract's reviewed `unsupportedPaths` lists them.
- `analyze` writes only to `.engintel/cache/`. `validate` writes nothing.
- Optional tool settings (include/exclude globs, tsconfig, limits) go in
  `.engintel/config.json` (schema: `packages/config/schema/config.schema.json`).

EngIntel's own contract is `.engintel/architecture.json` (a draft).

## Develop

Requires Node 22.13+ (see `.nvmrc`) and pnpm (version pinned in `package.json`).

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

Golden fixtures live in `tests/golden/` (see `tests/golden/GOLDEN.md`). If you
change one on purpose, record it with a higher fixture version:

```sh
pnpm golden:update --version 0.2.0
```

To regenerate `expected.json` after an intended change in wording or behaviour
(review the diff line by line):

```sh
ENGINTEL_UPDATE_EXPECTED=1 pnpm --filter @engintel/orchestrator test
```

Decisions are recorded in `docs/phase-0-decisions.md`,
`docs/phase-1-decisions.md`, and `docs/phase-2-decisions.md`.

## License

Apache-2.0. See `LICENSE`.
