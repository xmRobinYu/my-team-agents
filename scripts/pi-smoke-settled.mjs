import { existsSync } from "node:fs";
import { PiAdapter } from "../packages/runtime-pi/dist/adapter.js";
import { ExecutionStore } from "../packages/orchestrator/dist/index.js";

const [workspace, model] = process.argv.slice(2);
if (!workspace || !model) { console.error("usage: pi-smoke-settled.mjs <workspace> <model>"); process.exit(2); }

const adapter = new PiAdapter({ approveProjectResources: false });
const handle = await adapter.start({
  runId: `smoke-${Date.now()}`,
  tenantId: "default", projectId: "smoke", memberId: "pi-agent", attemptId: "a1",
  workspacePath: workspace,
  prompt: "Reply with exactly: PONG",
  model, sandbox: "none",
});

const types = new Set();
let sawSettled = false;
// Events that reported usage, kept for the attribution check below.
const usageEvents = [];
for await (const ev of handle.events) {
  types.add(ev.type);
  if (ev.type === "agent_settled") sawSettled = true;
  if (ev.usage) usageEvents.push(ev);
}
const result = await handle.settled;

// Cost attribution, asserted through the real store and not only on the event: Pi's
// RPC/JSON frames never carry provider/model at the top level, so a regression back to
// the old top-level lookup drops every usage row into the store's ('unknown','unknown')
// key — where MAX() would also merge two models of one Attempt and understate the total.
const attributed = usageEvents.filter(
  (ev) => typeof ev.provider === "string" && typeof ev.model === "string",
);
const store = new ExecutionStore();
const now = Date.now();
store.createTask({ tenantId: "default", projectId: "smoke", memberId: "pi-agent",
  workspacePath: workspace, prompt: "smoke" }, now);
const claimed = store.claimNext("smoke", now, 300_000);
if (claimed) {
  for (const ev of attributed) {
    store.appendEvent(claimed.attempt.id, claimed.attempt.fencingToken, { ...ev, runId: claimed.attempt.id });
  }
}
const usageRows = store.getUsage();
store.close();

const checks = [
  ["completed status", result.status === "completed"],
  ["agent_settled seen", sawSettled],
  ["no unknown events", !types.has("unknown")],
  ["has message events", types.has("message_update") || types.has("message_end")],
  // The durable store can only resume a session if the adapter reports it.
  ["reports session file", typeof result.sessionFile === "string" && result.sessionFile.length > 0],
  ["session file exists", typeof result.sessionFile === "string" && existsSync(result.sessionFile)],
  ["usage was reported", usageEvents.length > 0],
  // The adapter must resolve attribution from the message / get_state payloads.
  ["adapter resolves attribution", attributed.length > 0],
  // Required signal: at least one persisted row names a real provider/model.
  ["usage row is attributed",
    usageRows.some((row) => row.provider !== "unknown" && row.model !== "unknown")],
  // 'unknown' must stay the explicit "never observed" value; an empty string would
  // silently poison the cost report's grouping key.
  ["no empty-string attribution", !usageRows.some((row) => row.provider === "" || row.model === "")],
];

const failed = checks.filter(([, ok]) => !ok);
console.log(JSON.stringify({
  status: result.status,
  eventTypes: [...types],
  usageEvents: usageEvents.length,
  usage: usageRows.map((row) => `${row.provider}/${row.model}:${row.totalTokens}`),
  checks: Object.fromEntries(checks),
}));
if (failed.length > 0) { console.error("FAILED:", failed.map(([n]) => n).join(", ")); process.exit(1); }
console.log("settled smoke OK");
