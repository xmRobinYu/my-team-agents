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
 * NOT fail it: clearing one means creating the Feishu node first, which no CI run
 * can do. They are refused by the sync path instead, with an actionable message.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  const res = spawnSync("lark-cli", args, {
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

  if (res.error?.code === "ENOENT") {
    throw new Error("lark-cli not found on PATH — install it and run `lark-cli auth login`");
  }
  if (res.error) throw new Error(`lark-cli ${args[1] ?? ""} failed: ${res.error.message}`);

  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(
      `lark-cli returned non-JSON output (exit ${res.status}):\n` +
        (res.stdout || res.stderr || "").slice(0, 800),
    );
  }
}

/**
 * Why this entry cannot be synced yet, or null when its ids are real.
 * Kept separate from syncOne so it is testable without touching lark-cli.
 */
export function provisioningProblem(doc, spaceId) {
  const ph = placeholderOf(doc);
  if (!ph) return null;
  return (
    `${doc.source} 的飞书节点尚未开通（${ph.key}=${ph.value}）；` +
    `请先在 wiki space ${spaceId} 创建节点，` +
    `把真实 node_token/document_id 写回 docs/feishu-sync.json，再重跑 just sync-docs`
  );
}

function syncOne(doc, spaceId) {
  // Refuse a placeholder before touching lark-cli. Letting it through would make the
  // CLI fail on an id matching no document, and the message reads like an auth /
  // Keychain problem — the two root causes would be indistinguishable in the log.
  const pending = provisioningProblem(doc, spaceId);
  if (pending) throw new Error(pending);

  const update = runLark([
    "docs",
    "+update",
    "--doc",
    doc.document_id,
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
      doc.document_id,
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
      const rev = syncOne(doc, manifest.space_id);
      console.log(`synced ${doc.source} -> ${doc.node} (revision ${rev})`);
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
