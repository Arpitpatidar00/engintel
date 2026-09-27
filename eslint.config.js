// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// Locked decisions, enforced at the import site as well as in the lockfile
// (scripts/workspace-policy.test.mjs).
const bannedImports = [
  { name: "ts-morph", message: "D-002: use the TypeScript compiler API directly." },
  { name: "better-sqlite3", message: "D-012: use sql.js (WASM)." },
  { name: "madge", message: "Locked: dependency-cruiser is the only module graph." },
  { name: "nx", message: "D-011: Nx is a repo we analyze, not our build system." },
  { name: "openai", message: "EngIntel never calls an LLM." },
];
const bannedImportPatterns = [
  { group: ["@nx/*"], message: "D-011: Nx is a repo we analyze, not our build system." },
  { group: ["*tree-sitter*", "@tree-sitter/*"], message: "D-002: no tree-sitter in MVP." },
  { group: ["@anthropic-ai/*", "@langchain/*", "langchain", "@ai-sdk/*"], message: "EngIntel never calls an LLM." },
];

export default defineConfig(
  globalIgnores([
    "**/dist/**",
    "**/node_modules/**",
    "**/.turbo/**",
    "**/coverage/**",
    // Golden fixtures contain deliberately broken and adversarial code.
    "tests/golden/**",
  ]),
  js.configs.recommended,
  tseslint.configs.strict,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { console: "readonly", process: "readonly", Buffer: "readonly", URL: "readonly" },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
      ],
      "no-restricted-imports": ["error", { paths: bannedImports, patterns: bannedImportPatterns }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "Property[key.name='shell'][value.value=true]",
          message: "shell: true is forbidden (research doc 14, section 4.4). Spawn with an argv array.",
        },
      ],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  {
    files: ["**/test/**/*.ts"],
    rules: {
      // Tests assert on fixtures known to exist; `find(...)!` keeps them readable.
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
