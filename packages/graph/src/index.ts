// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

export {
  GRAPH_SCHEMA_VERSION,
  buildAdjacency,
  compareEdges,
  importersOf,
  importsOf,
  reverseReachable,
  serializeGraph,
  type Adjacency,
  type GraphEdge,
  type GraphNode,
  type ModuleGraph,
  type NodeKind,
} from "./model.js";

export {
  GraphError,
  buildModuleGraph,
  normalizeCruiseResult,
  packageName,
  safeSpecifier,
  type BuildGraphOptions,
  type CruiseFn,
  type GraphErrorCode,
} from "./cruise.js";

export { canonicalRotation, cycleSignature, cyclicComponents, findCycles, type Cycle, type CycleOptions } from "./cycles.js";

export {
  GRAPH_CACHE_FORMAT,
  cacheFromGraph,
  graphCacheKey,
  mergeGraph,
  parseGraphCache,
  planReuse,
  toolVersions,
  type CacheKeyParts,
  type CachedFile,
  type GraphCache,
  type ReusePlan,
} from "./incremental.js";
