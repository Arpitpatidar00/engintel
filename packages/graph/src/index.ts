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
  type BuildGraphOptions,
  type CruiseFn,
  type GraphErrorCode,
} from "./cruise.js";
