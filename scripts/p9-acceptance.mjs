#!/usr/bin/env node
/**
 * P9 acceptance — the parts that need REAL processes, not a mock harness.
 *
 * `just test` proves the units. This proves the shipped surfaces: a real Fastify
 * server over a real socket, a real worker OS process, a real webhook receiver, and
 * for the `peer` item, AIHOT's own producer code. Nothing here is mocked, because
 * every defect this script found was invisible to a mocked test.
 *
 * Manual and NOT part of `just check`: it needs a built tree (`just build`) and,
 * for `peer`, the read-only `ref/AIHOT` checkout. Run:
 *
 *   just build && just p9-smoke
 *   MTA_P9_ITEMS=auth,budget just p9-smoke
 *
 * A requested item whose prerequisite is missing exits **2**, never 0. Q45 exists
 * precisely because a smoke used to print SKIP and exit 0.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const NODE = process.execPath;
const DIST = join(ROOT, "packages");
const TOKEN = "p9-smoke-token-0123456789abcdef"; // >= MIN_TOKEN_LENGTH(24)

const ITEMS = (process.env.MTA_P9_ITEMS ?? "auth,budget,tell,parallel,peer")
  .split(",").map((s) => s.trim()).filter(Boolean);

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name} ${extra}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function requireBuilt() {
  for (const f of ["server/dist/server.js", "server/dist/worker.js", "orchestrator/dist/index.js"]) {
    if (!existsSync(join(DIST, f))) {
      console.error(`p9-smoke: ${f} is missing. Run \`just build\` first.`);
      process.exit(2);
    }
  }
}

/** A worker process that claims, holds each lease, and appends its run interval. */
const RUNNER = `
import { appendFileSync } from "node:fs";
const { ExecutionStore } = await import(process.env.MTA_ES_DIST);
const store = new ExecutionStore(process.env.MTA_DB_PATH);
const trace = process.env.MTA_TRACE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 8; i += 1) {
  const claimed = store.claimNext(process.env.WORKER_ID, Date.now(), 60000);
  if (!claimed) { await sleep(120); continue; }
  const start = Date.now();
  await sleep(Number(process.env.MTA_HOLD_MS ?? 400));
  appendFileSync(trace, JSON.stringify({ lane: claimed.task.lane, start, end: Date.now() }) + "\\n");
  store.finishFailure(claimed.attempt.id, claimed.attempt.fencingToken, "released by probe", { kind: "unknown" });
  // Re-queue so the peer keeps finding work: a probe that drains the queue proves
  // nothing about concurrency.
  store.db.prepare("UPDATE tasks SET status='queued', batch_attempts=0, available_at=? WHERE id=?")
    .run(Date.now(), claimed.task.id);
}
store.close();
process.exit(0);
`;

/** Global concurrency, swept from the intervals BOTH worker processes wrote. */
function globalPeak(text) {
  const points = [];
  for (const line of text.split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    points.push([r.start, 1], [r.end, -1]);
  }
  points.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let cur = 0, best = 0;
  for (const [, d] of points) { cur += d; best = Math.max(best, cur); }
  return best;
}

const spawnNode = (args, env) => {
  const p = spawn(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const out = [], err = [];
  p.stdout.on("data", (c) => out.push(String(c)));
  p.stderr.on("data", (c) => err.push(String(c)));
  p.__out = () => out.join(""); p.__err = () => err.join("");
  return p;
};

async function waitHealth(port, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    try { return await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(); } catch { await wait(50); }
  }
  throw new Error(`server on ${port} never became healthy`);
}

const freePort = async () => {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
};

async function main() {
  requireBuilt();
  const { ExecutionStore, RoomStore } = await import(join(DIST, "orchestrator/dist/index.js"));
  const base = mkdtempSync(join(tmpdir(), "mta-p9-smoke-"));
  const cleanup = [];
  const procs = [];
  const killAll = () => { for (const p of procs) { try { p.kill("SIGKILL"); } catch { /* gone */ } } };
  process.on("exit", killAll);

  /** A server with the given env, freshly seeded roster, and its own DB. */
  async function server(env = {}, seedRoster = true) {
    const dir = mkdtempSync(join(base, "case-")); cleanup.push(dir);
    const db = join(dir, "exec.sqlite");
    let agentId = null;
    if (seedRoster) {
      const store = new ExecutionStore(db);
      const rooms = new RoomStore(store.db);
      const room = rooms.createRoom({ projectId: "my-team-agents", name: "值班群" });
      const pd = join(dir, "persona"); mkdirSync(pd, { recursive: true });
      agentId = rooms.addAgent({ roomId: room.id, name: "值班员", role: "值班", prompt: "看告警。", agentDir: pd }).id;
      rooms.close(); store.close();
    }
    const port = await freePort();
    const p = spawnNode([join(DIST, "server/dist/server.js")], { MTA_PORT: String(port), MTA_DB_PATH: db, ...env });
    procs.push(p);
    const health = await waitHealth(port);
    const post = async (url, payload, token = env.MTA_INGEST_TOKEN ?? null) => {
      const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(payload),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const get = async (url, token = env.MTA_INGEST_TOKEN ?? null) => {
      const res = await fetch(`http://127.0.0.1:${port}${url}`,
        { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) } });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    return { p, port, db, dir, health, post, get, agentId };
  }
  const stop = (s) => { try { s.p.kill("SIGKILL"); } catch { /* gone */ } };

  // ---- auth ---------------------------------------------------------------
  if (ITEMS.includes("auth")) {
    console.log("[auth] enabled must imply a usable token");
    let s = await server({ MTA_INGEST_ENABLED: "1" });
    ok("enabled without a token: health says open=false/TOKEN_REQUIRED",
       s.health.ingest.enabled === true && s.health.ingest.open === false
       && s.health.ingest.reason === "TOKEN_REQUIRED", JSON.stringify(s.health.ingest));
    ok("enabled without a token: POST is 404, not an open door",
       (await s.post("/api/ingest/events", { id: "x", source: "s", type: "t", summary: "x" })).status === 404);
    ok("startup stderr names the missing variable", s.p.__err().includes("stays CLOSED") || s.p.__out().includes("stays CLOSED"));
    stop(s);

    s = await server({ MTA_INGEST_ENABLED: "1", MTA_INGEST_TOKEN: "abc" });
    ok("a short token is TOKEN_TOO_SHORT, and does NOT fall through to anonymous",
       s.health.ingest.open === false && s.health.ingest.reason === "TOKEN_TOO_SHORT"
       && (await s.post("/api/ingest/events", { id: "x", source: "s", type: "t", summary: "x" }, "abc")).status === 404,
       JSON.stringify(s.health.ingest));
    stop(s);

    s = await server({ MTA_INGEST_ENABLED: "1", MTA_INGEST_TOKEN: TOKEN });
    ok("a real token opens the surface", s.health.ingest.open === true && s.health.ingest.tokenRequired === true);
    ok("no token => 401", (await s.post("/api/ingest/events", { id: "x", source: "s", type: "t", summary: "x" }, null)).status === 401);
    ok("a prefix of the real token is still 401",
       (await s.post("/api/ingest/events", { id: "x", source: "s", type: "t", summary: "x" }, TOKEN.slice(0, -1))).status === 401);
    const huge = JSON.stringify({ id: "e", source: "s", type: "t", summary: "x", detail: "y".repeat(70 * 1024) });
    const bigRes = await fetch(`http://127.0.0.1:${s.port}/api/ingest/events`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: huge });
    ok("a 70 KiB body is refused with 413 before it is buffered", bigRes.status === 413, `got ${bigRes.status}`);
    stop(s);

    s = await server({ MTA_INGEST_ENABLED: "1", MTA_INGEST_TOKEN: "", MTA_INGEST_ALLOW_ANON: "1" });
    ok("ALLOW_ANON=1 is the only anonymous path, and it reports itself",
       s.health.ingest.open === true && s.health.ingest.anonymousAllowed === true
       && (await s.post("/api/ingest/events", { id: "x", source: "s", type: "t", summary: "x" }, null)).status === 200);
    stop(s);
  }

  // ---- budget + tell ------------------------------------------------------
  if (ITEMS.includes("budget") || ITEMS.includes("tell")) {
    console.log("[budget/tell] a real worker, a real webhook receiver");
    const cards = [];
    const hook = createServer((req, res) => {
      let body = ""; req.on("data", (c) => { body += c; });
      req.on("end", () => { try { cards.push(JSON.parse(body)); } catch { cards.push({ raw: body.slice(0, 200) }); } res.writeHead(200); res.end("{}"); });
    });
    await new Promise((r) => hook.listen(0, "127.0.0.1", r));
    const hookUrl = `http://127.0.0.1:${hook.address().port}/hook`;

    const s = await server({ MTA_INGEST_ENABLED: "1", MTA_INGEST_TOKEN: TOKEN });
    const rule = await s.post("/api/ingest/rules", {
      name: "值班告警", ask: "看这条告警并给出结论", lane: "alerts", tell: "needed",
      when: { sources: ["s"] }, to: { memberId: s.agentId, workspacePath: ROOT },
    }, TOKEN);
    ok("rule with tell=needed registers", rule.status === 201, JSON.stringify(rule.body).slice(0, 180));
    const submitted = await s.post("/api/ingest/events",
      { id: "e1", source: "s", type: "alert", subject: "db-primary", summary: "主库连接池耗尽" }, TOKEN);
    ok("event dispatched", submitted.status === 200 && submitted.body.outcome === "dispatched",
       JSON.stringify(submitted.body).slice(0, 160));

    const wk = spawnNode([join(DIST, "server/dist/worker.js")], {
      MTA_DB_PATH: s.db, MTA_RUNTIME: "mock", MTA_INGEST_ENABLED: "1", MTA_INGEST_TOKEN: TOKEN,
      MTA_MOCK_DELAY_MS: "50", MTA_MOCK_USAGE_TOKENS: "1200",
      MTA_TELL_WEBHOOK: hookUrl, MTA_TASK_BUDGET_TOKENS: "100",
    });
    procs.push(wk);
    await wait(3500);

    const detail = (await s.get(`/api/ingest/events/e1`, TOKEN)).body;
    if (ITEMS.includes("budget")) {
      ok("budget stop lands in blocked, not failed", detail.tasks?.[0]?.task?.status === "blocked",
         `status=${detail.tasks?.[0]?.task?.status}`);
      ok("the reason names the ceiling", String(detail.tasks?.[0]?.task?.error ?? "").includes("预算超限"),
         String(detail.tasks?.[0]?.task?.error).slice(0, 120));
    }
    if (ITEMS.includes("tell")) {
      ok("the webhook got exactly one card", cards.length === 1, `got ${cards.length}`);
      const c = cards[0]?.card ?? {};
      ok("the card is a human-decision escalation about this subject",
         String(c.title).includes("需人工决策") && c.subject === "db-primary" && c.ruleName === "值班告警",
         JSON.stringify(c).slice(0, 160));
      const again = await s.post("/api/ingest/events",
        { id: "e1", source: "s", type: "alert", subject: "db-primary", summary: "主库连接池耗尽" }, TOKEN);
      ok("a repeat delivery is 200/delivered", again.body?.outcome === "delivered", JSON.stringify(again.body).slice(0, 120));
      await wait(2000);
      ok("定过的事不问第二遍: still exactly one card", cards.length === 1, `got ${cards.length}`);
    }
    try { wk.kill("SIGKILL"); } catch { /* gone */ }
    stop(s); hook.close();
  }

  // ---- parallel -----------------------------------------------------------
  if (ITEMS.includes("parallel")) {
    console.log("[parallel] two worker OS processes over one file");
    const runnerFile = join(base, "runner.mjs");
    writeFileSync(runnerFile, RUNNER);

    async function probe(lane, parallel, expect) {
      const dir = mkdtempSync(join(base, `${lane}-`)); cleanup.push(dir);
      const db = join(dir, "exec.sqlite");
      const trace = join(dir, "trace.jsonl");
      writeFileSync(trace, "");
      const store = new ExecutionStore(db);
      const rooms = new RoomStore(store.db);
      const room = rooms.createRoom({ projectId: "p", name: "g" });
      const pd = join(dir, "persona"); mkdirSync(pd, { recursive: true });
      const agentId = rooms.addAgent({ roomId: room.id, name: "工", role: "r", prompt: "p", agentDir: pd }).id;
      for (let i = 0; i < 6; i += 1) {
        store.createTask({ tenantId: "t", projectId: "p", memberId: agentId, workspacePath: ROOT,
          prompt: `${lane}-${i}`, lane, ...(parallel ? { parallel } : {}) });
      }
      rooms.close(); store.close();
      const run = () => new Promise((res) => {
        const p = spawnNode([runnerFile], { WORKER_ID: lane, MTA_DB_PATH: db, MTA_TRACE: trace,
          MTA_ES_DIST: join(DIST, "orchestrator/dist/execution-store.js") });
        procs.push(p);
        p.on("close", res);
      });
      await Promise.all([run(), run()]);
      const text = readFileSync(trace, "utf8");
      const peak = globalPeak(text);
      const n = text.split("\n").filter(Boolean).length;
      // One database per probe: the runner re-queues, and `claimNext` orders by
      // created_at, so a shared file starves every later lane. That is a probe
      // artifact, and it read as a product failure until it was fixed.
      ok(`${lane} parallel=${parallel ?? "default"} -> global peak ${expect}`, peak === expect,
         `got ${peak} over ${n} runs`);
    }
    await probe("FAN2", 2, 2);
    await probe("SER1", null, 1);
    await probe("FAN4", 4, 2);
  }

  // ---- peer ---------------------------------------------------------------
  if (ITEMS.includes("peer")) {
    const agentFile = join(ROOT, "ref/AIHOT/packages/backend/src/notify/agent.ts");
    if (!existsSync(agentFile)) {
      console.error("p9-smoke: ref/AIHOT is not checked out, and `peer` was requested.");
      console.error("           Do not drop this item to make the run green (Q45).");
      process.exitCode = 2;
      return;
    }
    console.log("[peer] AIHOT's own wakeAgent against our live endpoint");
    const hookFile = join(base, "hook.mjs");
    writeFileSync(hookFile, `
const STUBS = {
  db: "export const sql = globalThis.__FAKE_SQL__;",
  config: ["export const credential = (a, b) => globalThis.__CRED__[b];",
           'export const config = { siteUrl: "https://aihot.example" };'].join("\\n"),
  feishu: ["export const feishuInternalEnabled = () => true;",
           "export const toldThroughHub = async (p) => p;",
           "export class Finding {}"].join("\\n"),
};
const KEYED = /(?:^|\\/)(db|config|feishu)\\.ts$/;
export async function resolve(specifier, context, nextResolve) {
  const hit = KEYED.exec(specifier);
  if (!hit) return nextResolve(specifier, context);
  return { shortCircuit: true, format: "module", url: "data:text/javascript," + encodeURIComponent(STUBS[hit[1]]) };
}
`);
    const shimFile = join(base, "producer.mjs");
    writeFileSync(shimFile, `
import { register } from "node:module";
import { pathToFileURL } from "node:url";
register(pathToFileURL(${JSON.stringify(hookFile)}));
const receipts = new Map();
const fakeSql = (strings, ...values) => {
  const sql = strings.join("?");
  const args = values.filter((v) => v !== undefined);
  if (/^\\s*INSERT INTO settings/i.test(sql)) {
    const key = args[0];
    const raw = Array.isArray(args[1]) ? args[1][1] : args[1];
    if (!receipts.has(key)) receipts.set(key, { key, value: { ...raw, accepted: false, queuedAt: new Date().toISOString() } });
    return Promise.resolve([]);
  }
  if (/SELECT value FROM settings WHERE key=\\?/i.test(sql)) return Promise.resolve([receipts.get(args[0])].filter(Boolean));
  if (/UPDATE settings SET value=value/i.test(sql)) { const r = receipts.get(args[0]); if (r) r.value.accepted = true; return Promise.resolve([]); }
  if (/UPDATE settings SET value=/i.test(sql)) { const r = receipts.get(args[1]); if (r) r.value = { ...r.value, ...JSON.parse(args[0]) }; return Promise.resolve([]); }
  return Promise.resolve([]);
};
fakeSql.json = (v) => [JSON.stringify(v), v];
globalThis.__FAKE_SQL__ = fakeSql;
globalThis.__CRED__ = { WEBHOOK_HUB_URL: process.env.HUB_URL, WEBHOOK_HUB_KEY: process.env.HUB_KEY };
const { wakeAgent } = await import(process.env.AIHOT_AGENT);
const delivered = await wakeAgent({ key: "content.collect", level: "now", title: "网站停止收录新文章",
  impact: "读者看不到新文章", detail: "最近一次抓取全部失败", since: new Date("2026-11-11T00:00:00Z"), owner: true });
console.log(JSON.stringify({ delivered, receipts: [...receipts.values()].map((r) => r.value) }));
`);

    // The deployment contract, proven not assumed: AIHOT sends
    // `authorization: Bearer $WEBHOOK_HUB_KEY`, so its hub key IS our token.
    const s = await server({ MTA_INGEST_ENABLED: "1", MTA_INGEST_TOKEN: TOKEN, MTA_INGEST_SOURCE: "aihot-prod" });
    const rule = await s.post("/api/ingest/rules", {
      name: "AIHOT 收录告警", ask: "检查收录情况并给出结论", lane: "aihot", tell: "needed",
      when: { sources: ["aihot-prod"], types: ["alert.now"] },
      to: { memberId: s.agentId, workspacePath: ROOT },
    }, TOKEN);
    ok("rule registered for the peer source", rule.status === 201, JSON.stringify(rule.body).slice(0, 180));

    const produced = await new Promise((res) => {
      const p = spawnNode(["--experimental-strip-types", shimFile], {
        HUB_URL: `http://127.0.0.1:${s.port}/api/ingest/events`, HUB_KEY: TOKEN, AIHOT_AGENT: agentFile });
      procs.push(p);
      p.on("close", () => res(p.__out()));
    });
    let parsed = null;
    try { parsed = JSON.parse(produced.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? ""); } catch { /* below */ }
    const ev = parsed?.receipts?.[0]?.event;
    ok("AIHOT's wakeAgent reported delivery", parsed?.delivered === true, produced.slice(0, 200));
    ok("the event it sent carries NO source field", Boolean(ev) && !("source" in ev), JSON.stringify(ev).slice(0, 200));
    ok("the deployment's MTA_INGEST_SOURCE filled it", Boolean(ev)
       && (await s.get(`/api/ingest/events/${encodeURIComponent(ev.id)}`, TOKEN)).body?.event?.source === "aihot-prod");

    if (ev) {
      const detail = (await s.get(`/api/ingest/events/${encodeURIComponent(ev.id)}`, TOKEN)).body;
      ok("exactly one Task, with the rule named", detail.tasks?.length === 1 && detail.rules?.length === 1,
         `tasks=${detail.tasks?.length} rules=${detail.rules?.length}`);
      for (let i = 0; i < 3; i += 1) await s.post("/api/ingest/events", ev, TOKEN);
      const after = (await s.get(`/api/ingest/events/${encodeURIComponent(ev.id)}`, TOKEN)).body;
      ok("重发 3 次仍只有 1 个 Task", after.tasks?.length === 1, `got ${after.tasks?.length}`);
      ok("GET /:id resolves the whole chain", Boolean(after.event) && Array.isArray(after.tasks?.[0]?.usage),
         JSON.stringify(Object.keys(after)));
    }
    stop(s);
  }

  rmSync(base, { recursive: true, force: true });
  console.log(`\np9-smoke: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

await main();
