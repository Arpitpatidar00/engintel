// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Content hash of a directory tree (research doc 04, section 3.3):
 *
 *   sha256( join("\n", sorted(files).map(f => f.path + "\0" + sha256(bytes(f)))) )
 *
 * Paths are POSIX, relative to the tree root, NFC, sorted by UTF-16 code unit
 * (never locale-aware). Bytes are hashed raw: no BOM stripping, no line-ending
 * normalization. Only regular files count; empty directories do not exist in
 * git and do not change the hash. Symlinks are refused.
 */

/** OS clutter that is never part of a tree, even if it appears locally. */
export const IGNORED_NAMES: ReadonlySet<string> = new Set([".DS_Store", "Thumbs.db"]);

export interface TreeEntry {
  readonly path: string;
  readonly sha256: string;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function listTree(dir: string, exclude: (path: string) => boolean = () => false): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const walk = (absolute: string, relative: string): void => {
    for (const dirent of readdirSync(absolute, { withFileTypes: true })) {
      if (IGNORED_NAMES.has(dirent.name)) continue;
      const name = dirent.name.normalize("NFC");
      const childPath = relative === "" ? name : `${relative}/${name}`;
      const childAbsolute = join(absolute, dirent.name);
      if (dirent.isSymbolicLink()) throw new Error(`symlinks are not allowed in a hashed tree: ${childPath}`);
      if (dirent.isDirectory()) {
        walk(childAbsolute, childPath);
      } else if (dirent.isFile()) {
        if (!exclude(childPath)) entries.push({ path: childPath, sha256: sha256Hex(readFileSync(childAbsolute)) });
      } else {
        throw new Error(`unsupported file type in a hashed tree: ${childPath}`);
      }
    }
  };
  walk(dir, "");
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function treeHashOf(entries: readonly TreeEntry[]): string {
  return sha256Hex(entries.map((e) => `${e.path}\0${e.sha256}`).join("\n"));
}

export function computeTreeHash(dir: string, exclude?: (path: string) => boolean): string {
  return treeHashOf(listTree(dir, exclude));
}
