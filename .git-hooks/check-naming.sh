#!/usr/bin/env bash
# Naming / artifact guardrail.
#
# Rejects the artifact shapes the L3 posture forbids: backup files, "_v2"
# duplicates, scratch and temp directories. Also enforces the rule that changes
# to rule files (AGENTS.md, constraints.yaml, justfile, .git-hooks/*) carry an
# explicit reason, so governance edits are never silent.
#
# Usage:
#   check-naming.sh --check-name <path>   validate one path (exit 1 = rejected)
#   check-naming.sh --staged              validate files staged for commit

set -uo pipefail

# Matches a forbidden token as a whole path segment OR a whole basename word,
# so `appold.ts` is caught while `src/attempts.ts` is not.
FORBIDDEN_NAME_PATTERN='(^|/)(tmp|scratch|backup|old)(/|\.|$)|\.(bak|orig)[./]?|~$|_v2'

reject() {
  printf 'check-naming: rejected %s (%s)\n' "$1" "$2" >&2
  exit 1
}

check_name() {
  local path="$1"
  if printf '%s' "$path" | grep -Eq "$FORBIDDEN_NAME_PATTERN"; then
    reject "$path" "matches forbidden artifact pattern"
  fi
  exit 0
}

check_staged() {
  local files status=0
  files="$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)"
  [ -z "$files" ] && { echo "check-naming: nothing staged"; exit 0; }

  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if printf '%s' "$f" | grep -Eq "$FORBIDDEN_NAME_PATTERN"; then
      printf 'check-naming: rejected %s (forbidden artifact pattern)\n' "$f" >&2
      status=1
    fi
  done <<< "$files"

  # Rule-file changes must be justified in the commit message or an env var.
  local rule_files
  rule_files="$(printf '%s\n' "$files" | grep -E '^(AGENTS\.md|CONTEXT\.md|constraints\.yaml|justfile|\.git-hooks/)' || true)"
  if [ -n "$rule_files" ] && [ -z "${RULE_CHANGE_REASON:-}" ]; then
    printf 'check-naming: rule files changed without RULE_CHANGE_REASON:\n%s\n' "$rule_files" >&2
    printf 'set RULE_CHANGE_REASON="<why>" to proceed\n' >&2
    status=1
  fi

  exit "$status"
}

case "${1:-}" in
  --check-name) check_name "${2:-}" ;;
  --staged)     check_staged ;;
  *) echo "usage: check-naming.sh --check-name <path> | --staged" >&2; exit 2 ;;
esac
