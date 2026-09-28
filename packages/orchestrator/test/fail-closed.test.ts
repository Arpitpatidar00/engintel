// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goldenRoot } from "@engintel/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { validateRepository } from "../src/index.js";

/**
 * ENG-036 / FR-020: a changed file EngIntel cannot analyze fails closed; an
 * unchanged one does not block. Both sides of the intersection
 * (changed x not-ok) are tested, through an explicit scope and through git.
 */

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) {
    try {
      execFileSync("chmod", ["-R", "u+rwX", dir]);
    } catch {
      // best effort
    }
    rmSync(dir, { recursive: true, force: true });
  }
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
  const dir = mkdtempSync(join(tmpdir(), `engintel-fc-${id}-`));
  created.push(dir);
  cpSync(join(goldenRoot(), id, "repo"), dir, { recursive: true });
  return dir;
}

const now = "2026-09-01";
const changed = (changedFiles: string[]) => ({ mode: "changed" as const, changedFiles, contractChanged: false });
const rules = (r: Awaited<ReturnType<typeof validateRepository>>) => r.diagnostics.map((d) => `${d.ruleId} ${d.file ?? ""}`);
// Root can read a chmod 000 file, so the permission case only means something for a normal user.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("fail closed on unanalyzable changed files (ENG-036)", () => {
  test.skipIf(isRoot)("a permission-denied changed file blocks; unchanged it does not", async () => {
    const root = copyOf("valid-architecture");
    writeFileSync(join(root, "src/services/secret.service.ts"), "export const s = 1;\n");
    chmodSync(join(root, "src/services/secret.service.ts"), 0o000);
    const inDiff = await validateRepository({ root, now, scope: changed(["src/services/secret.service.ts"]) });
    expect(rules(inDiff)).toEqual(["engintel.unanalyzable src/services/secret.service.ts"]);
    expect(inDiff.diagnostics[0]?.message).toContain("(permission)");
    const outside = await validateRepository({ root, now, scope: changed(["src/domain/order.ts"]) });
    expect(outside.outcome).toBe("pass");
    expect(outside.unanalyzable).toEqual([{ path: "src/services/secret.service.ts", reason: "permission", inScope: false, allowlisted: false }]);
  });

  test("an unchanged unreadable file in a large repository does not block a change elsewhere", async () => {
    const root = copyOf("valid-architecture");
    mkdirSync(join(root, "src/domain/generated"), { recursive: true });
    for (let i = 0; i < 400; i++) writeFileSync(join(root, `src/domain/generated/m${i}.ts`), `export const v${i} = ${i};\n`);
    writeFileSync(join(root, "src/domain/generated/blob.ts"), Buffer.from([0x00, 0x01, 0x02]));
    const r = await validateRepository({ root, now, scope: changed(["src/services/order.service.ts"]) });
    expect(r.outcome).toBe("pass");
    expect(r.stats.files).toBe(405);
    expect(r.unanalyzable.map((u) => [u.path, u.inScope])).toEqual([["src/domain/generated/blob.ts", false]]);
  });

  test("through git: changing a file into something unparseable blocks", async () => {
    const root = copyOf("valid-architecture");
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    git(root, "checkout", "-q", "-b", "pr");
    writeFileSync(join(root, "src/services/order.service.ts"), "export class OrderService {\n  broken(\n");
    writeFileSync(join(root, "src/services/new.service.ts"), Buffer.from([0x00, 0xff]));
    const r = await validateRepository({ root, now, changedSince: "main" });
    expect(rules(r)).toEqual(["engintel.unanalyzable src/services/new.service.ts", "engintel.unanalyzable src/services/order.service.ts"]);
    expect(r.exitCode).toBe(1);
  });

  test("an unparseable file is never analyzed as a pass by cruiser either: its imports are unknown, not absent", async () => {
    const root = copyOf("valid-architecture");
    // A skip-layer import hidden in a file with a syntax error.
    writeFileSync(join(root, "src/controllers/sneaky.controller.ts"), 'import { OrderRepository } from "../repositories/order.repository";\nexport const x = (\n');
    const r = await validateRepository({ root, now, scope: changed(["src/controllers/sneaky.controller.ts"]) });
    expect(rules(r)).toEqual(["engintel.unanalyzable src/controllers/sneaky.controller.ts"]);
    expect(r.outcome).toBe("fail");
  });
});
