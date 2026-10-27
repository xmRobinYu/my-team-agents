#!/usr/bin/env node
/**
 * Enforce the two halves of source-resolution for workspace packages:
 *   1. every workspace package declares `exports` in package.json
 *   2. every workspace package (except app-only ones) has a src alias so tests
 *      resolve source instead of build output
 *
 * Without both, `pnpm test` can silently depend on `dist/` being built first,
 * which makes the test gate depend on build order rather than on the code.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");
const vitestConfig = readFileSync(join(root, "vitest.config.ts"), "utf8");

/** Packages that are applications, not importable libraries with src/index.ts. */
const APP_ONLY = new Set(["@my-team-agents/web", "@my-team-agents/server"]);

const problems = [];
const names = [];

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = join(packagesDir, entry.name, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const name = manifest.name;
  if (!name) { problems.push(`packages/${entry.name}/package.json has no "name"`); continue; }
  names.push(name);

  if (!manifest.exports) problems.push(`${name}: missing "exports" (tests may resolve build output)`);

  const srcEntry = join(packagesDir, entry.name, "src", "index.ts");
  if (!APP_ONLY.has(name) && !existsSync(srcEntry)) {
    problems.push(`${name}: missing src/index.ts (cannot be aliased to source)`);
  }
  if (!APP_ONLY.has(name) && !vitestConfig.includes(`"${name}"`)) {
    problems.push(`${name}: no vitest src alias in vitest.config.ts`);
  }
}

if (problems.length > 0) {
  console.error("workspace package resolution has problems:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`package resolution OK: ${names.length} packages declare exports and resolve to src`);
for (const name of names.sort()) console.log(`  ${name}`);
