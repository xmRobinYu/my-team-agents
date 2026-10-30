#!/usr/bin/env node
/**
 * One-way sync: repo Markdown -> Feishu Bitable (多维表格) under the wiki space.
 *
 * The repo stays the single source of truth. This script derives row sets from
 * docs/project-plan.md and CONTEXT.md (see scripts/feishu-bitable.mjs) and
 * upserts them into the Base named in docs/feishu-bitable.json.
 *
 * Usage:
 *   node scripts/sync-feishu-bitable.mjs              # provision if needed, then sync
 *   node scripts/sync-feishu-bitable.mjs --check       # offline: parse + config validation
 *   node scripts/sync-feishu-bitable.mjs --dry-run     # planned writes, no API calls
 *   node scripts/sync-feishu-bitable.mjs --table 项目阶段   # limit to one table
 *   node scripts/sync-feishu-bitable.mjs --allow-mass-removal  # accept a bulk 已移除
 *
 * Idempotency contract (deliberate, not incidental):
 *   - Rows are matched by a stable business key (阶段号 / 里程碑号 / 条目主键 / 风险 / 项),
 *     so re-running updates in place instead of deleting and rebuilding. Delete and
 *     rebuild would destroy user-added columns, user-added rows and every record id.
 *   - Rows that disappear from the docs are flagged 仓库内=已移除, never deleted.
 *   - The 进展记录 table is append-only, deduplicated by content hash, so repeated
 *     runs on an unchanged repo add nothing.
 *
 * The network path needs a local `lark-cli` user credential (macOS Keychain), so it
 * cannot run in CI. `--check` is the enforceable offline surface.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSnapshot,
  validateConfig,
  schemaProblems,
  rowsFor,
  planTable,
  coerce,
  formatLocalMinute,
  massRemovalProblem,
} from "./feishu-bitable.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = join(ROOT, "docs", "feishu-bitable.json");
const PLAN_PATH = join(ROOT, "docs", "project-plan.md");
const CONTEXT_PATH = join(ROOT, "CONTEXT.md");
const PLACEHOLDER = "PENDING_FIRST_PROVISION";

/* ------------------------------------------------------------------ lark-cli */

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

  // lark-cli leaves stdout empty and writes the failure JSON to stderr, so both
  // streams must be considered before calling the output unparsable.
  const payload = [res.stdout, res.stderr]
    .map((s) => (s ?? "").trim())
    .find((s) => s.startsWith("{") || s.startsWith("["));

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
    const credential = e.subtype === "storage" || /keychain/i.test(String(e.message ?? ""));
    throw new Error(
      `lark-cli ${args.slice(0, 2).join(" ")} rejected: ${e.message ?? JSON.stringify(e).slice(0, 400)}` +
        (credential
          ? " — credentials are unreadable from this shell (macOS Keychain). Run the same command from an interactive Terminal; `--check` remains available offline."
          : ""),
    );
  }
  return parsed;
}

function pick(obj, keys) {
  const seen = new Set();
  const walk = (node) => {
    if (node === null || typeof node !== "object" || seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const v of node) {
        const hit = walk(v);
        if (hit !== null) return hit;
      }
      return null;
    }
    for (const k of keys) {
      const v = node[k];
      if (typeof v === "string" && v !== "") return v;
    }
    for (const v of Object.values(node)) {
      const hit = walk(v);
      if (hit !== null) return hit;
    }
    return null;
  };
  return walk(obj);
}

function pickArray(obj, keys) {
  const seen = new Set();
  const walk = (node) => {
    if (node === null || typeof node !== "object" || seen.has(node)) return null;
    seen.add(node);
    for (const k of keys) {
      const v = node[k];
      if (Array.isArray(v)) return v;
    }
    for (const v of Object.values(node)) {
      const hit = walk(v);
      if (hit !== null) return hit;
    }
    return null;
  };
  return walk(obj) ?? [];
}

/* ------------------------------------------------------------------- config */

function ensureNode(config) {
  if (config.base_token && !config.base_token.startsWith(PLACEHOLDER)) {
    return { baseToken: config.base_token, nodeToken: config.node_token, created: false };
  }
  console.log(`provisioning Bitable node "${config.base_title}" under wiki space ${config.space_id}`);
  const res = runLark([
    "wiki",
    "+node-create",
    "--space-id",
    config.space_id,
    "--obj-type",
    "bitable",
    "--node-type",
    "origin",
    "--title",
    config.base_title,
    "--as",
    config.identity ?? "user",
    "--format",
    "json",
  ]);
  const node = res.data?.node ?? res.node ?? res.data ?? {};
  const baseToken = node.obj_token ?? pick(res, ["obj_token"]);
  const nodeToken = node.node_token ?? pick(res, ["node_token"]);
  if (!baseToken) {
    throw new Error(`node created but no obj_token in response: ${JSON.stringify(res).slice(0, 500)}`);
  }
  const next = { ...config, base_token: baseToken, node_token: nodeToken ?? "" };
  writeConfig(next);
  console.log(`  node_token=${nodeToken ?? "?"}`);
  console.log(`  base_token=${baseToken} (written back to docs/feishu-bitable.json — commit it)`);
  return { baseToken, nodeToken, created: true };
}

function writeConfig(config) {
  const header = readFileSync(CONFIG_PATH, "utf8");
  const trailingNewline = header.endsWith("\n");
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}${trailingNewline ? "\n" : ""}`, "utf8");
}

function listTables(baseToken, identity) {
  const res = runLark(["base", "+table-list", "--base-token", baseToken, "--as", identity, "--format", "json"]);
  return pickArray(res, ["tables", "items"])
    .map((t) => ({ id: t.table_id ?? t.id ?? t.token, name: t.name ?? "" }))
    .filter((t) => t.id || t.name);
}

function createTable(baseToken, identity, table) {
  const res = runLark([
    "base",
    "+table-create",
    "--base-token",
    baseToken,
    "--name",
    table.name,
    "--fields",
    JSON.stringify(table.fields),
    "--as",
    identity,
    "--format",
    "json",
  ]);
  const id = pick(res, ["table_id"]);
  if (!id) throw new Error(`table "${table.name}" created but no table_id returned: ${JSON.stringify(res).slice(0, 400)}`);
  return id;
}

function listFields(baseToken, identity, tableId) {
  const res = runLark([
    "base",
    "+field-list",
    "--base-token",
    baseToken,
    "--table-id",
    tableId,
    "--as",
    identity,
    "--format",
    "json",
  ]);
  return pickArray(res, ["fields", "items"]).map((f) => ({ id: f.field_id ?? f.id, name: f.name ?? "", type: f.type ?? "" }));
}

function readRecords(baseToken, identity, tableId, tmpDir, tag) {
  const records = [];
  let offset = 0;
  for (let page = 0; page < 20; page += 1) {
    const outPath = join(tmpDir, `${tag}-${page}.ndjson`);
    const res = runLark([
      "base",
      "+record-list",
      "--base-token",
      baseToken,
      "--table-id",
      tableId,
      "--limit",
      "2000",
      "--offset",
      String(offset),
      "--format",
      "ndjson",
      "--output",
      outPath,
      "--overwrite",
      "--as",
      identity,
    ]);
    const manifestPath = `${outPath.replace(/\.ndjson$/, "")}.manifest.json`;
    if (existsSync(outPath) && existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const before = records.length;
      for (const line of readFileSync(outPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          throw new Error(`unparsable record line in ${outPath}: ${line.slice(0, 200)}`);
        }
      }
      if (records.length === before && manifest.records_count > 0) {
        throw new Error(`artifact ${outPath} declared ${manifest.records_count} record(s) but yielded none`);
      }
      if (manifest.has_more !== true) break;
      const next = manifest.next_offset;
      if (typeof next !== "number" || next <= offset) {
        throw new Error(`pagination stalled: has_more=true but next_offset=${next} (offset was ${offset})`);
      }
      offset = next;
      continue;
    }
    const inline = pickArray(res, ["records", "items"]);
    for (const r of inline) {
      records.push({ record_id: r.record_id ?? r.id, ...(r.fields ?? r) });
    }
    break;
  }
  return records;
}

function encodeCells(fields, source) {
  const out = {};
  for (const f of fields) {
    if (source[f.name] === undefined) continue;
    const v = coerce(f, source[f.name]);
    if (v === null || v === undefined) continue;
    out[f.name] = v;
  }
  return out;
}

function batchCreate(baseToken, identity, tableId, fields, rows) {
  const payload = { create_records: rows.map((r) => encodeCells(fields, r.cells)) };
  const res = runLark([
    "base",
    "+record-batch-create",
    "--base-token",
    baseToken,
    "--table-id",
    tableId,
    "--json",
    JSON.stringify(payload),
    "--as",
    identity,
    "--format",
    "json",
  ]);
  return pickArray(res, ["records", "items"]).length || rows.length;
}

function batchUpdate(baseToken, identity, tableId, fields, patches) {
  const update_records = {};
  for (const p of patches) {
    if (!p.recordId) throw new Error(`cannot update "${p.key}": no record_id (read-back shape changed?)`);
    update_records[p.recordId] = encodeCells(fields, p.patch);
  }
  runLark([
    "base",
    "+record-batch-update",
    "--base-token",
    baseToken,
    "--table-id",
    tableId,
    "--json",
    JSON.stringify({ update_records }),
    "--as",
    identity,
    "--format",
    "json",
  ]);
  return patches.length;
}

/* --------------------------------------------------------------------- driver */

const argv = process.argv.slice(2);
const isCheck = argv.includes("--check");
const isDryRun = argv.includes("--dry-run");
const allowMassRemoval = argv.includes("--allow-mass-removal");
const tableFilterIdx = argv.indexOf("--table");
const tableFilter = tableFilterIdx >= 0 ? argv[tableFilterIdx + 1] : undefined;
if (tableFilterIdx >= 0 && (!tableFilter || tableFilter.startsWith("-"))) {
  console.error("--table needs a table name or key, e.g. --table 项目阶段");
  process.exit(1);
}

if (!existsSync(CONFIG_PATH)) {
  console.error(`missing config: ${resolve(CONFIG_PATH)}`);
  process.exit(1);
}
for (const p of [PLAN_PATH, CONTEXT_PATH]) {
  if (!existsSync(p)) {
    console.error(`missing source of truth: ${resolve(p)}`);
    process.exit(1);
  }
}

let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
} catch {
  console.error(`invalid config JSON: ${resolve(CONFIG_PATH)}`);
  process.exit(1);
}

let snap;
try {
  snap = buildSnapshot(readFileSync(PLAN_PATH, "utf8"), readFileSync(CONTEXT_PATH, "utf8"));
} catch (err) {
  console.error(`failed to parse the source of truth: ${err.message}`);
  console.error("The adapter follows the docs; update the parser in scripts/feishu-bitable.mjs, not the docs.");
  process.exit(1);
}

snap.syncedAt = formatLocalMinute();
const tables = config.tables.filter((t) => (tableFilter ? t.name === tableFilter || t.key === tableFilter : true));
if (tables.length === 0) {
  console.error(`no table matched "${tableFilter}"`);
  console.error(`declared: ${config.tables.map((t) => t.name).join(", ")}`);
  process.exit(1);
}

const problems = validateConfig(config);
if (problems.length > 0) {
  console.error("docs/feishu-bitable.json has problems:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

// Cross-check row builders against the declared schema
const sc = schemaProblems(tables, snap);
if (sc.length > 0) {
  console.error("row set does not match docs/feishu-bitable.json:");
  for (const p of sc) console.error(`  - ${p}`);
  process.exit(1);
}

if (isCheck) {
  console.log(`feishu bitable check OK: ${tables.length}/${config.tables.length} table(s), space ${config.space_id}`);
  console.log(`  snapshot ${snap.snapshotId} — ${snap.summary}`);
  console.log(`  项目阶段   ${snap.phases.length} rows (完成 ${snap.stats.phasesDone})`);
  console.log(`  里程碑     ${snap.milestones.length} rows`);
  console.log(`  里程碑条目 ${snap.items.length} rows`);
  console.log(`  风险登记   ${snap.risks.length} rows`);
  console.log(`  延后清单   ${snap.deferred.length} rows`);
  console.log(`  项目总览   1 row`);
  console.log(`  进展记录   append by snapshot ${snap.snapshotId}`);
  const pending = config.base_token?.startsWith(PLACEHOLDER);
  console.log(
    pending
      ? "  target: NOT PROVISIONED (base_token is a placeholder) — run `just sync-bitable` in an interactive terminal"
      : `  target: base_token ${config.base_token}`,
  );
  process.exit(0);
}

if (isDryRun) {
  console.log(`dry run: snapshot ${snap.snapshotId}, ${tables.length} table(s), no API call`);
  for (const t of tables) {
    const desired = rowsFor(t.key, snap);
    console.log(`  ${t.name}: ${desired.length} row(s) keyed by ${t.primaryKey}, ${t.fields.length} field(s)`);
    for (const r of desired.slice(0, 2)) console.log(`    e.g. ${JSON.stringify(r).slice(0, 220)}`);
  }
  process.exit(0);
}

const identity = config.identity ?? "user";
const tmpDir = mkdtempSync(join("/tmp", "bitable-sync-"));
let failed = 0;
try {
  const { baseToken } = ensureNode(config);
  const live = listTables(baseToken, identity);

  for (const table of tables) {
    const existing = live.find((t) => t.name === table.name || t.id === table.name);
    let tableId = existing?.id;
    if (!tableId) {
      console.log(`creating table ${table.name} (${table.fields.length} fields)`);
      tableId = createTable(baseToken, identity, table);
    } else {
      const have = listFields(baseToken, identity, tableId);
      const missing = table.fields.filter((f) => !have.some((h) => h.name === f.name));
      if (missing.length > 0) {
        console.log(`  ${table.name}: adding ${missing.length} field(s) ${missing.map((m) => m.name).join(", ")}`);
        runLark([
          "base",
          "+field-create",
          "--base-token",
          baseToken,
          "--table-id",
          tableId,
          "--json",
          JSON.stringify(missing),
          "--as",
          identity,
          "--format",
          "json",
        ]);
      }
    }

    const desired = rowsFor(table.key, snap);
    const before = readRecords(baseToken, identity, tableId, tmpDir, `before-${table.key}`);
    const plan = planTable(table, desired, before);

    // A doc section that vanished would stamp every existing row 已移除; that is
    // far more likely a parser accident than a project decision, so refuse it.
    const massRemoval = massRemovalProblem(table, plan, before.length);
    if (massRemoval && !allowMassRemoval) {
      failed += 1;
      console.error(`REFUSED ${table.name}: ${massRemoval}`);
      continue;
    }

    if (plan.create.length > 0) {
      for (let i = 0; i < plan.create.length; i += 200) {
        batchCreate(baseToken, identity, tableId, table.fields, plan.create.slice(i, i + 200));
      }
    }
    const patches = [...plan.update];
    for (const s of plan.stale) {
      patches.push({ key: s.key, recordId: s.recordId, patch: { 仓库内: "已移除" } });
    }
    if (patches.length > 0) {
      for (let i = 0; i < patches.length; i += 200) {
        batchUpdate(baseToken, identity, tableId, table.fields, patches.slice(i, i + 200));
      }
    }

    // Verify the write landed
    const after = readRecords(baseToken, identity, tableId, tmpDir, `after-${table.key}`);
    const residual = planTable(table, desired, after);
    const status =
      residual.create.length === 0 && residual.update.length === 0 && residual.stale.length === 0
        ? "ok"
        : "MISMATCH";
    if (status === "MISMATCH") failed += 1;
    console.log(
      `${status} ${table.name}: +${plan.create.length} ~${plan.update.length} ▽${plan.stale.length} =${residual.unchanged} -> ${after.length} row(s)`,
    );
    if (status === "MISMATCH") {
      for (const r of residual.create) console.error(`  still missing: ${r.key}`);
      for (const r of residual.update) console.error(`  still differing: ${r.key} ${JSON.stringify(r.patch).slice(0, 200)}`);
      for (const r of residual.stale) console.error(`  still unflagged: ${r.key}`);
    }
  }
} catch (err) {
  console.error(`FAILED: ${err.message}`);
  failed += 1;
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`${failed} table(s) did not converge`);
  process.exit(1);
}
console.log(`bitable synced to space ${config.space_id} (snapshot ${snap.snapshotId})`);
