import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Scope vitest to this monorepo's own packages.
 *
 * `ref/` holds independent reference checkouts (teamagentx et al.) with their own
 * test suites; without this exclusion vitest collects them and the gate fails on
 * code that is not ours.
 *
 * Workspace packages resolve to `src/`, not `dist/`. Without this alias, running
 * tests on a tree whose dist has not been built fails to resolve cross-package
 * imports — a test run should not silently depend on a prior build.
 *
 * Every workspace package must have an entry here AND an `exports` field in its
 * package.json; `scripts/check-package-exports.mjs` enforces both.
 */
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Single source of truth for workspace package -> src entry. */
const SRC_ENTRIES: Record<string, string> = {
  "@my-team-agents/runtime-core": "./packages/runtime-core/src/index.ts",
  "@my-team-agents/domain": "./packages/domain/src/index.ts",
  "@my-team-agents/orchestrator": "./packages/orchestrator/src/index.ts",
  "@my-team-agents/runtime-pi": "./packages/runtime-pi/src/index.ts",
  "@my-team-agents/runtime-cli": "./packages/runtime-cli/src/index.ts",
  "@my-team-agents/cost-report": "./packages/cost-report/src/index.ts",
  "@my-team-agents/server": "./packages/server/src/index.ts",
};

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      Object.entries(SRC_ENTRIES).map(([name, path]) => [name, r(path)]),
    ),
  },
  test: {
    include: ["packages/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "ref/**"],
    passWithNoTests: true,
  },
});
