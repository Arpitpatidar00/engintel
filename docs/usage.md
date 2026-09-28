# Using EngIntel

EngIntel checks that the imports in a JavaScript or TypeScript repository follow
the architecture you wrote down. You describe your layers and rules once, in
`.engintel/architecture.json`. `engintel validate` then reads the real import
graph and fails, with an explanation and a legal alternative, when code breaks
a rule. The same input always gives the same result, and nothing is guessed by
an AI model.

This guide covers Phases 1 and 2: the analysis engine and the pull-request
gate (baselines, `--changed`, policy-change detection, SARIF, and the GitHub
Action). See [What is not here yet](#what-is-not-here-yet) for later phases.

- [1. Install](#1-install)
- [2. Try it on an example in five minutes](#2-try-it-on-an-example-in-five-minutes)
- [3. Set it up on your own project](#3-set-it-up-on-your-own-project)
- [4. Commands](#4-commands)
- [5. Exit codes](#5-exit-codes)
- [6. Reading the results](#6-reading-the-results)
- [7. The contract: `.engintel/architecture.json`](#7-the-contract-engintelarchitecturejson)
- [8. Tool settings: `.engintel/config.json`](#8-tool-settings-engintelconfigjson)
- [9. Files EngIntel cannot read](#9-files-engintel-cannot-read)
- [10. Existing debt: the baseline](#10-existing-debt-the-baseline)
- [11. Pull requests: `--changed` and policy changes](#11-pull-requests---changed-and-policy-changes)
- [12. Running it on GitHub](#12-running-it-on-github)
- [13. Troubleshooting](#13-troubleshooting)
- [What is not here yet](#what-is-not-here-yet)

## 1. Install

EngIntel is not published to npm yet. Build it from this repository:

```sh
git clone https://github.com/Arpitpatidar00/engintel.git
cd engintel
pnpm install
pnpm build
```

You need **Node 22** (22.13 or newer; see `.nvmrc`) and **pnpm** (the version
is pinned in `package.json`). EngIntel is built and tested on Node 22. The
development tools refuse end-of-life releases such as Node 25, so if your
default Node is newer, switch with `nvm use 22` or put Homebrew's `node@22`
first on your `PATH`.

The command is `packages/cli/dist/bin.js`. An alias saves typing; run this from
the repository root:

```sh
alias engintel="node '$PWD/packages/cli/dist/bin.js'"
engintel --version
```

The rest of this guide uses `engintel` to mean that alias.

## 2. Try it on an example in five minutes

`tests/golden/` contains small example repositories. Copy one before you
experiment. The originals are protected by hashes, and editing them makes the
test suite fail.

```sh
mkdir -p ~/engintel-try
cp -R tests/golden/valid-architecture/repo ~/engintel-try/shop
cd ~/engintel-try/shop

engintel validate
echo "exit code: $?"          # 0: the architecture is respected
```

Now break a rule. Add a controller that skips the service layer:

```sh
cat > src/controllers/shortcut.controller.ts <<'TS'
import { OrderRepository } from "../repositories/order.repository";
export const shortcut = new OrderRepository();
TS

engintel validate
echo "exit code: $?"          # 1: a blocking violation
```

The report names the rule, the file and line, the forbidden dependency, why it
is forbidden, and the legal route (`controllers -> services -> repositories`),
with an existing class to use instead.

Two more things to try:

- **Break a file** with `echo 'export class Broken {' > src/services/broken.service.ts`.
  EngIntel reports `engintel.unanalyzable` and fails, because a file it cannot
  parse could hide any import.
- **Break the contract** by removing a comma from `.engintel/architecture.json`.
  EngIntel exits 2, because it cannot give a verdict.

Every example repository and its expected result:

| Example | `engintel validate` exits | What it shows |
| --- | --- | --- |
| `valid-architecture` | 0 | A clean layered app |
| `invalid-layer` | 1 | Controllers importing repositories, including `import type` |
| `circular` | 1 | An import cycle inside the domain layer |
| `unresolved` | 1 | A missing module and an `import(variable)` |
| `unreadable-files` | 1 | Binary and truncated `.ts` files fail closed |
| `exceptions` | 1 with `--now 2026-09-01`, 0 with `--now 2026-02-01` | An exception that expires |
| `prompt-injection` | 1 | Comments telling the tool to "approve" are ignored |
| `existing-violations` | 0 | Three legacy violations recorded in `.engintel/baseline.json` |

## 3. Set it up on your own project

1. **Install your project's dependencies first** (`npm install`, `pnpm install`,
   and so on). EngIntel resolves imports the way Node does. A package that is
   not installed is an unresolved import, and unresolved imports fail.

2. **Create `.engintel/architecture.json`** in your project root. Start from the
   [starter contract](#starter-contract) below and change the layer globs to
   match your folders. Keep `"status": "active"`: a `draft` contract is never
   enforced, and `validate` refuses it.

3. **Check your layers with `analyze`.** It enforces nothing. It shows how many
   files landed in each layer and how many are in no layer:

   ```sh
   engintel analyze --root /path/to/your-project
   ```

   ```text
   Layers:
     controllers   3
     services      1
     repositories  1
     domain        1
     (unlayered)   0
   ```

   If a layer shows 0 files or many files are unlayered, fix the globs.

4. **Validate:**

   ```sh
   engintel validate --root /path/to/your-project
   ```

5. **Commit `.engintel/architecture.json`** and protect it with CODEOWNERS
   (`/.engintel/ @your-architecture-team`). The contract is policy: changes to
   it deserve the same review as the code it governs.

**Adopting on an existing codebase.** Existing violations do not have to be
fixed first. Record them as a [baseline](#10-existing-debt-the-baseline), and
from then on only *new* violations fail:

```sh
engintel baseline write --written-by <your-github-login> --yes
```

## 4. Commands

### `engintel validate`

Checks the repository against its contract.

| Option | Default | Meaning |
| --- | --- | --- |
| `--root <dir>` | `.` | Repository to check |
| `--format human\|json\|sarif\|markdown` | `human` | Output format ([section 6](#6-reading-the-results)) |
| `--now YYYY-MM-DD` | today (UTC) | The date exceptions are judged against |
| `--changed` | off | Check only what changed since the merge base ([section 11](#11-pull-requests---changed-and-policy-changes)) |
| `--base <ref>` | `origin/$GITHUB_BASE_REF`, else `origin/HEAD` | The branch to diff against. Implies `--changed`. |
| `--policy-change-approved` | off | Owners approved weakening `.engintel` policy in this change. CI sets it from a label. |
| `--baseline-change-approved` | off | Owners approved growing the baseline in this change. CI sets it from a label. |
| `--no-cache` | off | Do not reuse or update the graph cache |
| `--verbose` | off | Log graph-cache statistics to stderr |

`engintel architecture validate` does the same thing.

`validate` writes only `.engintel/cache/graph-cache.json`, a derived cache
that makes the next run faster (nothing with `--no-cache`).

### `engintel analyze`

Builds the import graph and a list of exported symbols, and prints a summary:
files, modules, dependencies, cycles, files per layer, and unreadable files.
It enforces nothing and exits 0 unless something prevents the analysis itself.
It works without a contract.

| Option | Default | Meaning |
| --- | --- | --- |
| `--root <dir>` | `.` | Repository to analyze |
| `--format human\|json` | `human` | Output format |
| `--no-cache` | off | Do not use or write `.engintel/cache/` |

It writes only these files:

- `.engintel/cache/graph.json`: every module and import edge.
- `.engintel/cache/symbols.json`: every exported function, class, type, and
  so on, with where it is declared.
- `.engintel/cache/graph-cache.json`: per-file results reused by the next run.

Add `.engintel/cache/` to your `.gitignore`.

### `engintel baseline`

Inspects or rewrites `.engintel/baseline.json` ([section 10](#10-existing-debt-the-baseline)).

| Command | Does |
| --- | --- |
| `engintel baseline show` | Entries, author, age, counts per rule, integrity |
| `engintel baseline check` | Verifies every entry against its fields (exit 0, or 2) |
| `engintel baseline write --written-by <login> [--yes]` | Records every current violation as existing debt |
| `engintel baseline prune --written-by <login> [--yes]` | Drops entries whose violation is gone |

`write` and `prune` are dry runs until you add `--yes`.

### `engintel report <file>`

Renders a report saved with `validate --format json` in another format
(`--format human|json|sarif|markdown`), without analyzing again.

### Other

`engintel --help`, `engintel <command> --help`, `engintel --version`.

## 5. Exit codes

| Code | Meaning | Examples |
| --- | --- | --- |
| **0** | Pass | No blocking violations (warnings and advisories may still be printed) |
| **1** | Blocking violations | A forbidden import, a cycle, an unreadable or unparseable file, an unapproved policy weakening, a dropped baseline entry that still occurs |
| **2** | No verdict | Missing, invalid, or draft contract; invalid config or baseline; the analysis crashed or timed out; the git base cannot be found; bad command-line options |

Exit 2 is never a pass. EngIntel fails closed: when it cannot be sure, it does
not say "OK".

## 6. Reading the results

### Human format

```text
EngIntel validate: FAIL (2 errors, 0 warnings, 0 advisories)
Contract: .engintel/architecture.json (policy 1.0.0, active)
Scope: full repository; 6 files and 7 dependencies checked

error  no-controller-to-repository
  src/controllers/audit.controller.ts:1:1
  Forbidden dependency from layer 'controllers' to layer 'repositories': src/controllers/audit.controller.ts imports types from src/repositories/order.repository.ts.
  Why: Layer 'controllers' is not allowed to depend on layer 'repositories' under rule 'no-controller-to-repository'. Do not skip the service layer. Inject a service and call it.
  Dependency:
    src/controllers/audit.controller.ts
    -> src/repositories/order.repository.ts  (type-only)
  Legal route: controllers -> services -> repositories
  Suggested: Depend on layer 'services' instead, following the legal route controllers -> services -> repositories. For example, use OrderService (class) from src/services/order.service.ts.
  Identity: f8daa3052e389d132ce20a6372c81f1dfbe5b0de461f407218bcfc8a57fef82d
```

| Line | Meaning |
| --- | --- |
| `error  <rule id>` | Severity and the rule that fired. `(not blocking)` marks warnings and advisories. |
| file and position | Where the import is (line and column) |
| message | What happened, in one sentence |
| `Why:` | Why it is not allowed, including the `comment` from your contract |
| `Dependency:` or `Cycle:` | The exact import, or the cycle of files |
| `Legal route:` / `Suggested:` | What would be allowed instead. When the contract allows several routes, EngIntel lists them rather than picking one. |
| `Identity:` | A stable fingerprint of this violation. It does not change when lines move or wording improves. Phase 2 baselines use it. |

Color is used only when the output is a terminal, and `NO_COLOR=1` turns it off.

### JSON format

`--format json` prints one JSON document on stdout. Logs and errors go to
stderr, so you can pipe stdout straight into another tool:

```sh
engintel validate --format json > report.json
```

Top-level fields: `outcome` (`pass` or `fail`), `exitCode`, `counts`,
`diagnostics`, `exceptionsApplied`, `unanalyzable`, `stats`, `notices`, plus
`contract` (file, policy version, hash), `scope`, `git` (base and merge base
for `--changed`), `baseline` (entries, suppressed, stale), `policyChange`
(classified edits to `.engintel` files), `now`, and `engineVersion`.

### SARIF and Markdown

`--format sarif` prints SARIF 2.1.0 for GitHub code scanning. Each result's
partial fingerprint is its EngIntel identity, so an alert keeps its identity
when lines move. `--format markdown` prints a summary table (at most 50 rows)
for a GitHub job summary. Neither ever contains source text.

Each entry in `diagnostics` has `ruleId`, `severity`, `blocking`, `file`,
`range`, `message`, `why`, `edge` (`source`, `target`, `kind`) or
`cycleSignature`, `suggest` (`kind`, `explanation`, `layers`), and `identity`.
The schema is `packages/config/schema/diagnostic.schema.json`.

When a `--format json` run fails with exit 2, stdout holds an error report instead:
`{"outcome": "error", "exitCode": 2, "error": {"code": "E_CONTRACT_INVALID", "message": "...", "issues": [...]}}`.

The report contains no timestamps or absolute paths. Running twice on the same
code gives byte-identical output.

## 7. The contract: `.engintel/architecture.json`

The full schema is `packages/config/schema/architecture.schema.json`. Point
`$schema` at it and editors such as VS Code will autocomplete and check the file.

### Starter contract

```json
{
  "schemaVersion": 1,
  "policyVersion": "1.0.0",
  "status": "active",
  "description": "Layered backend: controllers -> services -> repositories, everything may use domain.",
  "layers": [
    { "id": "controllers", "description": "HTTP adapters", "globs": ["src/controllers/**"] },
    { "id": "services", "description": "Application logic", "globs": ["src/services/**"] },
    { "id": "repositories", "description": "Persistence", "globs": ["src/repositories/**"] },
    { "id": "domain", "description": "Entities and value types", "globs": ["src/domain/**"] }
  ],
  "rules": [
    {
      "id": "no-controller-to-repository",
      "kind": "forbidden",
      "severity": "error",
      "from": { "layer": "controllers" },
      "to": { "layer": "repositories" },
      "comment": "Do not skip the service layer. Inject a service and call it."
    },
    {
      "id": "no-repository-upward",
      "kind": "forbidden",
      "severity": "error",
      "from": { "layer": "repositories" },
      "to": { "layers": ["services", "controllers"] },
      "comment": "Repositories depend on nothing above them."
    },
    {
      "id": "domain-stays-pure",
      "kind": "forbidden",
      "severity": "error",
      "from": { "layer": "domain" },
      "to": { "layers": ["controllers", "services", "repositories"] },
      "comment": "Domain types must not know about the layers that use them."
    },
    {
      "id": "acyclic-domain",
      "kind": "acyclic",
      "severity": "error",
      "within": { "layer": "domain" },
      "comment": "Break domain cycles or extract a shared types module."
    },
    {
      "id": "imports-resolve",
      "kind": "forbidden",
      "severity": "error",
      "from": { "glob": "src/**" },
      "to": { "unresolved": true },
      "comment": "Every import must resolve to a file or an installed package."
    }
  ],
  "exceptions": [
    {
      "id": "ex-health-check",
      "ruleId": "no-controller-to-repository",
      "source": "src/controllers/health.controller.ts",
      "target": "src/repositories/*.ts",
      "reason": "Liveness reads the database directly so a broken service layer cannot hide an outage.",
      "owner": "@platform-team",
      "addedAt": "2026-09-01",
      "expiresAt": "2027-02-28"
    }
  ],
  "opaqueImports": "error"
}
```

### Top-level fields

| Field | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | yes | Always `1` |
| `policyVersion` | yes | Your version of the policy, as semver (`1.0.0`) |
| `status` | yes | `active` is enforced; `draft` is refused by `validate` |
| `layers` | yes | At least one layer |
| `rules` | yes | At least one rule |
| `exceptions` | no | Time-limited waivers |
| `opaqueImports` | no | `error` (default) or `warn`, for imports EngIntel cannot resolve |
| `unlayered` | no | `{ "severity": "warn", "comment": "..." }` for files in no layer. Default: `advisory` |
| `unsupportedPaths` | no | Reviewed list of files that may be unreadable (see [section 9](#9-files-engintel-cannot-read)) |
| `externals` | no | `{ "allowUnresolved": ["virtual:*"] }` lists import specifiers that may stay unresolved, such as bundler virtual modules |
| `ownership` | no | `{ "policyCodeowners": ["@team"] }`, informational |
| `description`, `$schema` | no | Free text; schema link for editors |

Unknown fields are errors, not silently ignored. A typo like `"exeptions"`
makes `validate` exit 2 and point at it.

### Layers

```json
{ "id": "services", "globs": ["src/services/**"], "excludeGlobs": ["src/services/legacy/**"], "intraAllowed": true }
```

- `id`: lowercase letters, digits, and `-`, 2 to 64 characters. It must start
  with a letter.
- `globs`: repo-relative paths with `/`, such as `src/services/**` or
  `apps/*/src/api/**`. They may not start with `!` (use `excludeGlobs`), use
  `\`, or contain `..` or `node_modules`.
- `intraAllowed` (default `true`): whether files in this layer may import each
  other.
- A file must match exactly one layer. A file in two layers is a contract error
  (`engintel.overlapping-layers`); fix it with `excludeGlobs`.

### Rule targets (`from`, `to`, `within`)

| Form | Matches |
| --- | --- |
| `{ "layer": "services" }` | Files in one layer |
| `{ "layers": ["services", "controllers"] }` | Files in any of these layers |
| `{ "glob": "src/**" }` | Files matching a glob, whatever their layer |
| `{ "external": "typeorm" }` | An npm package; globs work: `"@prisma/*"`, `"{openai,@anthropic-ai/*}"` |
| `{ "unresolved": true }` | Imports that do not resolve |

### Rule kinds

Every rule has `id`, `kind`, `severity`, and `comment`. The comment is shown
to whoever breaks the rule, so write it as advice. `"enabled": false` switches
a rule off.

| Severity | Effect |
| --- | --- |
| `error` | Reported and blocking (exit 1) |
| `warn` | Reported, not blocking |
| `advisory` | Reported as information, not blocking |

**`forbidden`**: imports from `from` to `to` are not allowed.

```json
{
  "id": "no-orm-in-domain", "kind": "forbidden", "severity": "error",
  "from": { "layer": "domain" }, "to": { "external": "typeorm" },
  "comment": "Domain code must not depend on the ORM."
}
```

Options:
- `direction`: `forward` (default), `backward` (only `to` importing `from`), or
  `both`.
- `ignoreTypeOnly` (default `false`): by default `import type` counts, because
  leaking a type across a layer is still a layer violation.
- `ignoreDynamic` (default `false`): by default `import("./x")` counts.

**`allowed` with `"exclusive": true`**: the layer may import *only* these
layers (plus itself, unless `intraAllowed` is false). Anything else fails under
this rule. `from` must be a single `{ "layer": ... }`. Other `allowed` rules
from the same layer add to the allowed set. Imports of npm packages and
unlayered files are not restricted by it.

```json
{
  "id": "controllers-allowed", "kind": "allowed", "severity": "error", "exclusive": true,
  "from": { "layer": "controllers" }, "to": { "layers": ["services", "domain"] },
  "comment": "Controllers talk to services and use domain types, nothing else."
}
```

**`acyclic`**: no import cycles among the files in `within`. Each distinct cycle
is reported once, starting from its alphabetically first file.

**`required`**: every file in `from` must import something in `to`. A miss is
reported with target `<missing>`.

```json
{
  "id": "services-need-repositories", "kind": "required", "severity": "warn",
  "from": { "layer": "services" }, "to": { "layer": "repositories" },
  "comment": "Services own persistence calls."
}
```

**`reachable`**: every file in `to` must be reachable through imports from some
file in `from`. This is useful for finding dead code.

`naming` rules are accepted by the schema but not enforced yet.

### Exceptions

An exception waives one rule for matching imports until a date.

| Field | Rule |
| --- | --- |
| `id` | Unique, same format as rule ids |
| `ruleId` | A rule in this contract. Built-in `engintel.*` rules cannot be waived. |
| `source`, `target` | Globs for the importing file and the imported file. `"target": "*"` means any target. |
| `reason` | At least 20 characters |
| `owner` | `@user` or `@org/team` |
| `addedAt`, `expiresAt` | `YYYY-MM-DD`; `expiresAt` must be later than `addedAt` |

An exception applies while today's date (UTC, or `--now`) is on or before
`expiresAt`. After that the violation is back, and the message says which
exception expired and when. Exceptions longer than 180 days produce a warning
note. Applied exceptions are listed in the report.

### Rules EngIntel always applies

| Rule | When | Severity |
| --- | --- | --- |
| `engintel.unanalyzable` | A source file cannot be read or parsed | error |
| `engintel.opaque-import` | `import(variable)` or `require(variable)`: the target cannot be known | `opaqueImports` |
| `engintel.unresolved-import` | An import does not resolve and no rule of yours already reported it | `opaqueImports` |
| `engintel.overlapping-layers` | A file matches two layers | error |
| `engintel.intra-layer` | Files import each other in a layer with `intraAllowed: false` | error |
| `engintel.unlayered` | A file is in no layer | `unlayered.severity`, default advisory |
| `engintel.policy-weakening` | A change weakens `.engintel` policy without owners' approval ([section 11](#11-pull-requests---changed-and-policy-changes)) | error (warning when approved) |
| `engintel.policy-change` | A change tightens `.engintel` policy | advisory |
| `engintel.baseline-drop` | A change removes a baseline entry whose violation still exists | error |

## 8. Tool settings: `.engintel/config.json`

This file is optional. It holds tool settings only; policy always lives in the
contract, so this file cannot weaken enforcement.

```json
{
  "schemaVersion": 1,
  "include": ["src/**"],
  "exclude": ["src/**/*.generated.ts", "**/*.test.ts"],
  "tsconfig": "tsconfig.json",
  "limits": { "graphTimeoutMs": 300000 }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `include` | every JS/TS file git does not ignore | Source globs to analyze |
| `exclude` | none | Source globs to skip. Skipped files are reported as ignored, never as passed. |
| `tsconfig` | `tsconfig.json` if present | The tsconfig used for path aliases such as `@app/*` |
| `limits.maxFiles` | 200 000 | More files than this: exit 2 |
| `limits.maxTotalBytes` | 1.5 GiB | More source than this: exit 2 |
| `limits.maxFileBytes` | 2 MiB | Larger files are unreadable (`too-large`) |
| `limits.graphTimeoutMs` | 120 000 | Import-graph time limit: exit 2 when exceeded |

The schema is `packages/config/schema/config.schema.json`. Unknown keys, keys
that look like secrets (`token`, `apiKey`, and so on), and values that look like
credentials are refused.

To skip files without a config file, list them in `.engintel/ignore` using
`.gitignore` syntax.

Both files decide what gets checked, so they are policy too: in a pull
request, excluding or ignoring more files is reported as a policy weakening
([section 11](#11-pull-requests---changed-and-policy-changes)).

Which files are analyzed: in a git repository, tracked files plus untracked
files that `.gitignore` does not exclude. Otherwise, a directory walk that
honors every `.gitignore`. `node_modules`, `.git`, and `.engintel/cache/` are
always skipped. Source files are `.ts .tsx .mts .cts .js .jsx .mjs .cjs`.

## 9. Files EngIntel cannot read

A file EngIntel cannot read or parse could contain any import, so it never
counts as a pass. It is reported as `engintel.unanalyzable` (exit 1) with the
reason: `binary`, `invalid-utf8`, `too-large`, `permission`, `symlink`,
`unportable-path`, or `syntax-error`.

If a file is genuinely meant to be that way, such as a vendored binary with a
`.ts` name, list it in the contract where reviewers can see it:

```json
"unsupportedPaths": [
  {
    "glob": "src/legacy/vendor-blob.ts",
    "reason": "Vendored binary blob; replacement tracked in PLAT-88.",
    "owner": "@platform-team"
  }
]
```

Files on this list are still shown in the report (`allowlisted: true`), but
they do not block.

## 10. Existing debt: the baseline

`.engintel/baseline.json` lists violations that already existed when you
adopted EngIntel. A baselined violation is reported as "not counted" instead
of failing; any violation not in the file fails. That makes the gate
adoptable on a messy codebase without letting new debt in.

Each entry is identified by a fingerprint of the rule, the importing file,
the imported file, and (for cycles) the cycle. It survives reformatting and
line moves, but a new import between different files is new debt.

**Adopt:**

```sh
engintel baseline write --written-by <your-github-login>          # dry run: what would be recorded
engintel baseline write --written-by <your-github-login> --yes    # write .engintel/baseline.json
```

Commit it in its own pull request. Owners review a sample of each rule; the
command prints the counts per rule. Delete rules you do not really want
instead of baselining them.

**Rules of the ledger:**

- A human writes it: `--written-by` must be a GitHub login, and agent or bot
  names are refused. In CI, writing is refused unless a manually triggered
  workflow sets `ENGINTEL_ALLOW_BASELINE_WRITE=1`.
- Files EngIntel cannot analyze, opaque or unresolved imports, and
  overlapping layers can never be baselined. Fix them, or list genuinely
  unreadable files under the contract's `unsupportedPaths`.
- Only errors are recorded; warnings and advisories never block anyway.
- Every entry is checked against its fields on every run. A hand-edited entry
  fails closed (exit 2); `engintel baseline check` shows which one.
- A full run lists entries whose violation is gone ("stale"). Remove them with
  `engintel baseline prune --written-by <login> --yes`.

## 11. Pull requests: `--changed` and policy changes

```sh
engintel validate --changed --base origin/main
```

`--changed` finds the merge base of your branch and `--base`, and checks
everything that differs from it: committed, uncommitted, and untracked
changes, deletions, and both sides of renames.

- An import is checked when the importing file or the imported file changed.
  Deleting a file checks the files that imported it.
- Changing any member of an import cycle checks the whole cycle.
- A change to `.engintel/architecture.json` re-checks everything.
- Unreadable or unparseable files block only when they are part of the
  change.
- The baseline used is the one at the merge base. Adding your own new
  violation to `baseline.json` in the same pull request does not hide it.

**Policy changes.** Every file in `.engintel/` (the contract, `baseline.json`,
`config.json`, `ignore`) is compared with its merge-base version, and each
difference is classified:

| Class | Examples | Effect |
| --- | --- | --- |
| weakening | Removing or disabling a rule, lowering its severity, editing what it covers, adding or extending an exception, allowlisting paths, `status` to `draft`, excluding files in `config.json` or `ignore`, adding baseline entries | Blocking `engintel.policy-weakening`, unless owners approved |
| tightening | Adding a forbidden or acyclic rule, removing an exception, pruning fixed baseline entries | Advisory `engintel.policy-change` |
| neutral | Comments, descriptions, versions, owners | Listed in the report only |

When the effect of an edit cannot be proven harmless, it counts as a
weakening. Owners approve a weakening with a pull request label, which CI
turns into `--policy-change-approved` or `--baseline-change-approved`
([section 12](#12-running-it-on-github)). Removing a baseline entry whose
violation still exists always fails (`engintel.baseline-drop`), approved or
not.

## 12. Running it on GitHub

Use the Action in `packages/action`. It runs `engintel validate --changed` on
the pull request's own checkout, writes a job summary and a SARIF file, caches
EngIntel's build and the graph, and fails the job with the CLI's exit code.

```yaml
- uses: actions/checkout@<sha>
  with:
    fetch-depth: 0
- id: engintel
  uses: Arpitpatidar00/engintel/packages/action@<commit sha>
```

The complete setup, including the workflow file, CODEOWNERS, a ruleset that
requires the check and code-owner review, and the approval labels, is in
[`packages/action/README.md`](../packages/action/README.md). A check that is
not required by a ruleset is only a suggestion.

Other CI systems can run the CLI directly. Exit code 1 or 2 fails the job:

```sh
node path/to/engintel/packages/cli/dist/bin.js validate --changed --base origin/main --format sarif > engintel.sarif
```

## 13. Troubleshooting

| You see | What to do |
| --- | --- |
| `Unsupported engine`, or tests refusing to start | Use Node 22 (`nvm use 22`, or put Homebrew `node@22` first on `PATH`) |
| `E_CONTRACT_MISSING` | Create `.engintel/architecture.json` |
| `E_CONTRACT_DRAFT` | Review the contract, then set `"status": "active"` |
| `E_CONTRACT_INVALID` | The message and the listed issues point at the exact field, e.g. `rules[2].from.layer: unknown layer "service"` |
| Many `unresolved:` imports of packages | Install the project's dependencies first |
| `@app/...` style imports unresolved | Set `tsconfig` in `.engintel/config.json`. The tsconfig needs `baseUrl` next to `paths`; on TypeScript 6 also add `"ignoreDeprecations": "6.0"`. |
| Bundler-only specifiers (`virtual:...`) unresolved | Add them to `externals.allowUnresolved` in the contract |
| Generated code failing rules | Exclude it in `.engintel/config.json` or `.engintel/ignore` |
| A file in two layers | Narrow one layer with `excludeGlobs` |
| Files counted as `(unlayered)` | Run `engintel analyze` and adjust the layer globs |
| `E_GRAPH_TIMEOUT` | Raise `limits.graphTimeoutMs`, or narrow `include` |
| `E_REPO_TOO_LARGE` | Narrow `include`, or raise the limits |
| `E_GIT_BAD_REF` | The base branch is not in this clone: `git fetch origin main`, or pass `--base` |
| `E_GIT_NO_MERGE_BASE` | Shallow clone: check out with full history (`fetch-depth: 0`) |
| `E_BASELINE_INVALID` | Run `engintel baseline check`; rewrite hand-edited entries with `engintel baseline write` |
| `E_BASELINE_FORBIDDEN` | Fix unanalyzable files or opaque imports first; they cannot be baselined |
| `E_BASELINE_WRITE_IN_CI` | Write the baseline locally, or from a manual workflow with `ENGINTEL_ALLOW_BASELINE_WRITE=1` |
| `engintel.policy-weakening` on your pull request | Revert that part of `.engintel/`, or ask an architecture owner to review and add the label |
| `engintel.baseline-drop` | Fix the violation before removing its entry, or restore the entry |

Error codes always appear on stderr as `engintel: error E_...: message`, and in
the JSON error report under `error.code`.

## What is not here yet

| Feature | Phase |
| --- | --- |
| `engintel drift`: debt counts, rates, and age over time | later |
| `engintel init` to draft a contract from your folders | later |
| MCP server so AI coding agents can ask EngIntel before they write code | 3 |
| Symbol search, repair loop, tsc/ESLint/test orchestration | 4 to 6 |
| Enforcing `naming` rules | later |

For how the behaviour was decided, see `docs/phase-1-decisions.md` and
`docs/phase-2-decisions.md`.
To test EngIntel itself, see `docs/testing.md`.
