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

command -v pi >/dev/null || { echo "SKIP: pi binary not installed"; exit 0; }

MODEL="${PI_SMOKE_MODEL:-airouter/deepseek-v4.1-flash}"
echo "== pi real smoke =="
echo "model: $MODEL"

# 1) agent_settled completion + usage + event stream
echo "-- agent_settled completion --"
node "$ROOT/scripts/pi-smoke-settled.mjs" "$WORKSPACE" "$MODEL"

# 2) session resume with memory
echo "-- session resume with history --"
node "$ROOT/scripts/pi-smoke-resume.mjs" "$WORKSPACE" "$MODEL"

echo "== all real smoke checks passed =="
