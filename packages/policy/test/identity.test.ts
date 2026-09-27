// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  IDENTITY_SEPARATOR,
  IDENTITY_VERSION,
  IdentityError,
  identityPayload,
  normalizeCycleSignature,
  normalizeIdentityNode,
  violationIdentity,
  type IdentityInput,
} from "../src/index.js";

interface Vector {
  id: number;
  name: string;
  input: IdentityInput;
  normalized: string[];
  identity: string;
}
const file = JSON.parse(readFileSync(new URL("../testdata/identity-vectors.json", import.meta.url), "utf8")) as {
  identityVersion: number;
  algorithm: string;
  separator: string;
  vectors: Vector[];
};

/**
 * Vectors 1..FROZEN_COUNT are frozen. Appending new vectors keeps this digest;
 * editing, reordering, or deleting a frozen vector breaks it. Update the
 * constants only together with a new IDENTITY_VERSION.
 */
const FROZEN_COUNT = 19;
const FROZEN_DIGEST = "9184ea27fbea22964778b93d8b4ae703c4145f8453c0af923b92a05f0514b0fc";

describe("identity-vectors.json (ENG-035)", () => {
  test("header matches the implementation", () => {
    expect(file.identityVersion).toBe(IDENTITY_VERSION);
    expect(IDENTITY_VERSION).toBe(1);
    expect(file.algorithm).toBe("sha256");
    expect(file.separator).toBe(IDENTITY_SEPARATOR);
    expect(IDENTITY_SEPARATOR).toBe("\u001f");
  });

  test("the file is append-only: ids are sequential and frozen vectors are unchanged", () => {
    expect(file.vectors.map((v) => v.id)).toEqual(file.vectors.map((_, i) => i + 1));
    expect(file.vectors.length).toBeGreaterThanOrEqual(FROZEN_COUNT);
    const digest = createHash("sha256").update(JSON.stringify(file.vectors.slice(0, FROZEN_COUNT))).digest("hex");
    expect(digest).toBe(FROZEN_DIGEST);
  });

  test.each(file.vectors.map((v) => [v.id, v.name, v] as const))("vector %i: %s", (_, __, vector) => {
    expect(identityPayload(vector.input)).toBe(vector.normalized.join("\u001f"));
    expect(violationIdentity(vector.input)).toBe(vector.identity);
    // Independent check that the recorded identity really is sha256 of the payload.
    expect(createHash("sha256").update(vector.normalized.join("\u001f"), "utf8").digest("hex")).toBe(vector.identity);
  });

  test("the vectors cover the ticket's acceptance criteria", () => {
    const byName = (name: string) => file.vectors.find((v) => v.name === name)?.identity;
    const base = byName("forbidden edge");
    expect(byName("empty cycle signature equals omitted")).toBe(base);
    expect(byName("Windows spelling hashes like POSIX")).toBe(base);
    expect(byName("ruleId is part of the identity")).not.toBe(base);
  });
});

describe("violationIdentity", () => {
  const input = { ruleId: "no-controller-to-repository", source: "src/a.ts", target: "src/b.ts" };

  test("is lowercase hex sha256", () => {
    expect(violationIdentity(input)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("null, undefined, and empty cycle signatures are the same", () => {
    const id = violationIdentity(input);
    expect(violationIdentity({ ...input, cycleSignature: null })).toBe(id);
    expect(violationIdentity({ ...input, cycleSignature: "" })).toBe(id);
    expect(violationIdentity({ ...input, cycleSignature: "src/a.ts -> src/b.ts" })).not.toBe(id);
  });

  test("the separator cannot be smuggled in to forge a collision", () => {
    expect(() => violationIdentity({ ...input, ruleId: "a\u001fb" })).toThrow(IdentityError);
    expect(() => violationIdentity({ ...input, cycleSignature: "x\u001fy" })).toThrow(IdentityError);
    expect(() => violationIdentity({ ...input, target: "unresolved:x\u001fy" })).toThrow(IdentityError);
  });

  test("empty or root-escaping inputs are refused", () => {
    expect(() => violationIdentity({ ...input, ruleId: "" })).toThrow(IdentityError);
    expect(() => violationIdentity({ ...input, source: "" })).toThrow(IdentityError);
    expect(() => violationIdentity({ ...input, source: "../outside.ts" })).toThrow(IdentityError);
    expect(() => violationIdentity({ ...input, source: "/abs/path.ts" })).toThrow(IdentityError);
  });

  test("property: Windows and POSIX spellings of the same path give the same identity", () => {
    const segment = fc.stringMatching(/^[A-Za-z0-9_.-]{1,8}$/).filter((s) => s !== "." && s !== "..");
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 5 }), fc.array(segment, { minLength: 1, maxLength: 5 }), (a, b) => {
        const posix = violationIdentity({ ...input, source: a.join("/"), target: b.join("/") });
        expect(violationIdentity({ ...input, source: a.join("\\"), target: `./${b.join("\\")}` })).toBe(posix);
      }),
    );
  });

  test("property: distinct rule ids never share an identity", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9-]{1,20}$/), fc.stringMatching(/^[a-z][a-z0-9-]{1,20}$/), (r1, r2) => {
        fc.pre(r1 !== r2);
        expect(violationIdentity({ ...input, ruleId: r1 })).not.toBe(violationIdentity({ ...input, ruleId: r2 }));
      }),
    );
  });
});

describe("normalizeIdentityNode", () => {
  test.each([
    ["src/a.ts", "src/a.ts"],
    ["src\\a.ts", "src/a.ts"],
    ["./src/a.ts", "src/a.ts"],
    ["<missing>", "<missing>"],
    ["<unanalyzable>", "<unanalyzable>"],
    ["<unreachable-from>", "<unreachable-from>"],
    ["external:Lodash", "external:lodash"],
    ["external:@Scope/Pkg", "external:@scope/pkg"],
    ["external:../Sibling/Lib.ts", "external:../Sibling/Lib.ts"],
    ["external:..\\Sibling\\Lib.ts", "external:../Sibling/Lib.ts"],
    ["core:fs", "core:fs"],
    ["unresolved:../X", "unresolved:../X"],
    ["unresolved:src\\lib\\x", "unresolved:src/lib/x"],
  ])("%s -> %s", (node, expected) => {
    expect(normalizeIdentityNode(node)).toBe(expected);
  });

  test("normalization is idempotent", () => {
    for (const node of ["src/a.ts", "external:@scope/pkg", "core:fs", "unresolved:src/x", "<missing>"]) {
      expect(normalizeIdentityNode(normalizeIdentityNode(node))).toBe(normalizeIdentityNode(node));
    }
  });

  test("cycle signatures keep their rotation", () => {
    expect(normalizeCycleSignature("src\\b.ts -> src\\a.ts")).toBe("src/b.ts -> src/a.ts");
    expect(normalizeCycleSignature(null)).toBe("");
    expect(normalizeCycleSignature(undefined)).toBe("");
  });
});
