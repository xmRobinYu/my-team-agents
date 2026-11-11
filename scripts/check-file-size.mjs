#!/usr/bin/env node
/**
 * `constraints.yaml: size_limits.max_file_lines` — ENFORCED.
 *
 * Before this script the limit was a number in a YAML file that nothing read. A
 * declared limit with no checker is worse than no limit: it reads as a guarantee.
 * `AGENTS.md` forbids exactly that ("no phantom enforcement"), so the choice was to
 * enforce it or delete it. This enforces it.
 *
 * Ratchet, not a big-bang refactor. Four files were already over the limit when the
 * check was wired up. Refusing to commit until all four are split would have blocked
 * unrelated work, and lowering the limit to fit them would have made the number a
 * lie. So: a baseline records each existing offender at its CURRENT size, and
 *
 *   - a file over the limit and NOT in the baseline FAILS (new debt),
 *   - a baselined file exceeding its recorded size FAILS (the debt may not grow),
 *   - a baselined file at or under the limit FAILS until it is removed from the
 *     baseline (the baseline may not outlive the debt it records).
 *
 * The third rule is what keeps the baseline from becoming a permanent exemption.
 * Exit code 0 = clean, 1 = violations, 2 = the limit could not be read.
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const CONSTRAINTS = join(repoRoot, "constraints.yaml");
const BASELINE = join(repoRoot, "scripts", "file-size-baseline.json");

/** Counted extensions. Markdown and JSON are prose/data, not code. */
const EXTENSIONS = /\.(ts|tsx|mjs|js|sh)$/;
/** Generated, vendored or read-only trees — never measured. */
const EXCLUDED = [
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /^ref\//,
  /(^|\/)\.git\//,
];

function readLimit() {
  let text;
  try {
    text = readFileSync(CONSTRAINTS, "utf8");
  } catch (err) {
    console.error(`check-file-size: cannot read constraints.yaml: ${err.message}`);
    process.exit(2);
  }
  const match = /^\s*max_file_lines:\s*(\d+)\s*$/m.exec(text);
  if (!match) {
    // A missing threshold is not "no limit": it means this check cannot do its job.
    console.error("check-file-size: constraints.yaml has no size_limits.max_file_lines");
    process.exit(2);
  }
  return Number(match[1]);
}

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" });
  return out.split("\0").filter(Boolean).filter((f) => EXTENSIONS.test(f));
}

function lineCount(file) {
  // Count newline-terminated lines plus a final unterminated one, which is what
  // `wc -l` under-counts and what a human means by "how long is this file".
  const text = readFileSync(join(repoRoot, file), "utf8");
  if (text === "") return 0;
  let n = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return text.endsWith("\n") ? n : n + 1;
}

function readBaseline() {
  try {
    const raw = JSON.parse(readFileSync(BASELINE, "utf8"));
    return new Map(Object.entries(raw.files ?? {}));
  } catch (err) {
    if (err.code === "ENOENT") return new Map();
    console.error(`check-file-size: baseline is not readable JSON: ${err.message}`);
    process.exit(2);
  }
}

const limit = readLimit();
const baseline = readBaseline();
const violations = [];
const stale = [];
const seen = new Set();

for (const file of trackedFiles()) {
  if (EXCLUDED.some((re) => re.test(file))) continue;
  const lines = lineCount(file);
  const recorded = baseline.get(file);

  if (recorded === undefined) {
    if (lines > limit) {
      violations.push(`${relative(repoRoot, join(repoRoot, file))}: ${lines} lines > ${limit}`);
    }
    continue;
  }
  seen.add(file);
  if (lines > recorded) {
    violations.push(`${relative(repoRoot, join(repoRoot, file))}: ${lines} lines > baseline ${recorded} (debt may not grow)`);
  }
  if (lines <= limit) {
    stale.push(`${relative(repoRoot, join(repoRoot, file))}: now ${lines} <= ${limit} — remove it from scripts/file-size-baseline.json`);
  }
}

for (const file of baseline.keys()) {
  if (!seen.has(file)) stale.push(`${file}: baselined but no longer tracked — remove it from scripts/file-size-baseline.json`);
}

if (violations.length === 0 && stale.length === 0) {
  console.log(`check-file-size: ${limit} lines max, ${baseline.size} baselined file(s) — clean`);
  process.exit(0);
}

for (const v of violations) console.error(`  [over]  ${v}`);
for (const s of stale) console.error(`  [stale] ${s}`);
console.error(
  `\ncheck-file-size: ${violations.length} violation(s), ${stale.length} stale baseline entr(ies).`,
);
process.exit(1);
