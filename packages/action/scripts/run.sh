#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The EngIntel Authors
#
# Run engintel validate once and render the result for GitHub (ENG-011):
# human text in the log, a Markdown job summary, and a SARIF file. The exit
# code is recorded as a step output; the Action's last step fails the job
# with it, after the cache and outputs are saved. Anything unexpected is a
# failure, never a pass.
set -uo pipefail
: "${ENGINTEL_BIN:?}" "${RUNNER_TEMP:?}" "${GITHUB_OUTPUT:?}"

report="$RUNNER_TEMP/engintel-report.json"
sarif="$RUNNER_TEMP/engintel.sarif"
workdir="${INPUT_WORKING_DIRECTORY:-.}"

emit() { printf '%s\n' "$1" >> "$GITHUB_OUTPUT"; }

if [ "${GITHUB_EVENT_NAME:-}" = "pull_request_target" ]; then
  echo "engintel: error E_UNSAFE_EVENT: pull_request_target runs with repository secrets against untrusted code. Use on: pull_request." >&2
  emit "exit-code=2"; emit "outcome=error"
  exit 0
fi

args=(validate --root "$workdir" --format json)
base="${INPUT_BASE:-}"
if [ -z "$base" ] && [ -n "${GITHUB_BASE_REF:-}" ]; then base="origin/${GITHUB_BASE_REF}"; fi
if [ -n "$base" ]; then args+=(--base "$base"); fi
if [ "${POLICY_CHANGE_APPROVED:-false}" = "true" ]; then args+=(--policy-change-approved); fi
if [ "${BASELINE_CHANGE_APPROVED:-false}" = "true" ]; then args+=(--baseline-change-approved); fi

node "$ENGINTEL_BIN" "${args[@]}" > "$report"
code=$?

case "$code" in
  0) outcome=pass ;;
  1) outcome=fail ;;
  *) outcome=error; code=2 ;;
esac

if node "$ENGINTEL_BIN" report "$report" > /dev/null 2>&1; then
  node "$ENGINTEL_BIN" report "$report"
  node "$ENGINTEL_BIN" report "$report" --format sarif > "$sarif" || { code=2; outcome=error; }
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    node "$ENGINTEL_BIN" report "$report" --format markdown >> "$GITHUB_STEP_SUMMARY" || true
  fi
  emit "report-file=$report"
  emit "sarif-file=$sarif"
else
  echo "engintel: error E_NO_REPORT: engintel validate produced no report (exit $code)." >&2
  code=2; outcome=error
fi

emit "exit-code=$code"
emit "outcome=$outcome"
exit 0
