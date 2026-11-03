#!/usr/bin/env bash
# Real end-to-end smoke against the installed `pi` binary.
#
# Covers the two behaviours that only a live run can prove:
#   1. agent_settled completion semantics (agent_end must not finish the run)
#   2. session resume with history (--session <path> loads prior context)
#
# Requires: pi installed, a working provider (models.json), network.
# The script exits non-zero on any failed assertion. It never uses mock.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="$(mktemp -d)"
trap 'rm -rf "$WORKSPACE"' EXIT

# `pi` is installed under whichever Node version ran `npm i -g` at the time, so a
# shell on a different fnm version has a PATH without it. The old line treated that
# as "not installed" and exited 0 -- a gate that ran nothing but reported success,
# which is exactly what AGENTS.md forbids. Resolve the absolute path instead, and
# fail loudly when it truly is absent.
PI_BIN="$(node "$ROOT/scripts/resolve-bin.mjs" pi 2>/dev/null || true)"
if [ -z "$PI_BIN" ]; then
  echo "FAIL: pi binary not found (PATH plus every version-manager global bin was probed)" >&2
  echo "      npm i -g --ignore-scripts @earendil-works/pi-coding-agent" >&2
  exit 1
fi
# PiAdapter spawns a bare "pi", and the smoke scripts inherit this environment, so
# the resolved directory must be on PATH for the child processes too.
export PATH="$(dirname "$PI_BIN"):$PATH"

MODEL="${PI_SMOKE_MODEL:-airouter/deepseek-v4.1-flash}"
echo "== pi real smoke =="
echo "pi:    $PI_BIN"
echo "model: $MODEL"

# 1) agent_settled completion + usage + event stream
echo "-- agent_settled completion --"
node "$ROOT/scripts/pi-smoke-settled.mjs" "$WORKSPACE" "$MODEL"

# 2) session resume with memory
echo "-- session resume with history --"
node "$ROOT/scripts/pi-smoke-resume.mjs" "$WORKSPACE" "$MODEL"

echo "== all real smoke checks passed =="
