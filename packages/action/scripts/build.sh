#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The EngIntel Authors
#
# Build EngIntel from the Action's own checkout, unless a cached build was
# restored. Dependency install scripts never run (.npmrc ignore-scripts).
set -euo pipefail
: "${ENGINTEL_HOME:?ENGINTEL_HOME must point at the EngIntel checkout}"
cd "$ENGINTEL_HOME"
if [ "${BUILD_CACHE_HIT:-false}" = "true" ] && [ -f packages/cli/dist/bin.js ]; then
  echo "EngIntel build restored from cache."
  exit 0
fi
corepack pnpm install --frozen-lockfile
corepack pnpm build
test -f packages/cli/dist/bin.js
