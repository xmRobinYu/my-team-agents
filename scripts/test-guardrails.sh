#!/usr/bin/env bash
# Guardrail self-test.
#
# A guardrail that has never been run against a failing fixture is not a gate,
# it is a decoration. This script asserts each guardrail rejects what it must
# reject and accepts what it must accept. Exit non-zero on any mismatch.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$ROOT/.git-hooks/check-naming.sh"
fail=0

pass() { printf '  ok   %s\n' "$1"; }
bad()  { printf '  FAIL %s\n' "$1"; fail=1; }

if [ ! -x "$HOOK" ]; then
  echo "check-naming.sh missing or not executable: $HOOK"
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "check-naming.sh: must REJECT forbidden names"
# Each fixture is a path the L3 posture forbids committing.
for name in \
  "app.bak.ts" \
  "src/old/handler.ts" \
  "src/handler_v2.ts" \
  "packages/x/scratch/notes.md" \
  "tmp/debug.log" \
  "backup/config.yaml" \
  "src/old.ts" \
  "config.json~"; do
  if "$HOOK" --check-name "$name" >/dev/null 2>&1; then
    bad "accepted forbidden name: $name"
  else
    pass "rejected $name"
  fi
done

echo "check-naming.sh: must ACCEPT ordinary names"
for name in \
  "src/index.ts" \
  "packages/runtime-core/src/adapter.ts" \
  "AGENTS.md" \
  "justfile" \
  "src/attempts.ts" \
  "packages/domain/src/handoff.ts"; do
  if "$HOOK" --check-name "$name" >/dev/null 2>&1; then
    pass "accepted $name"
  else
    bad "rejected legitimate name: $name"
  fi
done

echo "guardrails: repo must contain no stray backups"
found="$(find "$ROOT" -maxdepth 2 \
  \( -name '*.bak*' -o -name '*.orig' -o -name '*~' -o -name '*_v2*' \) \
  -not -path '*/node_modules/*' -not -path '*/ref/*' -not -path '*/.git/*' 2>/dev/null)"
if [ -n "$found" ]; then
  bad "stray backup files present: $found"
else
  pass "no stray backup files"
fi

echo "guardrails: Verification Matrix commands must exist in justfile"
if [ ! -f "$ROOT/justfile" ]; then
  bad "justfile missing"
else
  for target in typecheck test build verify-cli test-guardrails; do
    if grep -qE "^${target}:" "$ROOT/justfile"; then
      pass "justfile defines '${target}'"
    else
      bad "justfile missing target '${target}'"
    fi
  done
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "guardrail self-test: PASS"
  exit 0
fi
echo "guardrail self-test: FAIL"
exit 1
