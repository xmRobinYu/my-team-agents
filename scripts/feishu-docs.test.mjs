import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { isPlaceholder, placeholderOf, provisioningProblem, validate } from "./sync-feishu-docs.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, "scripts", "sync-feishu-docs.mjs");

/* ------------------------------------------------------------------ fixtures */

// Real ids from the committed manifest: opaque, mixed case, 27 characters.
const REAL_NODE = "PiTYw5Yq6i6dbskNa0iczsJ8nIG";
const REAL_DOC = "DZb6dNUuHouWtVx8G2lcNC5Gnlg";

/** Entry shaped like docs/feishu-sync.json; ids unique per source. */
const entry = (source, node_token, document_id) => ({
  source,
  node: source,
  node_token: node_token ?? real(source, "n"),
  document_id: document_id ?? real(source, "d"),
});

/** A 27-char mixed-case stand-in for a real id (same shape, never a placeholder). */
function real(source, kind) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let salt = 0;
  for (const ch of `${kind}:${source}`) salt = (salt * 31 + ch.charCodeAt(0)) % 1_000_003;
  let out = "";
  for (let i = 0; i < 27; i += 1) {
    salt = (salt * 1103515245 + 12345) % 2 ** 31;
    out += alphabet[salt % alphabet.length];
  }
  return out;
}

/** Sources that exist on disk, so `source not found` never fires by accident. */
const LIVE_SOURCES = ["docs/wiki-overview.md", "AGENTS.md", "CONTEXT.md"];
const managed = (sources = LIVE_SOURCES) => new Set(sources);

/* ---------------------------------------------------------- placeholder test */

test("isPlaceholder recognises every provisioning marker", () => {
  for (const v of [
    "PENDING_FIRST_SYNC",
    "PENDING_FIRST_SYNC_ISSUES",
    "PENDING_anything",
    "TODO_create_node",
    "PLACEHOLDER",
    "placeholder_xyz",
    "  PENDING_PADDED  ",
  ]) {
    assert.equal(isPlaceholder(v), true, `${JSON.stringify(v)} should be a placeholder`);
  }
});

test("isPlaceholder leaves real ids and empty values alone", () => {
  assert.equal(REAL_NODE.length, 27);
  // Real ids are never placeholders.
  for (const v of [REAL_NODE, REAL_DOC, "WxxtdqfdDohIV2xJ0cWc02v2nvb"]) {
    assert.equal(isPlaceholder(v), false, `${v} is a real id`);
  }
  // Empty is a missing field, owned by the `entry missing "document_id"` check.
  // Counting it as a placeholder too would double-report one fault.
  for (const v of [null, undefined, "", "   ", 0, false, {}]) {
    assert.equal(isPlaceholder(v), false, `${String(v)} is not a placeholder`);
  }
});

test("placeholderOf checks both id columns", () => {
  assert.equal(placeholderOf(entry("AGENTS.md", "PENDING_NODE", "PENDING_DOC")).key, "node_token");
  assert.equal(placeholderOf(entry("AGENTS.md", REAL_NODE, "TODO_DOC")).key, "document_id");
  assert.equal(placeholderOf(entry("AGENTS.md", "PENDING_NODE", "TODO_DOC")).value, "PENDING_NODE");
  // Two real ids -> nothing pending.
  assert.equal(placeholderOf(entry("AGENTS.md")), null);
  assert.equal(placeholderOf({ source: "AGENTS.md" }), null, "absent ids are not placeholders");
});

/* -------------------------------------------------------------------- split */

test("validate separates pending provisioning from real problems", () => {
  const docs = [
    entry("docs/wiki-overview.md"),
    entry("AGENTS.md", "PENDING_FIRST_SYNC", "PENDING_FIRST_SYNC"),
    entry("CONTEXT.md", "PENDING_FIRST_SYNC_ISSUES", "PENDING_FIRST_SYNC_ISSUES"),
  ];
  const { problems, pending } = validate(docs, managed());
  // Placeholders are a state, not an error: nothing here is actionable in CI.
  assert.deepEqual(problems, []);
  assert.deepEqual(pending, [
    { source: "AGENTS.md", node: "PENDING_FIRST_SYNC" },
    { source: "CONTEXT.md", node: "PENDING_FIRST_SYNC_ISSUES" },
  ]);
});

test("a placeholder on either column marks the entry pending", () => {
  const one = managed(["docs/wiki-overview.md"]);
  const a = validate([entry("docs/wiki-overview.md", "PENDING_NODE", REAL_DOC)], one);
  assert.deepEqual(a.problems, []);
  assert.deepEqual(a.pending, [{ source: "docs/wiki-overview.md", node: "PENDING_NODE" }]);

  const b = validate([entry("docs/wiki-overview.md", REAL_NODE, "TODO_DOC")], one);
  assert.deepEqual(b.problems, []);
  assert.deepEqual(b.pending, [{ source: "docs/wiki-overview.md", node: "TODO_DOC" }]);
});

test("clean mapping produces neither problems nor pending entries", () => {
  const { problems, pending } = validate(
    LIVE_SOURCES.map((s) => entry(s)),
    managed(),
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(pending, []);
});

/* ------------------------------------------- existing checks stay enforced */

test("a missing document_id is still a real problem, not a pending entry", () => {
  const { problems, pending } = validate([entry("AGENTS.md", REAL_NODE, "")], managed(["AGENTS.md"]));
  assert.equal(problems.filter((p) => p.includes('missing "document_id"')).length, 1);
  assert.deepEqual(pending, [], "empty value must not be reclassified as pending");
});

test("a source that does not exist is still a real problem", () => {
  const docs = [entry("docs/does-not-exist-here.md")];
  const { problems } = validate(docs, managed(["docs/does-not-exist-here.md"]));
  assert.equal(problems.filter((p) => p.includes("source not found")).length, 1);
});

test("duplicates and out-of-surface entries are still real problems", () => {
  const dup = validate(
    [entry("AGENTS.md"), entry("AGENTS.md", REAL_NODE, "QqqtdqfdDohIV2xJ0cWc02v2nvb")],
    managed(["AGENTS.md"]),
  );
  assert.ok(dup.problems.some((p) => p.includes("duplicate source")));

  const dupId = validate(
    [entry("AGENTS.md", REAL_NODE, REAL_DOC), entry("CONTEXT.md", "ZzztdqfdDohIV2xJ0cWc02v2nvb", REAL_DOC)],
    managed(["AGENTS.md", "CONTEXT.md"]),
  );
  assert.ok(dupId.problems.some((p) => p.includes("duplicate document_id")));

  const outside = validate([entry("docs/wiki-overview.md")], managed(["AGENTS.md"]));
  assert.ok(outside.problems.some((p) => p.includes("not in manifest")));
  assert.ok(outside.problems.some((p) => p.includes("outside the managed surface")));
});

test("placeholder values that repeat across entries are still duplicate ids", () => {
  const { problems } = validate(
    [entry("AGENTS.md", "PENDING_X", "PENDING_X"), entry("CONTEXT.md", "PENDING_Y", "PENDING_X")],
    managed(),
  );
  assert.ok(problems.some((p) => p.includes("duplicate document_id")));
});

/* ------------------------------------------------------------- live manifest */

test("the live manifest validates with zero problems", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "docs", "feishu-sync.json"), "utf8"));
  const { problems, pending } = validate(manifest.documents);
  assert.deepEqual(problems, []);
  // No count is pinned here on purpose. Adding a document under docs/ MUST NOT
  // require editing this test: the managed surface is a directory walk, so a
  // literal count would only make the mapping check look like it can be trusted
  // while it actually re-pins whatever the last author saw.
  assert.ok(pending.every((p) => manifest.documents.some((d) => d.source === p.source)));
});

/* ------------------------------------------------------------ sync rejection */

test("syncOne refuses a placeholder entry before calling lark-cli", () => {
  const SPACE = "7701231058624187646";
  const msg = provisioningProblem(
    entry("docs/prd/multi-agent-group-chat.md", "PENDING_FIRST_SYNC", "PENDING_FIRST_SYNC"),
    SPACE,
  );
  assert.ok(msg);
  assert.match(msg, /^docs\/prd\/multi-agent-group-chat\.md 的飞书节点尚未开通（node_token=PENDING_FIRST_SYNC）；/);
  assert.match(msg, /wiki space 7701231058624187646 创建节点/);
  assert.match(msg, /写回 docs\/feishu-sync\.json，再重跑 just sync-docs$/);
  // Nothing in the message looks like an auth error, so credential failures stay
  // distinguishable from "not provisioned yet" in the `just sync-docs` log.
  assert.doesNotMatch(msg, /auth|keychain|credential|token expired/i);

  const missing = provisioningProblem(entry("docs/prd/multi-agent-group-chat-issues.md"), SPACE);
  assert.equal(missing, null, "real ids must not be refused");
  assert.equal(provisioningProblem({ source: "AGENTS.md" }, SPACE), null);
});

test("--check exits 0 and states ready/pending separately", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "--check"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  const out = res.stdout;
  const listed = out.split("\n").filter((l) => /^  (docs\/|AGENTS\.md|CONTEXT\.md)/.test(l) && !/->/.test(l));
  // The header must not lie about coverage: every listed source is accounted for,
  // split into provisioned and pending, whatever the manifest currently holds.
  const m = /feishu sync mapping OK: (\d+) documents \((\d+) ready, (\d+) pending provisioning\)/.exec(out);
  assert.ok(m, `unexpected --check header:\n${out}`);
  const [, total, ready, pend] = m.map(Number);
  assert.equal(ready + pend, total, "ready + pending must equal the document count");
  assert.equal(total, listed.length, "every managed source must be listed");
  assert.equal(out.split("\n").filter((l) => /^  PENDING /.test(l)).length, pend);
});
