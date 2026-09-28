# EngIntel GitHub Action

A required status check that fails a pull request when it adds architecture
violations, or weakens the architecture policy without architecture owners'
approval. It runs the same `engintel` CLI developers run, on the pull
request's own checkout, and trusts nothing else: not a result an agent
posted, not an MCP transcript, not a local artifact (FR-011).

What one run does:

1. Builds EngIntel from this repository at the commit you pinned (cached).
2. Runs `engintel validate --changed` against the merge base of the pull
   request: new violations fail, baselined debt does not, and edits to
   `.engintel/` that weaken the policy fail unless owners approved them.
3. Prints the human report in the log, writes a Markdown job summary, and
   produces a SARIF file you can upload for code scanning annotations.
4. Fails the job with the CLI's exit code: 0 pass, 1 violations, 2 no
   verdict (fail-closed).

## Set up the gate

A check that is not required is a suggestion. All four steps matter.

### 1. Add the workflow

Copy [`examples/engintel.yml`](examples/engintel.yml) to
`.github/workflows/engintel.yml` and pin the action to a reviewed commit:

```yaml
- id: engintel
  uses: Arpitpatidar00/engintel/packages/action@<commit sha>
```

Requirements:

- `on: pull_request` (never `pull_request_target`, which runs with secrets
  against untrusted code; the action refuses it).
- `actions/checkout` with `fetch-depth: 0`: `--changed` needs the merge base.
- Install your project's dependencies before the action (for example
  `npm ci --ignore-scripts`), so imports of packages resolve. Unresolved
  imports fail closed.
- The job's name (`architecture` in the example) is the status check
  context. Renaming the job breaks the ruleset.

### 2. Protect the policy files with CODEOWNERS

Add the lines from [`docs/templates/CODEOWNERS`](../../docs/templates/CODEOWNERS)
to `.github/CODEOWNERS`, with your architecture owners' team:

```
/.engintel/                 @your-org/architecture-owners
/.github/CODEOWNERS         @your-org/architecture-owners
/.github/workflows/         @your-org/architecture-owners
```

### 3. Require the check and code-owner review with a ruleset

Settings -> Rules -> Rulesets -> New branch ruleset, targeting your default
branch, with:

- **Require status checks to pass**: add `architecture`, and "Require
  branches to be up to date before merging".
- **Require a pull request before merging**: at least one approval, and
  **Require review from Code Owners**.
- No bypass actors, or only a small break-glass group.

As JSON (Settings -> Rules -> Rulesets -> Import):

```json
{
  "name": "engintel-gate",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [{ "context": "architecture" }]
      }
    },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "require_code_owner_review": true,
        "dismiss_stale_reviews_on_push": true,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    }
  ]
}
```

### 4. Create the approval labels

Create the labels `policy-change` and `baseline-change`, and let only
architecture owners apply them. With a label on the pull request, the
matching kind of weakening is reported as a warning instead of failing:

| Label | Approves |
| --- | --- |
| `policy-change` | Weakening `.engintel/architecture.json`, `config.json`, or `ignore`: removing or disabling a rule, adding or extending an exception, widening an allowlist |
| `baseline-change` | Adding entries to `.engintel/baseline.json` |

Labels are a statement of intent; CODEOWNERS review is the control. Dropping
a baseline entry whose violation still exists always fails, labeled or not.
The example workflow re-runs on `labeled` and `unlabeled` so the check
follows the label.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `working-directory` | `.` | Repository root to validate |
| `base` | `origin/<base branch>` on pull requests; empty on push | Ref to diff against. Empty validates everything. |
| `policy-change-label` | `policy-change` | Label that approves policy weakening |
| `baseline-change-label` | `baseline-change` | Label that approves baseline growth |
| `setup-node` | `true` | Install Node 22. Set `false` if the job already has Node 22. |

## Outputs

| Output | Meaning |
| --- | --- |
| `outcome` | `pass`, `fail`, or `error` |
| `exit-code` | `0`, `1`, or `2` |
| `sarif-file` | SARIF 2.1.0 report, for `github/codeql-action/upload-sarif` |
| `report-file` | The JSON report |

## Permissions

The action needs only `contents: read`. The optional SARIF upload needs
`security-events: write` and code scanning (public repositories, or GitHub
Advanced Security). The action does not comment on pull requests and never
writes to the repository. Fork pull requests work, because
`pull_request` runs them without secrets and nothing here needs one.

## Caching and the minutes budget

Two caches, both keyed without secrets (runner OS, versions, content
hashes, commit sha):

| Cache | Key | Contains |
| --- | --- | --- |
| EngIntel build | `engintel-build-v1-<os>-node<major>-<hash of EngIntel's sources and lockfile>` | `node_modules` and `dist` of the pinned EngIntel |
| Graph | `engintel-graph-v1-<os>-<engine version>-<hash of your lockfiles>-<commit sha>`, restoring the newest with the same prefix | `.engintel/cache/graph-cache.json` |

The graph cache is never an authority: EngIntel re-checks its own key
(tool versions, file list, manifests, install state) and re-analyzes every
file whose content changed. A cache file committed to the repository is
ignored, so a pull request cannot ship forged results.

Rough budget: the first run installs and builds EngIntel (about a minute,
mostly `pnpm install`). With the build cache it is a few seconds. Analysis
itself is seconds for small and medium repositories: on a developer machine
the golden fixtures validate in about half a second, and EngIntel's own
repository in under two.

## Running the same check locally

```sh
engintel validate --changed --base origin/main
```

A local run uses the same engine. It is advisory: the required check is the
authority, and it runs on GitHub's runner from the pull request's checkout.
