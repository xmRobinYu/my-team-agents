import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDurableWorker, createIngestService, createScheduler, IngestStore, RoomStore } from "@my-team-agents/orchestrator";
import { ingestConfig, openExecutionStore } from "./config.js";
import { runtimeFor } from "./runtime.js";

const { store, filename } = openExecutionStore();
// I4: same handle as the API's RoomStore, so a group Task's success and its reply
// in the room stream commit together.
const rooms = new RoomStore(store.db);
const worker = createDurableWorker(store, { adapterFor: runtimeFor, rooms });

// P9a.5 (AC4.x): the scheduler lives in the WORKER process, not the API one, because
// its job is to create Tasks — and the worker is the process that owns running them.
// It reuses the API's own service wiring points (`IngestStore` over one handle, the
// roster as the member check), so a scheduled event takes exactly the path a webhook
// event takes.
//
// Gated on the same switch as the HTTP surface (D6/A): a deployment that has not
// turned ingress on must not start firing timers either.
const { enabled } = ingestConfig();
const ingest = new IngestStore(store.db);
const ingestService = createIngestService({
  executions: store,
  ingest,
  memberExists: (memberId) => rooms.getAgent(memberId) !== null,
});
const scheduler = createScheduler({
  ingest,
  service: ingestService,
  scope: {
    tenantId: process.env.MTA_INGEST_TENANT ?? "default",
    projectId: process.env.MTA_INGEST_PROJECT ?? "my-team-agents",
  },
});
let working = false;
const tick = async () => {
  if (working) return;
  working = true;
  try {
    worker.recoverExpired();
    // AC2.5: a deferred event is re-offered here, so `deferred` is a delay, never a
    // drop. Runs before the claim loop so a redriven Task is claimable this tick.
    if (enabled) ingestService.redriveDeferred();
    // AC4.1/AC4.2: due schedule slots become ordinary events, with stable ids.
    if (enabled) scheduler.tick();
    while (await worker.runOnce()) { /* One active Worker per local workspace. */ }
  } catch (error) { console.error("worker tick failed", error); }
  finally { working = false; }
};
const timer = setInterval(() => void tick(), 250);
worker.recoverExpired();
void tick();
console.log(`my-team-agents Worker started; SQLite: ${filename}`);
console.log(process.env.MTA_RUNTIME === "mock"
  ? "Runtime: deterministic mock (not an AI agent)"
  : "Runtime: Pi / configured CLI adapters");

const shutdown = () => {
  clearInterval(timer);
  store.close();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
