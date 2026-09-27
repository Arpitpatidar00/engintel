// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { describe, expect, test } from "vitest";
import {
  DiagnosticSchema,
  FORBIDDEN_DIAGNOSTIC_KEYS,
  diagnosticJsonSchema,
  type Diagnostic,
} from "../src/index.js";

const valid: Diagnostic = {
  schemaVersion: 1,
  identity: "a".repeat(64),
  adapter: "architecture",
  ruleId: "no-controller-to-repository",
  severity: "error",
  blocking: true,
  file: "src/controllers/order.controller.ts",
  range: { start: { line: 3, column: 1 }, end: { line: 3, column: 58 } },
  message: "controllers may not import repositories",
  why: "Do not skip the service layer. Inject a service and call it.",
  edge: {
    source: "src/controllers/order.controller.ts",
    target: "src/repositories/order.repository.ts",
    kind: "import",
  },
  suggest: {
    kind: "use-layer",
    layers: ["controllers", "services", "repositories"],
    explanation: "Import OrderService from src/services/order.service.ts instead.",
  },
};

function accepts(input: unknown): boolean {
  return DiagnosticSchema.safeParse(input).success;
}

describe("DiagnosticSchema", () => {
  test("accepts a complete architecture diagnostic", () => {
    expect(DiagnosticSchema.parse(valid)).toEqual(valid);
  });

  test("accepts a project-level diagnostic with an explicit no-alternative", () => {
    const { range: _range, edge: _edge, ...rest } = valid;
    expect(
      accepts({
        ...rest,
        adapter: "tsc",
        ruleId: "TS6053",
        file: null,
        suggest: { kind: "none", explanation: "Fix the tsconfig reference." },
      }),
    ).toBe(true);
  });

  test.each(FORBIDDEN_DIAGNOSTIC_KEYS)("rejects a %s field (no source text in diagnostics)", (key) => {
    expect(accepts({ ...valid, [key]: "const secret = 1;" })).toBe(false);
  });

  test("forbidden keys are not part of the schema shape", () => {
    const shapeKeys = Object.keys(DiagnosticSchema.shape);
    for (const key of FORBIDDEN_DIAGNOSTIC_KEYS) expect(shapeKeys).not.toContain(key);
  });

  test("rejects any unknown field", () => {
    expect(accepts({ ...valid, approved: true })).toBe(false);
  });

  test.each([
    ["schemaVersion 2", { schemaVersion: 2 }],
    ["uppercase identity", { identity: "A".repeat(64) }],
    ["short identity", { identity: "abc" }],
    ["unknown adapter", { adapter: "llm" }],
    ["backslash path", { file: "src\\controllers\\order.controller.ts" }],
    ["absolute path", { file: "/repo/src/a.ts" }],
    ["escaping path", { file: "../outside.ts" }],
    ["empty message", { message: "" }],
    ["missing suggest", { suggest: undefined }],
    ["warning that blocks", { severity: "warning", blocking: true }],
    ["advisory that blocks", { severity: "advisory", blocking: true }],
    ["range without file", { file: null }],
    ["range end before start", { range: { start: { line: 5, column: 1 }, end: { line: 4, column: 1 } } }],
    ["zero-based line", { range: { start: { line: 0, column: 1 }, end: { line: 1, column: 1 } } }],
    ["empty external node", { edge: { ...valid.edge, target: "external:" } }],
    ["edge escaping root", { edge: { ...valid.edge, target: "../x.ts" } }],
    ["unknown edge kind", { edge: { ...valid.edge, kind: "call" } }],
  ])("rejects %s", (_name, patch) => {
    expect(accepts({ ...valid, ...patch })).toBe(false);
  });

  test.each(["external:lodash", "core:fs", "unresolved:./missing-helper", "<missing>", "<unanalyzable>"])(
    "accepts edge target %j",
    (target) => {
      expect(accepts({ ...valid, edge: { ...valid.edge, target } })).toBe(true);
    },
  );

  test("advisory findings are accepted when they do not block", () => {
    expect(accepts({ ...valid, adapter: "jscpd", severity: "advisory", blocking: false })).toBe(true);
  });
});

describe("diagnosticJsonSchema", () => {
  const schema = diagnosticJsonSchema();

  test("is strict and requires the explainability fields", () => {
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(
      expect.arrayContaining(["schemaVersion", "identity", "ruleId", "message", "why", "suggest"]),
    );
  });

  test("matches the committed schema file", async () => {
    await expect(`${JSON.stringify(schema, null, 2)}\n`).toMatchFileSnapshot(
      "../schema/diagnostic.schema.json",
    );
  });
});
