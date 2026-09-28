// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASELINE_PATH,
  CONFIG_PATH,
  CONTRACT_PATH,
  canonicalJson,
  parseConfig,
  parseContract,
  type ArchitectureContract,
  type ResolvedConfig,
} from "@engintel/config";
import {
  baselineDropViolations,
  classifyBaselineChange,
  classifyConfigChange,
  classifyContractChange,
  classifyIgnoreChange,
  isBaselineEligible,
  policyChangeViolations,
  type Finding,
  type PolicyChangeItem,
  type Violation,
} from "@engintel/policy";
import type { BaselineContext } from "./baseline.js";

/**
 * Wires policy-change detection (ENG-012) into a run: reads the working-copy
 * policy files, compares each with its merge-base version, and turns
 * weakenings into findings. A field of `base` left undefined means "same as
 * the working copy" and is not compared; null means the file did not exist.
 */

export const IGNORE_PATH = ".engintel/ignore";

export interface PolicyBase {
  readonly contract?: string | null;
  readonly baseline?: string | null;
  readonly config?: string | null;
  readonly ignore?: string | null;
}

function readWorkingCopy(root: string, repoPath: string): string | null {
  const absolute = join(root, ...repoPath.split("/"));
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) return null;
  return readFileSync(absolute, "utf8");
}

function canonicalOrText(text: string): string {
  try {
    return canonicalJson(JSON.parse(text.replace(/^\uFEFF/, "")));
  } catch {
    return text;
  }
}

function unreadableBase(file: string): PolicyChangeItem {
  return {
    file,
    class: "weakening",
    subject: `${file}:base`,
    summary: "the merge-base version is not valid, so this change cannot be classified; treated as a weakening",
  };
}

function configFrom(text: string | null): ResolvedConfig {
  return parseConfig(text === null ? { schemaVersion: 1 } : JSON.parse(text.replace(/^\uFEFF/, ""))).config;
}

export interface PolicyChangeInput {
  readonly root: string;
  readonly base: PolicyBase;
  readonly head: { readonly contract: ArchitectureContract; readonly config: ResolvedConfig };
  readonly baselines: BaselineContext;
  /** Findings of a full-scope evaluation, computed only if the baseline changed. */
  readonly fullFindings: () => readonly Finding[];
  readonly approvals: { readonly policyChange: boolean; readonly baselineChange: boolean };
}

export function detectPolicyChanges(input: PolicyChangeInput): { items: PolicyChangeItem[]; violations: Violation[] } {
  const { root, base } = input;
  const items: PolicyChangeItem[] = [];
  const violations: Violation[] = [];

  if (base.contract !== undefined) {
    const headText = readWorkingCopy(root, CONTRACT_PATH);
    if (base.contract === null || headText === null || canonicalOrText(base.contract) !== canonicalOrText(headText)) {
      let before: ArchitectureContract | null = null;
      let readable = true;
      if (base.contract !== null) {
        try {
          before = parseContract(JSON.parse(base.contract.replace(/^\uFEFF/, "")), CONTRACT_PATH).contract;
        } catch {
          readable = false;
        }
      }
      items.push(...(readable ? classifyContractChange(CONTRACT_PATH, before, input.head.contract) : [unreadableBase(CONTRACT_PATH)]));
    }
  }

  if (base.config !== undefined) {
    const headText = readWorkingCopy(root, CONFIG_PATH);
    if ((base.config ?? "") !== (headText ?? "") && canonicalOrText(base.config ?? "") !== canonicalOrText(headText ?? "")) {
      try {
        items.push(...classifyConfigChange(CONFIG_PATH, configFrom(base.config), input.head.config));
      } catch {
        items.push(unreadableBase(CONFIG_PATH));
      }
    }
  }

  if (base.ignore !== undefined) {
    items.push(...classifyIgnoreChange(IGNORE_PATH, base.ignore ?? "", readWorkingCopy(root, IGNORE_PATH) ?? ""));
  }

  if (base.baseline !== undefined) {
    const before = input.baselines.reference;
    const after = input.baselines.head;
    if ((before?.baselineHash ?? null) !== (after?.baselineHash ?? null)) {
      const current = new Set(input.fullFindings().filter(isBaselineEligible).map((f) => f.identity));
      const change = classifyBaselineChange(BASELINE_PATH, before?.baseline ?? null, after?.baseline ?? null, current);
      items.push(...change.items);
      violations.push(...baselineDropViolations(BASELINE_PATH, change.dropped));
    }
  }

  violations.push(
    ...policyChangeViolations(items, (item) => (item.subject.startsWith("baseline:") ? input.approvals.baselineChange : input.approvals.policyChange)),
  );
  return { items, violations };
}
