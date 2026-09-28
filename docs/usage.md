# Using EngIntel

EngIntel checks that the imports in a JavaScript or TypeScript repository follow
the architecture you wrote down. You describe your layers and rules once, in
`.engintel/architecture.json`. `engintel validate` then reads the real import
graph and fails, with an explanation and a legal alternative, when code breaks
a rule. The same input always gives the same result, and nothing is guessed by
an AI model.

This guide covers Phase 1, the analysis MVP. See [What is not here yet](#what-is-not-here-yet)
for what later phases add.

- [1. Install](#1-install)
- [2. Try it on an example in five minutes](#2-try-it-on-an-example-in-five-minutes)
- [3. Set it up on your own project](#3-set-it-up-on-your-own-project)
- [4. Commands](#4-commands)
- [5. Exit codes](#5-exit-codes)
- [6. Reading the results](#6-reading-the-results)
- [7. The contract: `.engintel/architecture.json`](#7-the-contract-engintelarchitecturejson)
- [8. Tool settings: `.engintel/config.json`](#8-tool-settings-engintelconfigjson)
- [9. Files EngIntel cannot read](#9-files-engintel-cannot-read)
- [10. Running it in CI](#10-running-it-in-ci)
- [11. Troubleshooting](#11-troubleshooting)
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

**Adopting on an existing codebase.** Phase 1 has no baselines yet, so every
existing violation fails. Until baselines arrive in Phase 2, either:

- start noisy rules at `"severity": "warn"`, which reports without blocking,
  and raise them to `error` once they are clean; or
- add a time-limited [exception](#exceptions) for each known violation, with an
  owner and a reason.

## 4. Commands

### `engintel validate`

Checks the repository against its contract.

| Option | Default | Meaning |
| --- | --- | --- |
| `--root <dir>` | `.` | Repository to check |
| `--format human\|json` | `human` | Output format |
| `--now YYYY-MM-DD` | today (UTC) | The date exceptions are judged against |

`engintel architecture validate` does the same thing.

`validate` never writes any files.

### `engintel analyze`

Builds the import graph and a list of exported symbols, and prints a summary:
files, modules, dependencies, cycles, files per layer, and unreadable files.
It enforces nothing and exits 0 unless something prevents the analysis itself.
It works without a contract.

| Option | Default | Meaning |
| --- | --- | --- |
| `--root <dir>` | `.` | Repository to analyze |
| `--format human\|json` | `human` | Output format |
| `--no-cache` | off | Do not write `.engintel/cache/` |

It writes only these two files:

- `.engintel/cache/graph.json`: every module and import edge.
- `.engintel/cache/symbols.json`: every exported function, class, type, and
  so on, with where it is declared.

Add `.engintel/cache/` to your `.gitignore`.

### Other

`engintel --help`, `engintel <command> --help`, `engintel --version`.

## 5. Exit codes

| Code | Meaning | Examples |
| --- | --- | --- |
| **0** | Pass | No blocking violations (warnings and advisories may still be printed) |
| **1** | Blocking violations | A forbidden import, a cycle, an unreadable or unparseable file |
| **2** | No verdict | Missing, invalid, or draft contract; invalid config; the analysis crashed or timed out; bad command-line options |

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
`contract` (file, policy version, hash), `scope`, `now`, and `engineVersion`.

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

## 10. Running it in CI

The GitHub Action arrives in Phase 2. Until then, any CI job can run the CLI.
Exit code 1 or 2 fails the job:

```sh
# In a job with Node 22 and your project's dependencies installed
git clone --depth 1 https://github.com/Arpitpatidar00/engintel.git "$RUNNER_TEMP/engintel"
(cd "$RUNNER_TEMP/engintel" && corepack enable && pnpm install --frozen-lockfile && pnpm build)
node "$RUNNER_TEMP/engintel/packages/cli/dist/bin.js" validate --root .
```

Phase 1 always checks the whole repository. Checking only the files a pull
request changed (`--changed`) arrives in Phase 2.

## 11. Troubleshooting

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

Error codes always appear on stderr as `engintel: error E_...: message`, and in
the JSON error report under `error.code`.

## What is not here yet

| Feature | Phase |
| --- | --- |
| Baselines: accept existing violations and fail only new ones | 2 |
| `--changed`: check only what a pull request changed | 2 |
| GitHub Action, SARIF output, required-check setup | 2 |
| Detecting pull requests that weaken the contract | 2 |
| `engintel init` to draft a contract from your folders | later |
| MCP server so AI coding agents can ask EngIntel before they write code | 3 |
| Symbol search, repair loop, tsc/ESLint/test orchestration | 4 to 6 |
| Enforcing `naming` rules | later |

For how the Phase 1 behaviour was decided, see `docs/phase-1-decisions.md`.
To test EngIntel itself, see `docs/testing.md`.
