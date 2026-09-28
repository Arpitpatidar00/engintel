// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goldenRoot, runCli } from "@engintel/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { assertBaselineWriteAllowed } from "../src/index.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyOf(id: string): string {
  const dir = mkdtempSync(join(tmpdir(), `engintel-cli-bl-${id}-`));
  created.push(dir);
  cpSync(join(goldenRoot(), id, "repo"), dir, { recursive: true });
  return dir;
}

const BASELINE = ".engintel/baseline.json";
const REFUND = 'import { OrderRepository } from "../repositories/order.repository";\nexport const r = new OrderRepository();\n';

describe("engintel baseline (ENG-038)", () => {
  test("show summarizes the ledger", async () => {
    const r = await runCli(["baseline", "show", "--format", "json"], { cwd: copyOf("existing-violations") });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ present: true, entries: 3, writtenBy: "fixture-owner", issues: [] });
  });

  test("adopting on a messy repository: write, then validate passes; a new violation still fails", async () => {
    const root = copyOf("existing-violations");
    rmSync(join(root, BASELINE));
    expect((await runCli(["validate", "--now", "2026-09-01"], { cwd: root })).exitCode).toBe(1);

    const dry = await runCli(["baseline", "write", "--written-by", "alice", "--now", "2026-09-01"], { cwd: root });
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("Dry run: nothing was written");
    expect((await runCli(["baseline", "show", "--format", "json"], { cwd: root })).stdout).toContain('"present": false');

    const wrote = await runCli(["baseline", "write", "--written-by", "alice", "--now", "2026-09-01", "--yes"], { cwd: root });
    expect(wrote.exitCode).toBe(0);
    expect(wrote.stdout).toContain("Wrote .engintel/baseline.json (write): 3 entries");
    expect((await runCli(["validate", "--now", "2026-09-01"], { cwd: root })).exitCode).toBe(0);

    writeFileSync(join(root, "src/controllers/refund.controller.ts"), REFUND);
    const next = await runCli(["validate", "--now", "2026-09-01", "--format", "json"], { cwd: root });
    expect(next.exitCode).toBe(1);
    expect((JSON.parse(next.stdout) as { diagnostics: { file: string }[] }).diagnostics.map((d) => d.file)).toEqual(["src/controllers/refund.controller.ts"]);
  });

  test("writing is deterministic", async () => {
    const root = copyOf("existing-violations");
    const args = ["baseline", "write", "--written-by", "alice", "--now", "2026-09-01", "--yes"];
    await runCli(args, { cwd: root });
    const first = readFileSync(join(root, BASELINE), "utf8");
    await runCli(args, { cwd: root });
    expect(readFileSync(join(root, BASELINE), "utf8")).toBe(first);
  });

  test("refuses fail-closed findings: unanalyzable files are never baselined", async () => {
    const r = await runCli(["baseline", "write", "--written-by", "alice", "--yes"], { cwd: copyOf("unreadable-files") });
    expect(r).toMatchObject({ exitCode: 2, errorCode: "E_BASELINE_FORBIDDEN" });
    expect(r.stderr).toContain("engintel.unanalyzable");
  });

  test("refuses agent authors and a missing author", async () => {
    const root = copyOf("existing-violations");
    expect((await runCli(["baseline", "write", "--written-by", "copilot", "--yes"], { cwd: root })).errorCode).toBe("E_BASELINE_INVALID");
    expect((await runCli(["baseline", "write", "--yes"], { cwd: root })).exitCode).toBe(2);
  });

  test("CI may not write the baseline unless a human workflow opts in", async () => {
    const root = copyOf("existing-violations");
    const refused = await runCli(["baseline", "write", "--written-by", "alice", "--yes"], { cwd: root, env: { CI: "true" } });
    expect(refused).toMatchObject({ exitCode: 2, errorCode: "E_BASELINE_WRITE_IN_CI" });
    const optedIn = await runCli(["baseline", "write", "--written-by", "alice", "--yes"], { cwd: root, env: { CI: "true", ENGINTEL_ALLOW_BASELINE_WRITE: "1" } });
    expect(optedIn.exitCode).toBe(0);
    // A dry run is always allowed.
    expect((await runCli(["baseline", "write", "--written-by", "alice"], { cwd: root, env: { CI: "true" } })).exitCode).toBe(0);
    expect(() => assertBaselineWriteAllowed({ CI: "1" })).toThrow();
    expect(() => assertBaselineWriteAllowed({ CI: "false" })).not.toThrow();
  });

  test("check catches a hand-edited entry", async () => {
    const root = copyOf("existing-violations");
    expect((await runCli(["baseline", "check"], { cwd: root })).exitCode).toBe(0);
    const path = join(root, BASELINE);
    writeFileSync(path, readFileSync(path, "utf8").replace("src/domain/money.ts", "src/domain/elsewhere.ts"));
    const r = await runCli(["baseline", "check"], { cwd: root });
    expect(r).toMatchObject({ exitCode: 2, errorCode: "E_BASELINE_INVALID" });
    expect(r.stderr).toContain("does not match its fields");
    expect((await runCli(["validate"], { cwd: root })).exitCode).toBe(2);
  });

  test("prune drops fixed debt only", async () => {
    const root = copyOf("existing-violations");
    rmSync(join(root, "src/controllers/legacy-billing.controller.ts"));
    const r = await runCli(["baseline", "prune", "--written-by", "alice", "--now", "2026-09-01", "--yes", "--format", "json"], { cwd: root });
    expect(JSON.parse(r.stdout)).toMatchObject({ written: true, mode: "prune", entries: 2, added: [], kept: 2 });
  });
});
