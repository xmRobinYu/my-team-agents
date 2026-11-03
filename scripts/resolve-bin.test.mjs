import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  binCandidates,
  findBin,
  missingBinError,
  resetBinCache,
} from "./resolve-bin.mjs";

const BIN = process.platform === "win32" ? "lark-cli.cmd" : "lark-cli";

/** A throwaway HOME containing only the layout a test names. */
const fakeHome = (t, dirs) => {
  const home = join(tmpdir(), `lark-resolver-${t}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  for (const d of dirs) mkdirSync(join(home, d), { recursive: true });
  return home;
};

const putBinary = (path, mode = 0o755) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, mode);
};

test("an explicit MTA_BIN_LARK_CLI wins over everything else", () => {
  const home = fakeHome("override", []);
  const got = binCandidates({
    home,
    pathEnv: "/usr/bin",
    env: { MTA_BIN_LARK_CLI: "/opt/custom/lark-cli" },
  });
  assert.equal(got[0], "/opt/custom/lark-cli");
  rmSync(home, { recursive: true, force: true });
});

test("PATH is searched before version-manager directories", () => {
  const home = fakeHome("path-first", []);
  const got = binCandidates({ home, pathEnv: [`/a`, `/b`].join(delimiter), env: {} });
  assert.deepEqual(got.slice(0, 2), [join("/a", BIN), join("/b", BIN)]);
  rmSync(home, { recursive: true, force: true });
});

test("fnm version directories are ordered newest-first", () => {
  const home = fakeHome("fnm-order", [
    join("Library", "Application Support", "fnm", "node-versions", "v22.22.1", "installation", "bin"),
    join("Library", "Application Support", "fnm", "node-versions", "v26.13.0", "installation", "bin"),
    join("Library", "Application Support", "fnm", "node-versions", "v9.11.2", "installation", "bin"),
  ]);
  const got = binCandidates({ home, pathEnv: "", env: {} });
  const fnm = got.filter((p) => p.includes("node-versions"));
  assert.deepEqual(
    fnm.map((p) => p.match(/node-versions\/(.+?)\//)[1]),
    ["v26.13.0", "v22.22.1", "v9.11.2"],
    "a higher minor/major must win, not a lexicographic sort (v9 would beat v26)",
  );
  rmSync(home, { recursive: true, force: true });
});

test("the real-world failure is resolved: binary under another node version", () => {
  // This is the exact shape that broke sync: PATH points at node v26, lark-cli
  // lives in node v22's global bin. findBin must still return the path.
  const home = fakeHome("starved", [
    join("Library", "Application Support", "fnm", "node-versions", "v22.22.1", "installation", "bin"),
  ]);
  putBinary(join(home, "Library", "Application Support", "fnm", "node-versions", "v22.22.1", "installation", "bin", BIN));
  resetBinCache();
  const got = findBin("lark-cli",{ home, pathEnv: "/nowhere", env: {} });
  assert.equal(got, join(home, "Library", "Application Support", "fnm", "node-versions", "v22.22.1", "installation", "bin", BIN));
  rmSync(home, { recursive: true, force: true });
});

test("a non-executable candidate is skipped, not returned", () => {
  const home = fakeHome("not-exec", []);
  const p = join(home, "lark-cli");
  writeFileSync(p, "not a binary\n");
  chmodSync(p, 0o644);
  resetBinCache();
  assert.equal(findBin("lark-cli",{ home, pathEnv: "", env: {} }), null);
  rmSync(home, { recursive: true, force: true });
});

test("a directory named lark-cli is not mistaken for the binary", () => {
  const home = fakeHome("is-dir", [join("Library", "Application Support", "fnm", "node-versions", "v1.0.0", "installation", "bin", BIN)]);
  resetBinCache();
  assert.equal(findBin("lark-cli",{ home, pathEnv: "", env: {} }), null);
  rmSync(home, { recursive: true, force: true });
});

test("the missing-binary error names every path it tried", () => {
  const home = fakeHome("missing", []);
  const message = missingBinError("lark-cli", { home, pathEnv: "/a:/b", env: {} }).message;
  assert.match(message, /\/a\//);
  assert.match(message, /\/b\//);
  assert.match(message, /MTA_BIN_LARK_CLI/, "the override must be advertised or the next person hunts again");
  rmSync(home, { recursive: true, force: true });
});

test("candidates are deduplicated (a PATH entry repeated is one probe)", () => {
  const home = fakeHome("dedupe", []);
  const got = binCandidates({ home, pathEnv: [`/usr/bin`, `/usr/bin`].join(delimiter), env: {} });
  assert.equal(got.filter((p) => p === join("/usr/bin", BIN)).length, 1);
  rmSync(home, { recursive: true, force: true });
});

test("another binary under a version-manager dir resolves too (pi)", () => {
  // Same shape as the lark-cli failure: `pi` is installed under fnm node v22's
  // global bin, but the shell runs node v26, so PATH never contains it.
  const home = fakeHome("pi", [
    join("Library", "Application Support", "fnm", "node-versions", "v22.22.1", "installation", "bin"),
  ]);
  putBinary(join(home, "Library", "Application Support", "fnm", "node-versions", "v22.22.1", "installation", "bin", "pi"));
  resetBinCache();
  const got = findBin("pi", { home, pathEnv: "/nowhere", env: {} });
  assert.match(got, /v22\.22\.1\/installation\/bin\/pi$/);
  rmSync(home, { recursive: true, force: true });
});

test("MTA_BIN_LARK_CLI does not hijack a different binary", () => {
  // The override is lark-cli-specific on purpose: pointing it at lark-cli must
  // not make findBin("pi") return that path.
  const home = fakeHome("no-hijack", []);
  const got = binCandidates({ home, pathEnv: "", env: { MTA_BIN_LARK_CLI: "/opt/custom/lark-cli" }, bin: "pi" });
  assert.equal(got.includes("/opt/custom/lark-cli"), false);
  rmSync(home, { recursive: true, force: true });
});
