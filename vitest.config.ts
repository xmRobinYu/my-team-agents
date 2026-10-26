import { defineConfig } from "vitest/config";

/**
 * Scope vitest to this monorepo's own packages.
 * `ref/` holds independent reference checkouts (teamagentx et al.) with their own
 * test suites; without this exclusion vitest collects them and the gate fails on
 * code that is not ours.
 */
export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "ref/**"],
    passWithNoTests: true,
  },
});
