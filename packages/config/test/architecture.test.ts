// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { readFileSync, readdirSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { ArchitectureContractSchema, architectureJsonSchema } from "../src/index.js";

const testdata = new URL("../testdata/architecture/", import.meta.url);
const readJson = (relative: string): unknown => JSON.parse(readFileSync(new URL(relative, testdata), "utf8"));

const jsonSchema = architectureJsonSchema();
const validateWithJsonSchema = new Ajv2020({ strict: true, allErrors: true, validateFormats: false }).compile(
  jsonSchema,
);

type Case = { level: "schema" | "invariant"; path: (string | number)[]; why: string };
const cases = readJson("invalid/cases.json") as Record<string, Case>;
const validFiles = readdirSync(new URL("valid/", testdata)).filter((f) => f.endsWith(".json"));

describe("valid contracts", () => {
  test.each(validFiles)("%s is accepted by Zod and by the JSON Schema", (file) => {
    const input = readJson(`valid/${file}`);
    const zod = ArchitectureContractSchema.safeParse(input);
    expect(zod.error?.issues ?? []).toEqual([]);
    expect(validateWithJsonSchema(input), JSON.stringify(validateWithJsonSchema.errors)).toBe(true);
  });

  test("parsing applies documented defaults", () => {
    const contract = ArchitectureContractSchema.parse(readJson("valid/minimal.json"));
    expect(contract.opaqueImports).toBe("error");
    expect(contract.exceptions).toEqual([]);
    expect(contract.naming).toEqual([]);
    expect(contract.unsupportedPaths).toEqual([]);
    expect(contract.layers[0]?.intraAllowed).toBe(true);
    const rule = contract.rules[0];
    expect(rule?.kind).toBe("forbidden");
    if (rule?.kind === "forbidden") {
      expect(rule.enabled).toBe(true);
      expect(rule.direction).toBe("forward");
      expect(rule.ignoreTypeOnly).toBe(false);
      expect(rule.ignoreDynamic).toBe(false);
    }
  });
});

describe("invalid contracts", () => {
  test("cases.json describes every invalid file, and nothing else", () => {
    const files = readdirSync(new URL("invalid/", testdata))
      .filter((f) => f.endsWith(".json") && f !== "cases.json")
      .map((f) => f.replace(/\.json$/, ""));
    expect(files.sort()).toEqual(Object.keys(cases).sort());
  });

  test.each(Object.entries(cases))("%s is rejected (%o)", (name, { level, path }) => {
    const input = readJson(`invalid/${name}.json`);

    const zod = ArchitectureContractSchema.safeParse(input);
    expect(zod.success).toBe(false);
    const paths = zod.error?.issues.map((issue) => issue.path.slice(0, path.length)) ?? [];
    expect(paths, `expected an issue at ${JSON.stringify(path)}`).toContainEqual(path);

    // Structural defects must be caught by the JSON Schema too. Loader
    // invariants are beyond JSON Schema; asserting that the schema accepts
    // them keeps the "schema" / "invariant" labels honest.
    expect(validateWithJsonSchema(input)).toBe(level === "invariant");
  });
});

describe("architectureJsonSchema", () => {
  test("is strict at the top level", () => {
    expect(jsonSchema.additionalProperties).toBe(false);
    expect(jsonSchema.required).toEqual(
      expect.arrayContaining(["schemaVersion", "policyVersion", "status", "layers", "rules"]),
    );
  });

  test("matches the committed schema file", async () => {
    await expect(`${JSON.stringify(jsonSchema, null, 2)}\n`).toMatchFileSnapshot(
      "../schema/architecture.schema.json",
    );
  });
});
