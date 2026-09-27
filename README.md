# EngIntel

An architecture gate for JavaScript and TypeScript repositories that AI coding
agents modify. A versioned contract (`.engintel/architecture.json`), a
deterministic validator, and a GitHub required check that re-runs the validator
independently. The agent is never the authority.

**Status: Phase 0.** The repository is scaffolding only: empty packages, locked
schemas, golden fixtures, and CI. No command does anything yet.

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

Decisions made during Phase 0 are recorded in `docs/phase-0-decisions.md`.

## License

Apache-2.0. See `LICENSE`.
