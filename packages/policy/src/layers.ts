// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import type { ArchitectureContract, LayerRef } from "@engintel/config";
import picomatch from "picomatch";

/**
 * Layer membership (research doc 07, section 6.1). A file belongs to every
 * layer whose globs match it and whose excludeGlobs do not. Exactly one match
 * is a layer; none is unlayered; more than one is a contract error
 * (engintel.overlapping-layers), never a "most specific glob wins" guess.
 */

const PICOMATCH_OPTIONS = { dot: true } as const;
const cache = new Map<string, (path: string) => boolean>();

/** Memoized picomatch matcher over canonical POSIX paths. */
export function globMatcher(glob: string): (path: string) => boolean {
  let matcher = cache.get(glob);
  if (!matcher) {
    matcher = picomatch(glob, PICOMATCH_OPTIONS);
    cache.set(glob, matcher);
  }
  return matcher;
}

export function matchesAnyGlob(globs: readonly string[] | undefined, path: string): boolean {
  return (globs ?? []).some((glob) => globMatcher(glob)(path));
}

const isModuleId = (id: string) => !/^(external|core|unresolved):/.test(id) && !id.startsWith("<");

export class LayerIndex {
  readonly #contract: ArchitectureContract;
  readonly #memo = new Map<string, readonly string[]>();
  readonly #allowUnresolved: readonly string[];

  constructor(contract: ArchitectureContract) {
    this.#contract = contract;
    this.#allowUnresolved = contract.externals?.allowUnresolved ?? [];
  }

  /** Every layer that claims `path`, in contract order. Non-module ids have no layer. */
  layersOf(path: string): readonly string[] {
    let layers = this.#memo.get(path);
    if (!layers) {
      layers = isModuleId(path)
        ? this.#contract.layers.filter((l) => matchesAnyGlob(l.globs, path) && !matchesAnyGlob(l.excludeGlobs, path)).map((l) => l.id)
        : [];
      this.#memo.set(path, layers);
    }
    return layers;
  }

  /** The single layer of `path`, or null when it has none or is claimed by several. */
  layerOf(path: string): string | null {
    const layers = this.layersOf(path);
    return layers.length === 1 ? (layers[0] as string) : null;
  }

  intraAllowed(layer: string): boolean {
    return this.#contract.layers.find((l) => l.id === layer)?.intraAllowed ?? true;
  }

  /** An unresolved specifier the contract explicitly tolerates (externals.allowUnresolved). */
  isAllowedUnresolved(specifier: string): boolean {
    return this.#allowUnresolved.some((glob) => globMatcher(glob)(specifier));
  }

  /**
   * Does graph node `id` fall on this side of a rule? Layer refs match by
   * membership, globs by path (modules only), `external` by package name or
   * glob, and `unresolved` by any unresolved node the contract does not
   * explicitly tolerate. `specifier` is the edge's specifier, for allowUnresolved.
   */
  matches(ref: LayerRef, id: string, specifier?: string): boolean {
    if ("layer" in ref) return this.layerOf(id) === ref.layer;
    if ("layers" in ref) {
      const layer = this.layerOf(id);
      return layer !== null && ref.layers.includes(layer);
    }
    if ("glob" in ref) return isModuleId(id) && globMatcher(ref.glob)(id);
    if ("external" in ref) {
      if (!id.startsWith("external:")) return false;
      const name = id.slice("external:".length);
      return name === ref.external || globMatcher(ref.external)(name);
    }
    if (!id.startsWith("unresolved:")) return false;
    return !this.isAllowedUnresolved(specifier ?? id.slice("unresolved:".length));
  }
}

/** Layer ids named by a ref, or null when the ref is not layer-based. */
export function refLayers(ref: LayerRef): readonly string[] | null {
  if ("layer" in ref) return [ref.layer];
  if ("layers" in ref) return ref.layers;
  return null;
}

/** Short human description of a rule side: "layer 'services'", "glob 'src/**'", "unresolved imports". */
export function describeRef(ref: LayerRef): string {
  if ("layer" in ref) return `layer '${ref.layer}'`;
  if ("layers" in ref) return `layers ${ref.layers.map((l) => `'${l}'`).join(", ")}`;
  if ("glob" in ref) return `files matching '${ref.glob}'`;
  if ("external" in ref) return `package '${ref.external}'`;
  return "unresolved imports";
}
