# my-team-agents — task entry points.
# Surface set is deliberately small: only gates that actually exist and pass.
# `lint` is absent because eslint is not installed (recorded as a readiness gap).

_default:
    @just --list

# Install workspace dependencies.
setup:
    pnpm install --no-frozen-lockfile

# Type-check every package.
typecheck:
    pnpm -r --if-present typecheck

# Run the test suite (scoped to packages/, excludes ref/).
test:
    pnpm test

# Compile every package to dist/.
build:
    pnpm -r --if-present build

# Prove the cost-report CLI is wired and executable.
verify-cli: build
    node packages/cost-report/dist/cli.js --help
    node packages/cost-report/dist/cli.js --session packages/cost-report/fixtures/sessions/sample.jsonl | grep -q totalTokens

# Self-test the guardrail scripts against named fixtures.
test-guardrails:
    ./scripts/test-guardrails.sh


# Offline check of the Feishu sync mapping (no network, no credentials).
verify-docs:
    node scripts/sync-feishu-docs.mjs --check

# Mirror repo docs to the Feishu wiki (needs local lark-cli user auth).
# Sync a subset: just sync-docs docs/architecture.md
sync-docs *paths:
    node scripts/sync-feishu-docs.mjs {{paths}}

# Everything CI runs, in order.
#
# build MUST precede typecheck: packages consume each other through dist/*.d.ts,
# so type-checking a clean checkout without building first fails with TS2307.
check: build typecheck test verify-cli test-guardrails verify-docs
