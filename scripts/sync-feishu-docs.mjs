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
 * credential, so it deliberately cannot run in CI.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
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

function validate(documents) {
  const problems = [];
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
  }

  for (const s of collectManaged()) {
    if (!seenSource.has(s)) problems.push(`managed doc not in manifest: ${s}`);
  }
  for (const d of documents) {
    if (d.source && !collectManaged().has(d.source)) {
      problems.push(`manifest entry is outside the managed surface: ${d.source}`);
    }
  }

  return problems;
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

function syncOne(doc) {
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

const isCheck = process.argv[2] === "--check";
const filters = process.argv.slice(isCheck ? 3 : 2).filter((a) => !a.startsWith("-"));

const manifest = readJson(MANIFEST);
const documents = manifest.documents ?? [];
const problems = validate(documents);

if (problems.length > 0) {
  console.error("docs/feishu-sync.json has problems:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

if (isCheck) {
  const sorted = documents.map((d) => d.source).sort();
  console.log(`feishu sync mapping OK: ${sorted.length} documents, space ${manifest.space_id}`);
  for (const s of sorted) console.log(`  ${s}`);
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
    const rev = syncOne(doc);
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
