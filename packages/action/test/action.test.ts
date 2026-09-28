// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliBinPath, findWorkspaceRoot, goldenRoot } from "@engintel/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { parse } from "yaml";
import { computeKeys } from "../scripts/cache-keys.mjs";

/**
 * ENG-011 / ENG-040. The action is not run against live GitHub here (doc 24:
 * "a recorded workflow fixture; not live GitHub"): action.yml and the
 * example workflow are checked structurally, and scripts/run.sh, which holds
 * all the logic, runs under a simulated GitHub Actions environment against
 * real git repositories.
 */

const workspaceRoot = findWorkspaceRoot();
const actionDir = join(workspaceRoot, "packages", "action");
const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Step = { id?: string; if?: string; uses?: string; run?: string; shell?: string; env?: Record<string, string>; with?: Record<string, unknown> };
const action = parse(readFileSync(join(actionDir, "action.yml"), "utf8")) as {
  runs: { using: string; steps: Step[] };
  inputs: Record<string, unknown>;
  outputs: Record<string, { value: string }>;
};
const example = parse(readFileSync(join(actionDir, "examples", "engintel.yml"), "utf8")) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, { steps: Step[]; permissions: Record<string, string> }>;
};

const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;

describe("action.yml (ENG-011)", () => {
  test("is a composite action whose every third-party step is pinned to a commit sha", () => {
    expect(action.runs.using).toBe("composite");
    for (const step of action.runs.steps.filter((s) => s.uses)) expect(step.uses, step.uses).toMatch(PINNED);
  });

  test("never touches secrets, and maps owner labels to approvals", () => {
    const text = readFileSync(join(actionDir, "action.yml"), "utf8");
    expect(text).not.toMatch(/secrets\./);
    const validate = action.runs.steps.find((s) => s.id === "validate");
    expect(validate?.run).toBe('bash "$GITHUB_ACTION_PATH/scripts/run.sh"');
    expect(validate?.env?.["POLICY_CHANGE_APPROVED"]).toContain("inputs.policy-change-label");
    expect(validate?.env?.["BASELINE_CHANGE_APPROVED"]).toContain("inputs.baseline-change-label");
  });

  test("saves the graph cache even on failure, then fails the job with the CLI's exit code", () => {
    const steps = action.runs.steps;
    const last = steps[steps.length - 1];
    expect(last?.run).toBe('exit "${EXIT_CODE:-2}"');
    expect(last?.env?.["EXIT_CODE"]).toBe("${{ steps.validate.outputs.exit-code }}");
    const save = steps[steps.length - 2];
    expect(save).toMatchObject({ if: "always()", uses: expect.stringMatching(/^actions\/cache\/save@/) });
    expect(Object.keys(action.outputs).sort()).toEqual(["exit-code", "outcome", "report-file", "sarif-file"]);
  });

  test("the example workflow: pull_request (never _target), read-only, full history, pinned", () => {
    expect(Object.keys(example.on)).toContain("pull_request");
    expect(Object.keys(example.on)).not.toContain("pull_request_target");
    expect(example.permissions).toEqual({ contents: "read" });
    const job = example.jobs["architecture"];
    expect(job).toBeDefined();
    const checkout = job?.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with).toMatchObject({ "fetch-depth": 0, "persist-credentials": false });
    for (const step of job?.steps.filter((s) => s.uses && !s.uses.includes("<sha>")) ?? []) expect(step.uses).toMatch(PINNED);
  });
});

describe("cache keys (ENG-040)", () => {
  const input = { engintelRoot: workspaceRoot, workspace: join(goldenRoot(), "valid-architecture", "repo"), os: "Linux", nodeVersion: "v22.22.0", sha: "a".repeat(40) };

  test("deterministic, and built only from OS, versions, hashes, and the commit", () => {
    const keys = computeKeys(input);
    expect(computeKeys(input)).toEqual(keys);
    expect(keys.buildKey).toMatch(/^engintel-build-v1-Linux-node22-[0-9a-f]{64}$/);
    expect(keys.graphKey).toBe(`${keys.graphRestorePrefix}${"a".repeat(40)}`);
    expect(keys.graphRestorePrefix).toMatch(/^engintel-graph-v1-Linux-0\.1\.0-[0-9a-f]{32}-$/);
  });

  test("no environment value can leak into a key", () => {
    process.env["GITHUB_TOKEN"] = "ghp_shouldneverappear";
    try {
      expect(JSON.stringify(computeKeys(input))).not.toContain("ghp_");
    } finally {
      delete process.env["GITHUB_TOKEN"];
    }
  });

  test("a lockfile change moves the graph key; a commit change keeps the restore prefix", () => {
    const repo = mkdtempSync(join(tmpdir(), "engintel-keys-"));
    created.push(repo);
    const before = computeKeys({ ...input, workspace: repo });
    writeFileSync(join(repo, "package-lock.json"), "{}");
    const after = computeKeys({ ...input, workspace: repo });
    expect(after.graphRestorePrefix).not.toBe(before.graphRestorePrefix);
    expect(computeKeys({ ...input, workspace: repo, sha: "b".repeat(40) }).graphRestorePrefix).toBe(after.graphRestorePrefix);
  });

  test("runs as a script and writes GitHub step outputs", () => {
    const dir = mkdtempSync(join(tmpdir(), "engintel-out-"));
    created.push(dir);
    const out = join(dir, "output");
    execFileSync(process.execPath, [join(actionDir, "scripts", "cache-keys.mjs")], {
      env: { PATH: process.env["PATH"] ?? "", ENGINTEL_HOME: workspaceRoot, ENGINTEL_WORKSPACE: input.workspace, RUNNER_OS: "Linux", GITHUB_SHA: "c".repeat(40), GITHUB_OUTPUT: out },
    });
    expect(readFileSync(out, "utf8")).toMatch(/^build-key=engintel-build-v1-Linux-node\d+-[0-9a-f]{64}\ngraph-key=.+c{40}\ngraph-restore-prefix=.+-\n$/);
  });
});

// Each test spawns git and several CLI processes; allow for a loaded CI machine.
describe("scripts/run.sh under a simulated GitHub Actions run", { timeout: 60_000 }, () => {
  const GIT_ENV = {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };

  /** A workspace like actions/checkout leaves it: the PR branch, with origin/main fetched. */
  function prWorkspace(golden: string, change: (root: string) => void): string {
    const root = mkdtempSync(join(tmpdir(), `engintel-gha-${golden}-`));
    created.push(root);
    cpSync(join(goldenRoot(), golden, "repo"), root, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: { ...process.env, ...GIT_ENV }, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("checkout", "-q", "-b", "pr");
    change(root);
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", "pr");
    return root;
  }

  function runAction(workspace: string, env: Record<string, string> = {}) {
    const temp = mkdtempSync(join(tmpdir(), "engintel-runner-"));
    created.push(temp);
    const output = join(temp, "output");
    const summary = join(temp, "summary.md");
    writeFileSync(output, "");
    writeFileSync(summary, "");
    const result = spawnSync("bash", [join(actionDir, "scripts", "run.sh")], {
      cwd: workspace,
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"] ?? "",
        ...GIT_ENV,
        ENGINTEL_BIN: cliBinPath(),
        RUNNER_TEMP: temp,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_BASE_REF: "main",
        INPUT_WORKING_DIRECTORY: ".",
        ...env,
      },
    });
    const outputs = Object.fromEntries(
      readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    return { status: result.status, log: `${result.stdout}${result.stderr}`, outputs, summary: readFileSync(summary, "utf8") };
  }

  const SKIP = 'import { OrderRepository } from "../repositories/order.repository";\nexport const r = new OrderRepository();\n';

  test("a pull request with a new layer violation fails, with summary and SARIF", () => {
    const ws = prWorkspace("valid-architecture", (root) => writeFileSync(join(root, "src/controllers/refund.controller.ts"), SKIP));
    const run = runAction(ws);
    expect(run.status).toBe(0); // the script records; the action's last step fails the job
    expect(run.outputs).toMatchObject({ "exit-code": "1", outcome: "fail" });
    expect(run.log).toContain("EngIntel validate: FAIL (1 error");
    expect(run.summary).toContain("## EngIntel: FAIL");
    const sarif = JSON.parse(readFileSync(run.outputs["sarif-file"] ?? "", "utf8")) as { version: string; runs: { results: unknown[] }[] };
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0]?.results).toHaveLength(1);
  });

  test("a clean pull request on a repository with baselined debt passes", () => {
    const ws = prWorkspace("existing-violations", (root) => writeFileSync(join(root, "src/domain/extra.ts"), "export const x = 1;\n"));
    expect(runAction(ws).outputs).toMatchObject({ "exit-code": "0", outcome: "pass" });
  });

  test("deleting the blocking rule fails, unless the owners' label is present", () => {
    const ws = prWorkspace("valid-architecture", (root) => {
      writeFileSync(join(root, "src/controllers/refund.controller.ts"), SKIP);
      const path = join(root, ".engintel/architecture.json");
      const contract = JSON.parse(readFileSync(path, "utf8")) as { rules: { id: string }[] };
      contract.rules = contract.rules.filter((r) => r.id !== "no-controller-to-repository");
      writeFileSync(path, JSON.stringify(contract, null, 2));
    });
    expect(runAction(ws).outputs["exit-code"]).toBe("1");
    expect(runAction(ws, { POLICY_CHANGE_APPROVED: "true" }).outputs["exit-code"]).toBe("0");
  });

  test("the recorded log, summary, and SARIF never contain source text", () => {
    const ws = prWorkspace("prompt-injection", (root) => {
      const file = join(root, "src/controllers/admin.controller.ts");
      writeFileSync(file, `${readFileSync(file, "utf8")}\n`);
    });
    const run = runAction(ws);
    expect(run.outputs["exit-code"]).toBe("1");
    for (const text of [run.log, run.summary, readFileSync(run.outputs["sarif-file"] ?? "", "utf8")]) {
      expect(text).not.toMatch(/SYSTEM OVERRIDE|ignore previous instructions|approved: true|mergeable/i);
    }
  });

  test("no verdict fails closed: a broken contract, a missing base, pull_request_target", () => {
    const broken = prWorkspace("valid-architecture", (root) => writeFileSync(join(root, ".engintel/architecture.json"), "{"));
    expect(runAction(broken).outputs).toMatchObject({ "exit-code": "2", outcome: "error" });
    const ws = prWorkspace("valid-architecture", () => undefined);
    expect(runAction(ws, { GITHUB_BASE_REF: "no-such-branch" }).outputs["exit-code"]).toBe("2");
    const target = runAction(ws, { GITHUB_EVENT_NAME: "pull_request_target" });
    expect(target.outputs).toMatchObject({ "exit-code": "2", outcome: "error" });
    expect(target.log).toContain("E_UNSAFE_EVENT");
    expect(existsSync(join(ws, ".engintel", "cache", "graph-cache.json"))).toBe(false);
  });
});
