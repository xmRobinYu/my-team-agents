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
 */
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@my-team-agents/runtime-core": r("./packages/runtime-core/src/index.ts"),
      "@my-team-agents/domain": r("./packages/domain/src/index.ts"),
      "@my-team-agents/orchestrator": r("./packages/orchestrator/src/index.ts"),
      "@my-team-agents/runtime-pi": r("./packages/runtime-pi/src/index.ts"),
      "@my-team-agents/runtime-cli": r("./packages/runtime-cli/src/index.ts"),
      "@my-team-agents/cost-report": r("./packages/cost-report/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "ref/**"],
    passWithNoTests: true,
  },
});
