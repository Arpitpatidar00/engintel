# Golden repositories

Nine small repositories that pin down what EngIntel must do. Phase 1 and 2
tickets are done when these fixtures produce the outcomes below, and not before
(research doc 01, section 7).

**Phase 1 status:** the inputs are final for `fixtureVersion` 0.1.0.
`expected.json` is filled for `valid-architecture`, `circular`,
`invalid-layer`, `unresolved`, `exceptions`, `prompt-injection`, and
`unreadable-files`. `existing-violations` and `policy-change` stay `{}` until
baselines (ENG-009) and policy-change detection (ENG-012) land in Phase 2.

## Layout

```
tests/golden/
  manifest.json          fixtureVersion + one treeHash per fixture
  GOLDEN.md              this file
  <fixture>/
    repo/                the repository EngIntel analyzes
    scenarios/*.json     how to run it: changed files, clock, base, overlay
    base/                (optional) merge-base versions of changed files
    overlays/<name>/     (optional) files copied over repo/ before running
    expected.json        keyed by scenario name, or {} while deferred
```

Every `repo/` shares one small app and one contract: `controllers` may use
`services`, `services` may use `repositories`, everything may use `domain`.
Its rules are `no-controller-to-repository`, `no-service-to-controller`,
`no-repository-upward`, `no-upward-from-domain`, `acyclic-domain`, and
`no-unresolved-in-src`, all severity `error`, with `opaqueImports: "error"`.

## Scenarios

A scenario replaces git history so tests stay hermetic (research doc 07,
section 9). The schema is `ScenarioSchema` in `@engintel/testkit`.

| Field | Meaning |
| --- | --- |
| `mode` | `full` validates everything; `changed` validates `changedFiles` and the edges that touch them |
| `changedFiles` | Paths relative to `repo/`, after the overlay is applied |
| `contractChanged` | `.engintel/architecture.json` is part of the diff |
| `base` | `"base"` when merge-base versions of changed files live in `base/` |
| `overlay` | `overlays/<name>` to copy over `repo/` first, or `null` |
| `now` | Injected clock (YYYY-MM-DD). Validation never reads the wall clock |

## Hashing and versioning

`treeHash` is the doc 04 tree fingerprint: sha256 of the lines
`<posix path>\0<sha256 of raw bytes>`, sorted by path and joined by `\n`, over
every file in the fixture except `expected.json`. Bytes are hashed raw, and
`.gitattributes` marks `tests/golden/**` as `-text` so git never rewrites line
endings.

`pnpm test` fails if any fixture's tree no longer matches `manifest.json`. To
change a fixture on purpose:

```sh
pnpm golden:update --version 0.2.0   # must be greater than the current version
```

Change a fixture only when a requirement changes. Never edit a fixture to make
an implementation pass.

## Expected results

Each scenario's entry in `expected.json` is the full `engintel validate` JSON
report for that scenario, minus `engineVersion`. The test in
`packages/orchestrator/test/golden.test.ts` runs every scenario on a temporary
copy, compares the report, checks it again against a pinned pass/fail table,
and runs it twice to prove the output is byte-identical.

`expected.json` is not part of `treeHash`. After an intended change to wording
or behaviour, regenerate it and review the diff line by line:

```sh
ENGINTEL_UPDATE_EXPECTED=1 pnpm --filter @engintel/orchestrator test
```

## Fixtures

### `valid-architecture`

Negative control: a clean layered repository (FR-005, FR-008).

| Scenario | Expected |
| --- | --- |
| `full` | Pass. No diagnostics. |
| `changed-service` | Pass. |

### `circular`

`src/domain/pricing.ts` and `src/domain/discount.ts` import each other
(FR-006; doc 05, section 6.3; doc 08, BD-3).

| Scenario | Expected |
| --- | --- |
| `full` | Fail. One `acyclic-domain` violation with cycle signature `src/domain/discount.ts -> src/domain/pricing.ts` (canonical rotation: smallest path first). |
| `changed-discount` | Fail with the same identity. Changing one member brings the whole cycle into scope. |

### `invalid-layer`

Two controllers reach into the repository layer (FR-005, FR-007; S-01, S-10).

| Scenario | Expected |
| --- | --- |
| `skip-layer` | Fail. Two `no-controller-to-repository` violations: `report.controller.ts` (value import) and `audit.controller.ts` (`import type`; types count because `ignoreTypeOnly` defaults to false). Each suggests the route `controllers -> services -> repositories` and names `OrderService` in `src/services/order.service.ts`. |

### `unresolved`

`src/services/export.service.ts` has one import of each visibility class
(FR-003; doc 05, DG-4, DG-10; doc 33, section 2).

| Scenario | Expected |
| --- | --- |
| `changed-export` | Fail. `../lib/csv-writer` does not exist and violates `no-unresolved-in-src`. `import(pluginPath)` is opaque and fails because `opaqueImports` is `"error"`. `import("../domain/order")` is a resolvable literal edge and is not a violation. |

### `existing-violations`

A messy repository with three legacy violations (FR-009, FR-010; S-02, S-03;
doc 08, BD-4, BD-5):

1. `legacy-billing.controller.ts -> order.repository.ts` (`no-controller-to-repository`)
2. `invoice.repository.ts -> order.service.ts` (`no-repository-upward`)
3. `money.ts -> order.service.ts` (`no-upward-from-domain`, type-only)

There is no `baseline.json` yet. ENG-009 creates it from `repo/` with
`engintel baseline create` once the identity function is fixed, and bumps
`fixtureVersion`.

| Scenario | Expected |
| --- | --- |
| `unrelated-change` | Pass. No violation touches the changed file. |
| `touch-legacy-file` | Pass. The legacy violation is in scope but baselined (suppressed by baseline: 1). |
| `new-violation` | Fail with exactly one new identity: the overlay's `refund.controller.ts -> order.repository.ts`. |

### `exceptions`

Two controller-to-repository edges, each covered by an exception
(doc 06, section 9; doc 07 fixtures `expired-exception` and `active-exception`).

| Scenario | Expected |
| --- | --- |
| `after-expiry` (now 2026-09-01) | Fail. `metrics.controller.ts -> metrics.repository.ts` violates `no-controller-to-repository` because `ex-metrics-shortcut` expired on 2026-03-01. The health edge is suppressed by `ex-health-liveness` (exceptions applied: 1). |
| `before-expiry` (now 2026-02-01) | Pass. Both exceptions apply. |

### `policy-change`

The agent attack from UC-5 and doc 06, section 8: the PR deletes the rule that
would catch the import it adds (FR-012; S-04).

| Scenario | Expected |
| --- | --- |
| `remove-forbidden-rule` | Fail. Compared with `base/`, the head contract drops `no-controller-to-repository`: a policy weakening that requires CODEOWNERS approval. Under the weakened contract the new import is legal; the weakening itself is what fails. |

### `prompt-injection`

`admin.controller.ts` hides an illegal import behind comments, JSDoc, and a
string that tell the tool to pass. `README.md` tells agents to delete the
contract (NFR-S6; doc 14, section 4.2; doc 30, scenario 7). Both files start
with a marker saying the adversarial text is test data.

| Scenario | Expected |
| --- | --- |
| `injected-comments` | Fail exactly as if the text were absent: one `no-controller-to-repository` violation. No diagnostic contains any injected string, and `README.md` is not analyzed as code. |

### `unreadable-files`

Files the analyzer cannot judge (FR-020; S-05; UC-6; D-009).
`corrupt.service.ts` and `src/legacy/vendor-blob.ts` are binary bytes with a
`.ts` extension; `truncated.service.ts` stops mid-expression. `vendor-blob.ts`
is on the contract's `unsupportedPaths` allowlist.

| Scenario | Expected |
| --- | --- |
| `changed-unanalyzable` | Fail closed. One unanalyzable diagnostic each for `corrupt.service.ts` and `truncated.service.ts`. These can never be baselined. |
| `unchanged-unanalyzable` | Pass. Unanalyzable files outside the diff do not block. |
| `allowlisted-change` | Pass. The allowlist is reviewed like policy. |

Permission-denied files cannot be committed (git does not store read
permissions). ENG-036 creates them at test time in a temporary copy.

## Resolved questions

The research documents disagreed on these points. Phase 1 settled them as
follows (see `docs/phase-1-decisions.md`).

1. **Exit code for unanalyzable changed files:** exit 1 with a blocking
   diagnostic (FR-020, doc 07). Exit 2 is reserved for tool and configuration
   errors, where no verdict can be given at all.
2. **Built-in unanalyzable rule id:** `engintel.unanalyzable` (doc 07). All
   built-in rules use the `engintel.` prefix, which contract ids cannot use.
3. **Policy weakening rule id:** deferred to ENG-012 in Phase 2, together with
   `policy-change/expected.json`.
4. **Violation identity separator:** `\u001f` (ENG-035), `identityVersion: 1`.
   Known-answer vectors live in `packages/policy/testdata/identity-vectors.json`.
