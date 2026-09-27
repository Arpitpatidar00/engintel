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
pnpm build
pnpm typecheck
pnpm test
```

Decisions made during Phase 0 are recorded in `docs/phase-0-decisions.md`.

## License

Apache-2.0. See `LICENSE`.
