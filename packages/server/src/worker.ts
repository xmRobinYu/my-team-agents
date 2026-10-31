import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDurableWorker, RoomStore } from "@my-team-agents/orchestrator";
import { openExecutionStore } from "./config.js";
import { runtimeFor } from "./runtime.js";

const { store, filename } = openExecutionStore();
// I4: same handle as the API's RoomStore, so a group Task's success and its reply
// in the room stream commit together.
const worker = createDurableWorker(store, { adapterFor: runtimeFor, rooms: new RoomStore(store.db) });
let working = false;
const tick = async () => {
  if (working) return;
  working = true;
  try {
    worker.recoverExpired();
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
