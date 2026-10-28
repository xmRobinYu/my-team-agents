import { existsSync } from "node:fs";
import { PiAdapter } from "../packages/runtime-pi/dist/adapter.js";

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
for await (const ev of handle.events) {
  types.add(ev.type);
  if (ev.type === "agent_settled") sawSettled = true;
}
const result = await handle.settled;

const checks = [
  ["completed status", result.status === "completed"],
  ["agent_settled seen", sawSettled],
  ["no unknown events", !types.has("unknown")],
  ["has message events", types.has("message_update") || types.has("message_end")],
  // The durable store can only resume a session if the adapter reports it.
  ["reports session file", typeof result.sessionFile === "string" && result.sessionFile.length > 0],
  ["session file exists", typeof result.sessionFile === "string" && existsSync(result.sessionFile)],
];
const failed = checks.filter(([, ok]) => !ok);
console.log(JSON.stringify({ status: result.status, eventTypes: [...types], checks: Object.fromEntries(checks) }));
if (failed.length > 0) { console.error("FAILED:", failed.map(([n]) => n).join(", ")); process.exit(1); }
console.log("settled smoke OK");
