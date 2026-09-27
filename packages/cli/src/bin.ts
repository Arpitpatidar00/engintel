#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The EngIntel Authors

import { main, todayUtc } from "./cli.js";

process.exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  cwd: process.cwd(),
  env: process.env,
  today: () => todayUtc(),
});
