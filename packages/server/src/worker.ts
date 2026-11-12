import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDurableWorker,
  createIngestService,
  createScheduler,
  createTellService,
  listAgentSkills,
  createWebhookChannel,
  IngestStore,
  RoomStore,
  SILENT_CHANNEL,
  type TellChannel,
} from "@my-team-agents/orchestrator";
import { ingestConfig, openExecutionStore } from "./config.js";
import { runtimeFor, isolationStatus, isolationProbe } from "./runtime.js";

const { store, filename } = openExecutionStore();
// I4: same handle as the API's RoomStore, so a group Task's success and its reply
// in the room stream commit together.
const rooms = new RoomStore(store.db);

/**
 * P9c: optional per-Task ceiling, from the environment so an operator can set it
 * without a redeploy of the code. Unset stays unset — a default would silently cut
 * off long legitimate runs, and a wrong default is worse than no ceiling.
 */
function taskBudget(): { maxTokens?: number; maxCost?: number } | undefined {
  const tokens = Number(process.env.MTA_TASK_BUDGET_TOKENS ?? "");
  const cost = Number(process.env.MTA_TASK_BUDGET_COST ?? "");
  const out: { maxTokens?: number; maxCost?: number } = {};
  if (Number.isFinite(tokens) && tokens > 0) out.maxTokens = tokens;
  if (Number.isFinite(cost) && cost > 0) out.maxCost = cost;
  return Object.keys(out).length > 0 ? out : undefined;
}

const budget = taskBudget();

if (budget) {
  console.log(`Task budget: ${budget.maxTokens ?? "-"} tokens / ${budget.maxCost ?? "-"} cost`);
}

// P9a.5 (AC4.x): the scheduler lives in the WORKER process, not the API one, because
// its job is to create Tasks — and the worker is the process that owns running them.
// It reuses the API's own service wiring points (`IngestStore` over one handle, the
// roster as the member check), so a scheduled event takes exactly the path a webhook
// event takes.
//
// Gated on the same switch as the HTTP surface (D6/A): a deployment that has not
// turned ingress on must not start firing timers either.
const ingestCfg = ingestConfig();
const { enabled } = ingestCfg;
const ingest = new IngestStore(store.db);
const ingestService = createIngestService({
  executions: store,
  ingest,
  memberExists: (memberId) => rooms.getAgent(memberId) !== null,
  // P9b: the persona behind a rule target. `listAgentSkills` reports only skills Pi
  // would actually load, so a rule cannot name one that exists on disk but is
  // unreadable — the exact I9 defect where an imported skill was invisible to Pi.
  persona: (memberId) => {
    const agent = rooms.getAgent(memberId);
    if (!agent) return null;
    return {
      ...(agent.agentDir ? { agentDir: agent.agentDir } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.agentDir
        ? { loadableSkills: listAgentSkills(agent.agentDir).skills.filter((sk) => sk.loadable).map((sk) => sk.slug) }
        : {}),
    };
  },
  // P9d: AC5.2's gate reads a MEASUREMENT. When isolation is not running, a rule
  // naming `bash` is still refused at registration — the relaxation is conditional
  // on the isolation actually being there, not on a version number.
  writableTools: isolationStatus,
  // P9e: a cron-generated event has no producer at all, so the deployment's source
  // is the only name it can get. Same value the HTTP surface uses, so a webhook
  // event and a scheduled event of one deployment are attributed identically.
  ...(ingestCfg.defaultSource ? { defaultSource: ingestCfg.defaultSource } : {}),
});
const scheduler = createScheduler({
  ingest,
  service: ingestService,
  scope: {
    tenantId: process.env.MTA_INGEST_TENANT ?? "default",
    projectId: process.env.MTA_INGEST_PROJECT ?? "my-team-agents",
  },
});
// P9b: ONE outbound channel, chosen by configuration. `MTA_TELL_WEBHOOK` unset means
// silence — the default must never be an accidental outbound request.
const tellChannel: TellChannel = process.env.MTA_TELL_WEBHOOK
  ? createWebhookChannel(process.env.MTA_TELL_WEBHOOK)
  : SILENT_CHANNEL;
const tell = createTellService({
  executions: store,
  ingest,
  channel: tellChannel,
  ...(process.env.MTA_TELL_COOLDOWN_MS ? { cooldownMs: Number(process.env.MTA_TELL_COOLDOWN_MS) } : {}),
});
console.log(`Tell channel: ${tellChannel.name}`);

// P9d: printed at startup because "isolated" is the kind of claim that is
// worthless if you have to infer it. A failed probe says why, in one line.
console.log(isolationProbe.ok
  ? `Isolation: docker ${isolationProbe.daemonVersion} image=${isolationProbe.image}`
    + ` models=${isolationProbe.modelsFileMounted ? "mounted" : "ABSENT"} -> writable-tool rules ALLOWED`
  : `Isolation: OFF (${isolationProbe.reason}) -> writable-tool rules refused`);

const worker = createDurableWorker(store, {
  adapterFor: runtimeFor,
  rooms,
  ...(budget ? { budget } : {}),
  tell: (taskId) => tell.notify(taskId),
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
