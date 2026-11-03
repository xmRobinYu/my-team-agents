/**
 * Resolve the absolute path of a globally-installed CLI that lives under a Node
 * version manager's per-version bin directory.
 *
 * Why this is not just `spawnSync(name)` or `command -v name`:
 *
 * A global npm package installs into whichever Node version was active at install
 * time. With fnm that is a per-version directory
 * (`.../fnm/node-versions/v22.22.1/installation/bin`), so a shell running a
 * different Node version has a PATH that never contains it. The failure mode is
 * ENOENT, which reads as "not installed" -- so the obvious response (install it
 * again) leaves the actual cause in place, and a shell that treats ENOENT as
 * "skip" converts a gate that did not run into a gate that passed.
 *
 * Two binaries in this repo are affected, and both were: `lark-cli` (Feishu sync)
 * and `pi` (real-model acceptance). `lark-cli` is a self-contained Go executable
 * and `pi` carries its own shebang, so neither cares which Node version invokes
 * it -- absolute-path resolution is sufficient.
 *
 * `feishu-cli` is a DIFFERENT tool with an incompatible command surface (`doc` /
 * `bitable` subcommands versus the `docs +update` shortcut style `lark-cli` uses),
 * so it is deliberately NOT a fallback: substituting it produces a confusing
 * "unknown command" error instead of naming the real problem.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Default binary name, for callers that are resolving the Feishu CLI. */
const LARK_BIN = process.platform === "win32" ? "lark-cli.cmd" : "lark-cli";

/** Version directories, newest first, so a newer install wins a tie. */
function versionDirs(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => /^v?\d+\.\d+\.\d+/.test(name))
    .sort((a, b) => {
      const pa = a.replace(/^v/, "").split(".").map(Number);
      const pb = b.replace(/^v/, "").split(".").map(Number);
      for (let i = 0; i < 3; i += 1) {
        const d = (pb[i] ?? 0) - (pa[i] ?? 0);
        if (d !== 0) return d;
      }
      return 0;
    });
}

function isExecutable(p) {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    return process.platform === "win32" || (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Candidate absolute paths for `bin`, most specific first.
 *
 * `home`, `pathEnv`, `env` and `bin` are injectable so the ordering is testable
 * without this machine's real layout deciding the outcome.
 */
export function binCandidates({
  home = homedir(),
  pathEnv = process.env.PATH ?? "",
  env = process.env,
  bin = LARK_BIN,
} = {}) {
  const out = [];
  // Windows global bins are `.cmd` shims; accept either spelling from callers.
  const binName = process.platform === "win32" && !bin.endsWith(".cmd") ? `${bin}.cmd` : bin;

  // MTA_BIN_<NAME> (dashes -> underscores) points at one specific install.
  const override = env[`MTA_BIN_${bin.replace(/-/g, "_").toUpperCase()}`]?.trim();
  if (override) out.push(override);

  for (const dir of pathEnv.split(delimiter)) {
    if (dir) out.push(join(dir, binName));
  }

  // fnm on macOS: the install-time Node version owns the global bin.
  const fnmMac = join(home, "Library", "Application Support", "fnm", "node-versions");
  for (const v of versionDirs(fnmMac)) {
    out.push(join(fnmMac, v, "installation", "bin", binName));
  }
  // fnm on Linux.
  const fnmLinux = join(home, ".local", "share", "fnm", "node-versions");
  for (const v of versionDirs(fnmLinux)) {
    out.push(join(fnmLinux, v, "installation", "bin", binName));
  }

  // Other version managers that also isolate global bins.
  const nvm = join(home, ".nvm", "versions", "node");
  for (const v of versionDirs(nvm)) out.push(join(nvm, v, "bin", binName));

  const volta = join(home, ".volta", "tools", "image", "node");
  for (const v of versionDirs(volta)) out.push(join(volta, v, "bin", binName));

  // asdf shims are stable across versions.
  out.push(join(home, ".asdf", "shims", binName));

  return [...new Set(out)];
}

/**
 * Absolute path of `bin`, or null. Memoized per binary: one sync run shells out
 * dozens of times and re-walking every version directory each time is pointless.
 * Passing `options` bypasses (and does not poison) the memo.
 */
const memo = new Map();
export function findBin(bin, options) {
  if (!options && memo.has(bin)) return memo.get(bin);
  const found = binCandidates({ ...options, bin }).find(isExecutable) ?? null;
  if (!options) memo.set(bin, found);
  return found;
}

/** Drop the memo -- tests only. */
export function resetBinCache() {
  memo.clear();
}

/**
 * Error for "no binary anywhere". It names every path tried: a bare "install it"
 * is exactly what made this failure take a full investigation to understand.
 */
export function missingBinError(bin, options) {
  const tried = binCandidates({ ...options, bin });
  const key = bin.replace(/-/g, "_").toUpperCase();
  return new Error(
    `${bin} not found. Tried:\n${tried.map((p) => `  - ${p}`).join("\n")}\n`
      + `Install it globally, or set MTA_BIN_${key} to its absolute path.`,
  );
}

/* ------------------------------------------------------------------ CLI */

// Shell scripts need the same resolution: `pi-smoke.sh` used to treat "not on
// PATH" as "not installed" and SKIP with exit 0, which reads as a passing gate
// that tested nothing (AGENTS.md says the opposite about that smoke). Exposing
// the resolver as a one-shot command keeps a single copy of the lookup instead
// of a second implementation that can drift.
//
//   node scripts/resolve-bin.mjs <bin>   prints the absolute path, exit 0
//                                        exit 1 and no stdout when absent
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const name = process.argv[2];
  if (!name) {
    console.error("usage: resolve-bin.mjs <binary-name>");
    process.exit(2);
  }
  const found = findBin(name);
  if (!found) {
    process.stderr.write(`not found: ${name} (PATH plus every version-manager global bin was probed)\n`);
    process.exit(1);
  }
  process.stdout.write(`${found}\n`);
  process.exit(0);
}
