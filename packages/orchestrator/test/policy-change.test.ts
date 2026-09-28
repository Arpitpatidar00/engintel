// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goldenRoot } from "@engintel/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { validateRepository, writeBaseline } from "../src/index.js";

/**
 * ENG-012 through git: every way an agent could turn a red pull request
 * green by editing policy instead of code must itself fail, unless owners
 * approved it. Legitimate edits still pass.
 */

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

function pr(id: string): string {
  const root = mkdtempSync(join(tmpdir(), `engintel-pc-${id}-`));
  created.push(root);
  cpSync(join(goldenRoot(), id, "repo"), root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "pr");
  return root;
}

const now = "2026-09-01";
const CONTRACT = ".engintel/architecture.json";
const REFUND = 'import { OrderRepository } from "../repositories/order.repository";\nexport const r = new OrderRepository();\n';

function editContract(root: string, edit: (c: Record<string, unknown>) => void): void {
  const path = join(root, CONTRACT);
  const contract = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  edit(contract);
  writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`);
}

const rules = (r: Awaited<ReturnType<typeof validateRepository>>) => r.diagnostics.map((d) => `${d.ruleId}${d.blocking ? "" : " (not blocking)"}: ${d.message}`);

describe("policy weakening through git (ENG-012)", () => {
  test("deleting the rule that blocks a new import fails; owners' approval lets it through", async () => {
    const root = pr("valid-architecture");
    writeFileSync(join(root, "src/controllers/refund.controller.ts"), REFUND);
    editContract(root, (c) => (c["rules"] = (c["rules"] as { id: string }[]).filter((r) => r.id !== "no-controller-to-repository")));
    const r = await validateRepository({ root, now, changedSince: "main" });
    expect(rules(r)).toEqual(["engintel.policy-weakening: Policy weakening in .engintel/architecture.json: rule 'no-controller-to-repository' (forbidden) removed."]);
    const approved = await validateRepository({ root, now, changedSince: "main", approvals: { policyChange: true } });
    expect(approved.outcome).toBe("pass");
    expect(approved.diagnostics.map((d) => d.severity)).toEqual(["warning"]);
  });

  test("an exception for the PR's own violation fails", async () => {
    const root = pr("valid-architecture");
    writeFileSync(join(root, "src/controllers/refund.controller.ts"), REFUND);
    editContract(root, (c) => {
      c["exceptions"] = [
        {
          id: "ex-refund",
          ruleId: "no-controller-to-repository",
          source: "src/controllers/refund.controller.ts",
          target: "*",
          reason: "fix ci, will clean up later probably",
          owner: "@someone",
          addedAt: "2026-09-01",
          expiresAt: "2036-09-01",
        },
      ];
    });
    const r = await validateRepository({ root, now, changedSince: "main" });
    expect(r.outcome).toBe("fail");
    expect(rules(r)).toEqual([expect.stringContaining("exception 'ex-refund' added for rule 'no-controller-to-repository'")]);
  });

  test("excluding the violating file in config.json, or listing it in .engintel/ignore, fails", async () => {
    const viaConfig = pr("valid-architecture");
    writeFileSync(join(viaConfig, "src/controllers/refund.controller.ts"), REFUND);
    writeFileSync(join(viaConfig, ".engintel/config.json"), JSON.stringify({ schemaVersion: 1, exclude: ["src/controllers/refund.controller.ts"] }));
    expect(rules(await validateRepository({ root: viaConfig, now, changedSince: "main" }))).toEqual([
      "engintel.policy-weakening: Policy weakening in .engintel/config.json: exclude skips 'src/controllers/refund.controller.ts'.",
    ]);
    const viaIgnore = pr("valid-architecture");
    writeFileSync(join(viaIgnore, "src/controllers/refund.controller.ts"), REFUND);
    writeFileSync(join(viaIgnore, ".engintel/ignore"), "src/controllers/refund.controller.ts\n");
    expect(rules(await validateRepository({ root: viaIgnore, now, changedSince: "main" }))).toEqual([
      "engintel.policy-weakening: Policy weakening in .engintel/ignore: ignores 'src/controllers/refund.controller.ts'.",
    ]);
  });

  test("setting the contract to draft fails", async () => {
    const root = pr("valid-architecture");
    editContract(root, (c) => (c["status"] = "draft"));
    // A draft is refused outright (exit 2); allowDraft previews it to show the weakening too.
    const r = await validateRepository({ root, now, changedSince: "main", allowDraft: true });
    expect(rules(r)).toEqual(["engintel.policy-weakening: Policy weakening in .engintel/architecture.json: status active -> draft (the contract is no longer enforced)."]);
  });

  test("growing the baseline to cover the PR's own violation fails twice over; approval covers both", async () => {
    const root = pr("existing-violations");
    writeFileSync(join(root, "src/controllers/refund.controller.ts"), REFUND);
    await writeBaseline({ root, mode: "write", writtenBy: "mallory", now });
    const r = await validateRepository({ root, now, changedSince: "main" });
    expect(r.diagnostics.map((d) => d.ruleId).sort()).toEqual(["engintel.policy-weakening", "no-controller-to-repository"]);
    const approved = await validateRepository({ root, now, changedSince: "main", approvals: { baselineChange: true } });
    expect(approved.outcome).toBe("pass");
  });

  test("dropping a baseline entry whose violation still exists fails, even with approval", async () => {
    const root = pr("existing-violations");
    const path = join(root, ".engintel/baseline.json");
    const file = JSON.parse(readFileSync(path, "utf8")) as { entries: unknown[] };
    file.entries = file.entries.slice(1);
    writeFileSync(path, JSON.stringify(file, null, 2));
    for (const approvals of [{}, { baselineChange: true, policyChange: true }]) {
      const r = await validateRepository({ root, now, changedSince: "main", approvals });
      expect(r.diagnostics.map((d) => d.ruleId)).toEqual(["engintel.baseline-drop"]);
      expect(r.outcome).toBe("fail");
    }
  });

  test("pruning fixed debt, tightening, and wording edits pass", async () => {
    const root = pr("existing-violations");
    rmSync(join(root, "src/controllers/legacy-billing.controller.ts"));
    await writeBaseline({ root, mode: "prune", writtenBy: "alice", now });
    editContract(root, (c) => {
      c["description"] = "Reworded.";
      (c["rules"] as Record<string, unknown>[]).push({
        id: "no-domain-to-controllers",
        kind: "forbidden",
        severity: "error",
        from: { layer: "domain" },
        to: { layer: "controllers" },
        comment: "Domain stays pure.",
      });
    });
    const r = await validateRepository({ root, now, changedSince: "main" });
    expect(r.outcome).toBe("pass");
    expect(rules(r)).toEqual([
      "engintel.policy-change (not blocking): Policy tightening in .engintel/architecture.json: rule 'no-domain-to-controllers' (forbidden) added.",
      "engintel.policy-change (not blocking): Policy tightening in .engintel/baseline.json: baseline drops fixed no-controller-to-repository: src/controllers/legacy-billing.controller.ts -> src/repositories/order.repository.ts.",
    ]);
  });

  test("no policy edits: the section is present and empty", async () => {
    const root = pr("valid-architecture");
    writeFileSync(join(root, "src/domain/extra.ts"), "export const x = 1;\n");
    const r = await validateRepository({ root, now, changedSince: "main" });
    expect(r.policyChange).toEqual({ items: [] });
  });
});
