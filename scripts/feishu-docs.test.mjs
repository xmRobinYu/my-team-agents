import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  createdNodeIds,
  halfProvisionedNodeToken,
  isPlaceholder,
  placeholderOf,
  validate,
} from "./sync-feishu-docs.mjs";

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

/* -------------------------------------------------- node provisioning */

test("createdNodeIds reads the wiki node's two tokens out of every response shape", () => {
  // A docx wiki node answers with node_token (the wiki entry) and obj_token (the
  // document that docs +update wants). The CLI nests that under data.node, data,
  // or the top level depending on the call, so guessing one shape would make
  // provisioning fail on a successful create.
  const shapes = [
    { ok: true, data: { node: { node_token: "N1", obj_token: "D1" } } },
    { ok: true, node: { node_token: "N2", obj_token: "D2" } },
    { ok: true, data: { node_token: "N3", obj_token: "D3" } },
    { ok: true, data: { deep: { nested: { node_token: "N4", obj_token: "D4" } } } },
  ];
  for (const [i, res] of shapes.entries()) {
    const ids = createdNodeIds(res);
    assert.equal(ids.nodeToken, `N${i + 1}`, `shape ${i} node_token`);
    assert.equal(ids.documentId, `D${i + 1}`, `shape ${i} obj_token`);
  }
});

test("createdNodeIds falls back to document_id and refuses when neither token exists", () => {
  assert.deepEqual(
    createdNodeIds({ ok: true, data: { node: { node_token: "N", document_id: "D" } } }),
    { nodeToken: "N", documentId: "D" },
  );
  // Returning null (not a half-filled object) is what makes ensureNode say
  // "created but no ids" instead of writing an empty document_id into the manifest.
  assert.equal(createdNodeIds({ ok: true, data: { node: { title: "x" } } }), null);
  assert.equal(createdNodeIds({}), null);
});

test("every pending manifest entry carries a title, or provisioning cannot name the node", () => {
  // ensureNode creates the node from `node` (the Feishu title). An entry added with
  // a placeholder id and no title would fail at sync time with a message about a
  // missing title — this catches it offline, in the gate that actually runs in CI.
  // Deliberately no assertion that pending entries EXIST: provisioning is supposed
  // to drain them, so requiring a non-empty set would fail the day the sync works.
  const manifest = JSON.parse(readFileSync(join(ROOT, "docs", "feishu-sync.json"), "utf8"));
  for (const d of manifest.documents) {
    if (!placeholderOf(d)) continue;
    assert.ok(
      typeof d.node === "string" && d.node.trim().length > 0,
      `${d.source} is pending but has no node title to create`,
    );
  }
});

test("createdNodeIds parses the real lark-cli +node-get response shape", () => {
  // Captured from `lark-cli wiki +node-get --node-token <architecture node> --as bot`
  // against the live wiki space. The tokens are the real ones already recorded in
  // docs/feishu-sync.json, which is what proves the premise of ensureNode: a docx
  // wiki node's `obj_token` IS the `document_id` that `docs +update --doc` wants.
  // Without this, provisioning would be writing a token of the wrong kind back into
  // the manifest and every later sync would fail on it.
  const real = {
    ok: true,
    identity: "bot",
    data: {
      creator: "ou_92c7cd79651ce045f22c7d8e0950de88",
      has_child: false,
      node_token: "GVw5wkAyfibD8pkUJaxcuZWCnUe",
      node_type: "origin",
      obj_token: "WxxtdqfdDohIV2xJ0cWc02v2nvb",
      obj_type: "docx",
      origin_node_token: "GVw5wkAyfibD8pkUJaxcuZWCnUe",
      parent_node_token: "",
      space_id: "7701231058624187646",
      title: "my-team-agents 架构设计",
    },
  };
  assert.deepEqual(createdNodeIds(real), {
    nodeToken: "GVw5wkAyfibD8pkUJaxcuZWCnUe",
    documentId: "WxxtdqfdDohIV2xJ0cWc02v2nvb",
  });

  // The same tokens the repo already trusts for this document.
  const manifest = JSON.parse(readFileSync(join(ROOT, "docs", "feishu-sync.json"), "utf8"));
  const arch = manifest.documents.find((d) => d.source === "docs/architecture.md");
  assert.equal(real.data.obj_token, arch.document_id, "obj_token must equal document_id");
  assert.equal(real.data.node_token, arch.node_token);
});

test("a half-provisioned entry is recognised instead of re-created", () => {
  // The dangerous state ensureNode's write-back can leave behind: the wiki node
  // physically exists, only document_id is still a placeholder. Treating that as
  // "not provisioned" would build a second node for the same document.
  assert.equal(
    halfProvisionedNodeToken({ node_token: "GVw5wkAyfibD8pkUJaxcuZWCnUe", document_id: "PENDING_FIRST_SYNC" }),
    "GVw5wkAyfibD8pkUJaxcuZWCnUe",
  );
  // Fully pending must fall through to create; fully ready must not provision at all.
  assert.equal(halfProvisionedNodeToken({ node_token: "PENDING_FIRST_SYNC", document_id: "PENDING_FIRST_SYNC" }), null);
  assert.equal(halfProvisionedNodeToken({ node_token: "N", document_id: "D" }), null);
  assert.equal(halfProvisionedNodeToken({ document_id: "D" }), null);
  assert.equal(halfProvisionedNodeToken({ node_token: "", document_id: "D" }), null);
});

test("--check exits 0 and states ready/pending separately", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "--check"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  const out = res.stdout;
  const listed = out.split("\n").filter((l) => /^  (docs\/|AGENTS\.md|CONTEXT\.md)/.test(l) && !/->/.test(l));
  // Both header shapes must satisfy the same invariant. The parenthetical only
  // appears while something is still pending, and provisioning drains it — so a
  // regex that demanded it would fail the day the sync finally works.
  const split = /feishu sync mapping OK: (\d+) documents \((\d+) ready, (\d+) pending provisioning\)/.exec(out);
  const plain = /feishu sync mapping OK: (\d+) documents, space/.exec(out);
  assert.ok(split || plain, `unexpected --check header:\n${out}`);
  const total = Number((split ?? plain)[1]);
  const pend = split ? Number(split[3]) : 0;
  const ready = split ? Number(split[2]) : total;
  assert.equal(ready + pend, total, "ready + pending must equal the document count");
  assert.equal(total, listed.length, "every managed source must be listed");
  assert.equal(out.split("\n").filter((l) => /^  PENDING /.test(l)).length, pend);
});
