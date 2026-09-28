// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASELINE_PATH, parseBaseline } from "@engintel/config";
import type { EvaluationResult } from "@engintel/policy";
import { goldenRoot } from "@engintel/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { applyBaselineContext } from "../src/baseline.js";
import { ToolError, buildBaseline, validateRepository, writeBaseline } from "../src/index.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "ignore" });

function copyOf(id: string): string {
  const dir = mkdtempSync(join(tmpdir(), `engintel-bl-${id}-`));
  created.push(dir);
  cpSync(join(goldenRoot(), id, "repo"), dir, { recursive: true });
  return dir;
}

function prFrom(id: string): string {
  const root = copyOf(id);
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "pr");
  return root;
}

async function errorCode(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (error instanceof ToolError) return error.code;
    throw error;
  }
  return "no error";
}

const now = "2026-09-01";
const REFUND = 'import { OrderRepository } from "../repositories/order.repository";\nexport const r = new OrderRepository();\n';

describe("buildBaseline (ENG-009)", () => {
  test("records exactly the blocking, eligible findings; deterministic", async () => {
    const root = copyOf("existing-violations");
    const a = await buildBaseline({ root, mode: "write", writtenBy: "alice", now });
    const b = await buildBaseline({ root, mode: "write", writtenBy: "alice", now });
    expect(a.text).toBe(b.text);
    expect(a.baseline.entries.map((e) => e.ruleId).sort()).toEqual(["no-controller-to-repository", "no-repository-upward", "no-upward-from-domain"]);
    expect(a.byRule).toHaveLength(3);
  });

  test("keeps firstSeenAt and annotations of entries that still occur", async () => {
    const root = copyOf("existing-violations");
    const path = join(root, BASELINE_PATH);
    const file = JSON.parse(readFileSync(path, "utf8")) as { entries: Record<string, unknown>[] };
    file.entries[0] = { ...file.entries[0], owner: "@payments", ticket: "PAY-1" };
    writeFileSync(path, JSON.stringify(file));
    const rewritten = await buildBaseline({ root, mode: "write", writtenBy: "alice", now: "2026-12-01" });
    const kept = rewritten.baseline.entries.find((e) => e.owner === "@payments");
    expect(kept).toMatchObject({ firstSeenAt: "2026-03-02", lastSeenAt: "2026-12-01", ticket: "PAY-1" });
    expect(rewritten.added).toEqual([]);
  });

  test("refuses fail-closed findings and agent authors", async () => {
    const broken = copyOf("unreadable-files");
    expect(await errorCode(buildBaseline({ root: broken, mode: "write", writtenBy: "alice", now }))).toBe("E_BASELINE_FORBIDDEN");
    expect(await errorCode(buildBaseline({ root: copyOf("existing-violations"), mode: "write", writtenBy: "copilot", now }))).toBe("E_BASELINE_INVALID");
  });

  test("prune drops fixed debt and adds nothing", async () => {
    const root = copyOf("existing-violations");
    rmSync(join(root, "src/controllers/legacy-billing.controller.ts"));
    writeFileSync(join(root, "src/controllers/refund.controller.ts"), REFUND);
    const pruned = await writeBaseline({ root, mode: "prune", writtenBy: "alice", now });
    expect(pruned.removed).toHaveLength(1);
    expect(pruned.added).toEqual([]);
    expect(pruned.baseline.entries).toHaveLength(2);
  });
});

describe("validate with a baseline (ENG-009)", () => {
  test("full run: stale entries are reported, never failing", async () => {
    const root = copyOf("existing-violations");
    rmSync(join(root, "src/controllers/legacy-billing.controller.ts"));
    const r = await validateRepository({ root, now });
    expect(r.outcome).toBe("pass");
    expect(r.baseline).toMatchObject({ comparedWith: "working-copy", entries: 3, suppressed: 2, stale: [expect.stringMatching(/^[0-9a-f]{64}$/)] });
    expect(r.notices.join("\n")).toContain("1 baseline entry no longer occurs");
  });

  test("a tampered baseline fails closed", async () => {
    const root = copyOf("existing-violations");
    const path = join(root, BASELINE_PATH);
    writeFileSync(path, readFileSync(path, "utf8").replace("src/domain/money.ts", "src/domain/other.ts"));
    expect(await errorCode(validateRepository({ root, now }))).toBe("E_BASELINE_INVALID");
  });

  test("--changed: a PR cannot baseline its own new violation", async () => {
    const root = prFrom("existing-violations");
    writeFileSync(join(root, "src/controllers/refund.controller.ts"), REFUND);
    await writeBaseline({ root, mode: "write", writtenBy: "mallory", now });
    const r = await validateRepository({ root, now, changedSince: "main" });
    expect(r.baseline?.comparedWith).toBe("merge-base");
    expect(r.diagnostics.map((d) => d.file)).toEqual(["src/controllers/refund.controller.ts"]);
    const approved = await validateRepository({ root, now, changedSince: "main", approvals: { baselineChange: true } });
    expect(approved.diagnostics).toEqual([]);
    expect(approved.counts.suppressedByBaseline).toBe(1);
  });

  test("--changed: legacy debt in a touched file stays suppressed by the merge-base baseline", async () => {
    const root = prFrom("existing-violations");
    const legacy = join(root, "src/controllers/legacy-billing.controller.ts");
    writeFileSync(legacy, `// touched\n${readFileSync(legacy, "utf8")}`);
    const r = await validateRepository({ root, now, changedSince: "main" });
    expect(r.outcome).toBe("pass");
    expect(r.counts.suppressedByBaseline).toBe(1);
  });
});

describe("merge-base race rule (doc 08, section 7)", () => {
  const finding = (identity: string, source: string, target: string) => ({ identity, ruleId: "r", source, target, cycleSignature: null, severity: "error" as const, blocking: true });
  const baselineWith = (...ids: string[]) =>
    parseBaseline({
      schemaVersion: 1,
      engineIdentityVersion: 1,
      policyVersionAtWrite: "1.0.0",
      writtenAt: now,
      writtenBy: "alice",
      entries: ids.map((identity) => ({ identity, ruleId: "r", source: "src/a.ts", target: "src/b.ts", cycleSignature: null, firstSeenAt: now, lastSeenAt: now })),
    });

  test("debt baselined on the default branch after the fork passes only if the PR does not touch it", () => {
    const x = "a".repeat(64);
    const y = "b".repeat(64);
    const result = {
      outcome: "fail",
      counts: { errors: 2, warnings: 0, advisories: 0, suppressedByException: 0, suppressedByBaseline: 0, unanalyzable: 0 },
      diagnostics: [x, y].map((identity) => ({ identity, blocking: true, severity: "error" })),
      exceptionsApplied: [],
      unanalyzable: [],
      stats: { files: 0, filesInScope: 0, edges: 0, edgesEvaluated: 0 },
      findings: [finding(x, "src/untouched.ts", "src/b.ts"), finding(y, "src/changed.ts", "src/b.ts")],
    } as unknown as EvaluationResult;
    const context = { head: null, reference: null, comparedWith: "merge-base" as const, defaultBranch: baselineWith(x, y) };
    const scope = { mode: "changed" as const, changedFiles: ["src/changed.ts"], contractChanged: false };
    const { result: applied } = applyBaselineContext(result, context, { scope, baselineChangeApproved: false });
    expect(applied.diagnostics.map((d) => d.identity)).toEqual([y]);
  });
});
