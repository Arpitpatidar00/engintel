// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import * as z from "zod";

/**
 * The architecture contract: `.engintel/architecture.json`.
 *
 * Human-owned, CODEOWNERS-protected policy (D-003). Based on research doc 06,
 * plus `status` (FR-004, UC-1), `opaqueImports`, and `unsupportedPaths`
 * (ENG-023, FR-020).
 *
 * Zod is the source of truth. `architectureJsonSchema()` emits the committed
 * JSON Schema. Structure is enforced by both; cross-references (unique ids,
 * layers that exist, exception dates) are loader invariants that only the
 * Zod schema can express.
 *
 * Every object is strict: an agent adding `"ignoreAll": true` is rejected,
 * neither silently honored nor silently dropped.
 */

export const ARCHITECTURE_SCHEMA_VERSION = 1;

/** Lowercase kebab id for layers, rules, and exceptions. No dots: "engintel.*" stays reserved for built-in rules. */
const IdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/, "ids are lowercase kebab-case, 2 to 64 characters");

/**
 * Repo-relative POSIX glob. Rejects: leading "!" (use excludeGlobs), absolute
 * paths and drive letters, backslashes (use character classes to escape),
 * "//", trailing "/", "." or ".." segments, node_modules or .git segments, NUL.
 */
export const GLOB_PATTERN =
  /^(?!!)(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*\/\/)(?!.*\/$)(?!(?:.*\/)?\.\.?(?:\/|$))(?!(?:.*\/)?(?:node_modules|\.git)(?:\/|$))[^\0]+$/;

const GlobSchema = z.string().max(500).regex(GLOB_PATTERN, "must be a repo-relative POSIX glob");

/** GitHub user or team, as in CODEOWNERS: "@user" or "@org/team". */
const OwnerSchema = z
  .string()
  .regex(/^@[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9._-]+)?$/, "owners are @user or @org/team");

const SemverSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    "policyVersion must be semver",
  );

/** YYYY-MM-DD. Zod's pattern is calendar-aware (no Feb 30; leap years handled) and is emitted into the JSON Schema. */
const IsoDateSchema = z.iso.date();

export const CONTRACT_SEVERITIES = ["error", "warn", "advisory"] as const;
const SeveritySchema = z.enum(CONTRACT_SEVERITIES);

export const LayerRefSchema = z.union([
  z.strictObject({ layer: IdSchema }),
  z.strictObject({ layers: z.array(IdSchema).min(1) }),
  z.strictObject({ glob: GlobSchema }),
  z.strictObject({ external: z.string().min(1).max(214) }),
  z.strictObject({ unresolved: z.literal(true) }),
]);

export const LayerSchema = z.strictObject({
  id: IdSchema,
  description: z.string().max(1000).optional(),
  globs: z.array(GlobSchema).min(1),
  excludeGlobs: z.array(GlobSchema).optional(),
  /** Files in this layer may import each other. */
  intraAllowed: z.boolean().default(true),
  owner: OwnerSchema.optional(),
});

const ruleBase = {
  id: IdSchema,
  severity: SeveritySchema,
  /** Shown to humans and agents as the reason a diagnostic fired. */
  comment: z.string().min(1).max(2000),
  enabled: z.boolean().default(true),
};

export const RuleSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...ruleBase,
    kind: z.literal("forbidden"),
    from: LayerRefSchema,
    to: LayerRefSchema,
    direction: z.enum(["forward", "backward", "both"]).default("forward"),
    /** Default false: leaking a type across a layer is a layer violation. */
    ignoreTypeOnly: z.boolean().default(false),
    ignoreDynamic: z.boolean().default(false),
  }),
  z.strictObject({
    ...ruleBase,
    kind: z.literal("allowed"),
    from: LayerRefSchema,
    to: LayerRefSchema,
    /** When true, every other layered target is forbidden under this rule's id. */
    exclusive: z.boolean().default(false),
  }),
  z.strictObject({ ...ruleBase, kind: z.literal("required"), from: LayerRefSchema, to: LayerRefSchema }),
  z.strictObject({ ...ruleBase, kind: z.literal("acyclic"), within: LayerRefSchema }),
  z.strictObject({ ...ruleBase, kind: z.literal("reachable"), from: LayerRefSchema, to: LayerRefSchema }),
]);

export const ExceptionSchema = z.strictObject({
  id: IdSchema,
  ruleId: IdSchema,
  source: GlobSchema,
  /** "*" means any target; adding one is classified as a policy weakening. */
  target: GlobSchema,
  /** At least 20 characters: "wip" and "fix ci" are not reasons. */
  reason: z.string().min(20).max(2000),
  owner: OwnerSchema,
  addedAt: IsoDateSchema,
  /** Required. An expired exception stops applying; the underlying rule fires again. */
  expiresAt: IsoDateSchema,
});

export const NamingRuleSchema = z.strictObject({
  id: IdSchema,
  severity: SeveritySchema,
  layer: IdSchema,
  filePattern: GlobSchema,
  symbolPattern: z
    .string()
    .min(1)
    .max(200)
    .refine((source) => {
      try {
        new RegExp(source, "u");
        return true;
      } catch {
        return false;
      }
    }, "symbolPattern must be a valid regular expression")
    .optional(),
  comment: z.string().min(1).max(2000),
});

export const UnsupportedPathSchema = z.strictObject({
  glob: GlobSchema,
  reason: z.string().min(20).max(2000),
  owner: OwnerSchema,
});

export const ArchitectureContractSchema = z
  .strictObject({
    /** Lets editors find the JSON Schema. Ignored by EngIntel. */
    $schema: z.string().optional(),
    schemaVersion: z.literal(ARCHITECTURE_SCHEMA_VERSION),
    policyVersion: SemverSchema,
    /** "draft" contracts are never enforced. `engintel init` writes a draft. */
    status: z.enum(["draft", "active"]),
    description: z.string().max(4000).optional(),
    layers: z.array(LayerSchema).min(1),
    rules: z.array(RuleSchema).min(1),
    exceptions: z.array(ExceptionSchema).default([]),
    naming: z.array(NamingRuleSchema).default([]),
    ownership: z
      .strictObject({
        policyCodeowners: z.array(OwnerSchema).min(1),
        layers: z.record(IdSchema, z.array(OwnerSchema).min(1)).optional(),
      })
      .optional(),
    /** When omitted, unlayered files are advisory so messy repos can adopt. */
    unlayered: z.strictObject({ severity: SeveritySchema, comment: z.string().max(2000).optional() }).optional(),
    externals: z
      .strictObject({
        collapseSubpaths: z.boolean().default(true),
        /** Specifier globs whose unresolved imports are tolerated. */
        allowUnresolved: z.array(z.string().min(1).max(500)).default([]),
      })
      .optional(),
    /** Severity for imports the graph cannot resolve (non-literal import(), unresolved specifiers). */
    opaqueImports: z.enum(["error", "warn"]).default("error"),
    /** Reviewed allowlist of paths the analyzer may not be able to parse. Everything else fails closed. */
    unsupportedPaths: z.array(UnsupportedPathSchema).default([]),
  })
  .superRefine((contract, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });

    const layerIds = new Set<string>();
    contract.layers.forEach((layer, i) => {
      if (layerIds.has(layer.id)) issue(["layers", i, "id"], `duplicate layer id "${layer.id}"`);
      layerIds.add(layer.id);
    });

    const checkLayerRef = (ref: z.infer<typeof LayerRefSchema>, path: (string | number)[]) => {
      if ("layer" in ref && !layerIds.has(ref.layer)) issue([...path, "layer"], `unknown layer "${ref.layer}"`);
      if ("layers" in ref) {
        ref.layers.forEach((id, j) => {
          if (!layerIds.has(id)) issue([...path, "layers", j], `unknown layer "${id}"`);
        });
      }
    };

    const ruleIds = new Set<string>();
    const exclusiveFrom = new Set<string>();
    contract.rules.forEach((rule, i) => {
      if (ruleIds.has(rule.id)) issue(["rules", i, "id"], `duplicate rule id "${rule.id}"`);
      ruleIds.add(rule.id);
      if (rule.kind === "acyclic") {
        checkLayerRef(rule.within, ["rules", i, "within"]);
        return;
      }
      checkLayerRef(rule.from, ["rules", i, "from"]);
      checkLayerRef(rule.to, ["rules", i, "to"]);
      if (rule.kind === "allowed" && rule.exclusive) {
        if (!("layer" in rule.from)) {
          issue(["rules", i, "from"], "an exclusive allowed rule must start from a single { layer }");
        } else if (exclusiveFrom.has(rule.from.layer)) {
          issue(["rules", i, "from"], `layer "${rule.from.layer}" already has an exclusive allowed rule`);
        } else {
          exclusiveFrom.add(rule.from.layer);
        }
      }
    });

    contract.naming.forEach((rule, i) => {
      if (ruleIds.has(rule.id)) issue(["naming", i, "id"], `rule id "${rule.id}" is already used`);
      ruleIds.add(rule.id);
      if (!layerIds.has(rule.layer)) issue(["naming", i, "layer"], `unknown layer "${rule.layer}"`);
    });

    const exceptionIds = new Set<string>();
    contract.exceptions.forEach((ex, i) => {
      if (exceptionIds.has(ex.id)) issue(["exceptions", i, "id"], `duplicate exception id "${ex.id}"`);
      exceptionIds.add(ex.id);
      if (!ruleIds.has(ex.ruleId)) issue(["exceptions", i, "ruleId"], `unknown rule "${ex.ruleId}"`);
      if (ex.expiresAt <= ex.addedAt) issue(["exceptions", i, "expiresAt"], "expiresAt must be after addedAt");
    });

    for (const id of Object.keys(contract.ownership?.layers ?? {})) {
      if (!layerIds.has(id)) issue(["ownership", "layers", id], `unknown layer "${id}"`);
    }
  });

/** The contract as written (defaults not yet applied). */
export type ArchitectureContractInput = z.input<typeof ArchitectureContractSchema>;
/** The contract after parsing, with defaults applied. */
export type ArchitectureContract = z.output<typeof ArchitectureContractSchema>;
export type ArchitectureRule = ArchitectureContract["rules"][number];
export type LayerRef = z.infer<typeof LayerRefSchema>;

/** JSON Schema (2020-12) for the file humans write. Loader invariants are listed in the description. */
export function architectureJsonSchema(): Record<string, unknown> {
  const { $schema, ...generated } = z.toJSONSchema(ArchitectureContractSchema, {
    target: "draft-2020-12",
    io: "input",
  });
  return {
    $schema,
    $id: "https://engintel.dev/schema/architecture.v1.json",
    title: "EngIntel architecture contract",
    description:
      "Human-owned architecture policy (.engintel/architecture.json). The reference loader also " +
      "enforces: unique layer, rule, naming and exception ids; every referenced layer exists; " +
      "exceptions reference an existing rule and expire after they were added; at most one " +
      "exclusive allowed rule per layer; symbolPattern compiles.",
    ...generated,
  };
}
