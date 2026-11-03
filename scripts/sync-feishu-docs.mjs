#!/usr/bin/env node
/**
 * One-way mirror: repo Markdown -> Feishu wiki (my-team-agents space).
 *
 * The repo is the source of truth. Sync overwrites the Feishu copy of each
 * mapped document, then reads it back to prove the write landed.
 *
 * Usage:
 *   node scripts/sync-feishu-docs.mjs                          # sync all
 *   node scripts/sync-feishu-docs.mjs docs/architecture.md     # sync a subset
 *   node scripts/sync-feishu-docs.mjs --check                  # offline check
 *
 * --check is the CI-enforceable surface: mapping is complete and every managed
 * source is registered. The network sync needs a local `lark-cli` user
 * credential, so it deliberately cannot run in CI. Entries whose ids are still
 * placeholders ("pending provisioning") are counted and listed by --check but do
 * NOT fail it: clearing one means creating the Feishu node, which no CI run can do
 * (it has no credential). The sync path creates the node itself and writes the real
 * ids back into this manifest, so a pending entry is a to-do, not a manual chore.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findBin, missingBinError } from "./resolve-bin.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST = join(ROOT, "docs", "feishu-sync.json");
const DOCS_DIR = join(ROOT, "docs");
const ALWAYS_MANAGED = ["AGENTS.md", "CONTEXT.md"];

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** Managed surface: the two rule docs + every Markdown file under docs/. */
function collectManaged() {
  const managed = new Set();
  for (const p of ALWAYS_MANAGED) {
    if (existsSync(join(ROOT, p))) managed.add(p);
  }
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), `${rel}${e.name}/`);
      else if (e.name.endsWith(".md")) managed.add(`${rel}${e.name}`);
    }
  };
  if (existsSync(DOCS_DIR)) walk(DOCS_DIR, "docs/");
  return managed;
}

/** First `# ` heading — used as the read-back probe after a write. */
function firstHeading(source) {
  const line = readFileSync(join(ROOT, source), "utf8")
    .split("\n")
    .find((l) => l.startsWith("# "));
  return line ? line.slice(2).trim() : null;
}

/**
 * Does this value look like a placeholder rather than a real Feishu id?
 *
 * Real node_token / document_id values are opaque ~27-char mixed-case ids and never
 * start with these markers; a provisioning placeholder does ("PENDING_FIRST_SYNC",
 * "TODO_...", "PLACEHOLDER..."). Empty values are NOT placeholders: they are already
 * reported by the `entry missing "document_id"` check below, so counting them twice
 * would double-report one fault.
 */
export function isPlaceholder(value) {
  return typeof value === "string" && /^(PENDING_|TODO_|PLACEHOLDER)/i.test(value.trim());
}

const ID_KEYS = ["node_token", "document_id"];

/** The first placeholder id on an entry, or null when every id is real. */
export function placeholderOf(doc) {
  for (const key of ID_KEYS) {
    if (isPlaceholder(doc[key])) return { key, value: doc[key].trim() };
  }
  return null;
}

/**
 * Structural validation of the mapping.
 *
 * Returns `{ problems, pending }`:
 *  - `problems` — real errors only (missing field, duplicate, source not found,
 *    entry outside the managed surface). Unchanged behaviour from before.
 *  - `pending` — entries whose ids are placeholders: `{ source, node }`. Not errors,
 *    because clearing a placeholder requires creating the wiki node, an external
 *    action `--check` cannot take (and CI has no lark-cli credential at all). See
 *    the `--check` branch for how the state is reported instead of failed.
 */
export function validate(documents, managed = collectManaged()) {
  const problems = [];
  const pending = [];
  const seenSource = new Set();
  const seenDoc = new Set();

  for (const d of documents) {
    for (const key of ["source", "document_id"]) {
      if (!d[key]) problems.push(`entry missing "${key}": ${JSON.stringify(d)}`);
    }
    if (d.source) {
      if (seenSource.has(d.source)) problems.push(`duplicate source: ${d.source}`);
      seenSource.add(d.source);
      if (!existsSync(join(ROOT, d.source))) problems.push(`source not found: ${d.source}`);
    }
    if (d.document_id) {
      if (seenDoc.has(d.document_id)) problems.push(`duplicate document_id: ${d.document_id}`);
      seenDoc.add(d.document_id);
    }
    const ph = placeholderOf(d);
    if (ph) pending.push({ source: d.source, node: ph.value });
  }

  for (const s of managed) {
    if (!seenSource.has(s)) problems.push(`managed doc not in manifest: ${s}`);
  }
  for (const d of documents) {
    if (d.source && !managed.has(d.source)) {
      problems.push(`manifest entry is outside the managed surface: ${d.source}`);
    }
  }

  return { problems, pending };
}

function runLark(args) {
  const bin = findBin("lark-cli");
  if (!bin) throw missingBinError("lark-cli");

  const res = spawnSync(bin, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
    env: {
      ...process.env,
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
    },
  });

  if (res.error) throw new Error(`lark-cli ${args[1] ?? ""} failed: ${res.error.message}`);

  // lark-cli leaves stdout empty on a rejected call and writes the failure JSON to
  // stderr, so both streams must be considered. Reading only stdout turned real
  // errors into "non-JSON output" -- exactly the indistinguishable-root-cause
  // problem this script elsewhere claims to avoid. Same handling as
  // sync-feishu-bitable.mjs, so one API failure reads the same in both logs.
  const payload = [res.stdout, res.stderr]
    .map((x) => (x ?? "").trim())
    .find((x) => x.startsWith("{") || x.startsWith("["));

  let parsed;
  try {
    parsed = JSON.parse(payload ?? "");
  } catch {
    throw new Error(
      `lark-cli returned no JSON output (exit ${res.status}):\n` +
        ((res.stderr || res.stdout || "").trim().slice(0, 800) || "(no output)"),
    );
  }
  if (parsed.ok === false) {
    const e = parsed.error ?? {};
    const credential = e.subtype === "storage" || /keychain|token_missing|need_user_authorization/i.test(String(e.message ?? ""));
    throw new Error(
      `lark-cli ${args.slice(0, 2).join(" ")} rejected: ${e.message ?? JSON.stringify(e).slice(0, 400)}` +
        (credential
          ? ` — no usable user credential for this profile. Run: lark-cli auth login --profile='<profile>' --domain docs,wiki,drive --recommend`
          : ""),
    );
  }
  return parsed;
}

/**
 * Extract the ids a created wiki node must give back, or null when the response
 * carries neither token. Pure so the parse is testable without lark-cli.
 *
 * A docx wiki node answers with `node_token` (the wiki entry) and `obj_token`
 * (the document itself, i.e. what `docs +update --doc` wants). Both are read off
 * the response shape `sync-feishu-bitable.mjs` already relies on, because two
 * scripts guessing at the same API in two different ways is how they drift.
 */
export function createdNodeIds(res) {
  const node = res?.data?.node ?? res?.node ?? res?.data ?? {};
  const pick = (key) => {
    if (node[key]) return node[key];
    const walk = (v) => {
      if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (k === key && typeof x === "string" && x) return x;
          const hit = walk(x);
          if (hit) return hit;
        }
      }
      return null;
    };
    return walk(res);
  };
  const nodeToken = pick("node_token");
  const documentId = pick("obj_token") ?? pick("document_id");
  if (!nodeToken && !documentId) return null;
  return { nodeToken, documentId };
}

/**
 * The node_token of an entry whose wiki node already exists but whose document_id
 * is still a placeholder, else null.
 *
 * This state is reachable for real: `ensureNode` writes the node_token before the
 * body is pushed, precisely so an interrupted run does not create a duplicate node.
 * Recognising it is what makes that write-back safe rather than half-done.
 */
export function halfProvisionedNodeToken(doc) {
  const node = doc?.node_token;
  if (typeof node !== "string" || node.length === 0 || isPlaceholder(node)) return null;
  const document = doc?.document_id;
  // An empty document_id counts as missing: placeholderOf deliberately does not
  // treat "" as a placeholder (the `entry missing "document_id"` problem already
  // reports it), so without this branch the two checks would disagree here.
  if (typeof document === "string" && document.length > 0 && !isPlaceholder(document)) return null;
  return node;
}

/**
 * Create the missing wiki node and return the manifest entry carrying real ids.
 *
 * This used to be a human step -- the script refused a placeholder and told
 * someone to create the node in Feishu and paste the ids back. That is exactly
 * the work `wiki +node-create` does, and the bitable sync already provisions its
 * own Base, so refusing here was an inconsistency, not a safety property: the
 * placeholder stayed pending until a person happened to have an authorized
 * terminal, which is the state that never arrived.
 *
 * The refusal is still real when creation cannot happen (no user credential, no
 * title to name the node with) -- the error says which, and never reads like a
 * keychain problem.
 */
function ensureNode(doc, spaceId, identity) {
  const ph = placeholderOf(doc);
  if (!ph) return doc;

  // Half-provisioned is the dangerous state: a real node_token with a placeholder
  // document_id means the node EXISTS and a re-run must not create another one.
  // So resolve from the node we already have instead of falling through to create.
  const existingNode = halfProvisionedNodeToken(doc);
  if (existingNode) {
    console.log(`  node ${existingNode} exists but has no document_id; resolving`);
    const documentId = resolveDocumentId(existingNode, identity);
    const next = { ...doc, node_token: existingNode, document_id: documentId };
    delete next._note;
    writeManifestEntry(next);
    return next;
  }

  const title = (doc.node ?? "").trim();
  if (!title) {
    throw new Error(
      `${doc.source} 的节点尚未开通（${ph.key}=${ph.value}），但 manifest 里没有 node 标题可以建；` +
        `先给这条目补上标题再重跑 just sync-docs`,
    );
  }
  console.log(`  provisioning wiki node "${title}" under space ${spaceId}`);
  const res = runLark([
    "wiki",
    "+node-create",
    "--space-id",
    spaceId,
    "--obj-type",
    "docx",
    "--node-type",
    "origin",
    "--title",
    title,
    "--as",
    identity,
    "--format",
    "json",
  ]);
  if (res.ok === false) {
    throw new Error(`node create rejected for ${doc.source}: ${JSON.stringify(res).slice(0, 400)}`);
  }
  const ids = createdNodeIds(res);
  if (!ids?.nodeToken) {
    throw new Error(
      `node created for ${doc.source} but the response carries no node_token: ` +
        JSON.stringify(res).slice(0, 400),
    );
  }
  // Persist the node_token **immediately**, before anything else can fail, and
  // before the body is pushed. A manifest that still says PENDING after a node was
  // physically created makes the next run build a second node for the same
  // document; a duplicate is worse than a node one revision behind, and only the
  // duplicate is hard to undo.
  const staged = { ...doc, node_token: ids.nodeToken, document_id: ids.documentId ?? "" };
  delete staged._note;
  writeManifestEntry(staged);
  if (ids.documentId) return staged;
  const documentId = resolveDocumentId(ids.nodeToken, identity);
  const next = { ...staged, document_id: documentId };
  writeManifestEntry(next);
  return next;
}

/** Read the docx `obj_token` of a wiki node that was created but not described. */
function resolveDocumentId(nodeToken, identity) {
  const res = runLark([
    "wiki",
    "+node-get",
    "--node-token",
    nodeToken,
    "--as",
    identity,
    "--format",
    "json",
  ]);
  const ids = createdNodeIds(res);
  if (!ids?.documentId) {
    throw new Error(
      `wiki node ${nodeToken} exists but its document_id could not be resolved from +node-get: ` +
        JSON.stringify(res).slice(0, 400) +
        ` — 节点已建好，把它的 obj_token 填进 docs/feishu-sync.json 的 document_id 再重跑`,
    );
  }
  return ids.documentId;
}

/** Replace one entry in docs/feishu-sync.json, preserving the file's shape. */
function writeManifestEntry(entry) {
  const manifest = readJson(MANIFEST);
  const next = {
    ...manifest,
    documents: (manifest.documents ?? []).map((d) => (d.source === entry.source ? entry : d)),
  };
  const header = readFileSync(MANIFEST, "utf8");
  writeFileSync(
    MANIFEST,
    `${JSON.stringify(next, null, 2)}${header.endsWith("\n") ? "\n" : ""}`,
    "utf8",
  );
  console.log(
    `  node_token=${entry.node_token} document_id=${entry.document_id} (written back to docs/feishu-sync.json — commit it)`,
  );
}

function syncOne(doc, spaceId, identity) {
  // Provision first, then write. A placeholder id would otherwise make the CLI fail
  // on a document that matches nothing, and that error reads like an auth problem —
  // the two root causes have to stay distinguishable in the log.
  // Everything below must read the ids off `resolved`: for a pending entry `doc`
  // still carries the placeholder, and pushing markdown to a placeholder document id
  // is exactly the indistinguishable failure this function exists to avoid.
  const resolved = ensureNode(doc, spaceId, identity);

  const update = runLark([
    "docs",
    "+update",
    "--doc",
    resolved.document_id,
    "--command",
    "overwrite",
    "--doc-format",
    "markdown",
    "--content",
    `@./${doc.source}`,
    "--as",
    "user",
    "--format",
    "json",
  ]);

  if (update.ok !== true) {
    throw new Error(`update rejected: ${JSON.stringify(update).slice(0, 500)}`);
  }
  const result = update.data?.result;
  if (result !== undefined && result !== "success") {
    throw new Error(`update result="${result}"`);
  }
  for (const w of update.data?.warnings ?? []) {
    console.warn(`  warning: ${typeof w === "string" ? w : JSON.stringify(w)}`);
  }

  const probe = firstHeading(doc.source);
  if (probe) {
    const fetched = runLark([
      "docs",
      "+fetch",
      "--doc",
      resolved.document_id,
      "--scope",
      "keyword",
      "--keyword",
      probe,
      "--as",
      "user",
      "--format",
      "json",
    ]);
    if (fetched.ok !== true) {
      throw new Error(`read-back failed for heading "${probe}"`);
    }
  }

  return update.data?.document?.revision_id ?? "?";
}

function main() {
  const isCheck = process.argv[2] === "--check";
  const filters = process.argv.slice(isCheck ? 3 : 2).filter((a) => !a.startsWith("-"));

  const manifest = readJson(MANIFEST);
  const documents = manifest.documents ?? [];
  const { problems, pending } = validate(documents);

  if (problems.length > 0) {
    console.error("docs/feishu-sync.json has problems:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  if (isCheck) {
    const sorted = documents.map((d) => d.source).sort();
    // Placeholder entries are reported, never failed. Un-pending a placeholder means
    // creating the wiki node in Feishu first — an external action CI cannot take (the
    // network sync is deliberately outside CI: it needs a local lark-cli credential).
    // Failing the gate there would park it on a state nobody can clear in CI; staying
    // silent would make this line lie about coverage. So: exit 0, count both classes
    // and name every pending source. Do not "tidy" this into a failure.
    const head =
      pending.length === 0
        ? `feishu sync mapping OK: ${sorted.length} documents, space ${manifest.space_id}`
        : `feishu sync mapping OK: ${sorted.length} documents ` +
          `(${sorted.length - pending.length} ready, ${pending.length} pending provisioning), ` +
          `space ${manifest.space_id}`;
    console.log(head);
    for (const s of sorted) console.log(`  ${s}`);
    for (const p of pending) console.log(`  PENDING ${p.source} -> ${p.node}`);
    process.exit(0);
  }

  for (const f of filters) {
    if (!documents.some((d) => d.source === f)) {
      console.error(`not in manifest: ${f}`);
      console.error(`mapped: ${documents.map((d) => d.source).sort().join(", ")}`);
      process.exit(1);
    }
  }

  const targets =
    filters.length === 0 ? documents : documents.filter((d) => filters.includes(d.source));

  let failed = 0;
  for (const doc of targets) {
    try {
      const rev = syncOne(doc, manifest.space_id, manifest.identity ?? "user");
      console.log(`synced ${doc.source} -> ${doc.node ?? doc.source} (revision ${rev})`);
    } catch (err) {
      failed += 1;
      console.error(`FAILED ${doc.source}: ${err.message}`);
    }
  }

  if (failed > 0) {
    console.error(`${failed}/${targets.length} document(s) failed to sync`);
    process.exit(1);
  }
  console.log(`all ${targets.length} document(s) synced to Feishu space ${manifest.space_id}`);
}

// Executes when run directly (`node scripts/sync-feishu-docs.mjs`, `just verify-docs`,
// CI); stays inert when scripts/feishu-docs.test.mjs imports the pure helpers above.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
