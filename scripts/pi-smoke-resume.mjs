import { PiAdapter } from "../packages/runtime-pi/dist/adapter.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [workspace, model] = process.argv.slice(2);
if (!workspace || !model) { console.error("usage: pi-smoke-resume.mjs <workspace> <model>"); process.exit(2); }

const adapter = new PiAdapter({ approveProjectResources: false });
const secret = `ZEBRA-${Math.floor(Math.random() * 1e6)}`;

const first = await adapter.start({
  runId: "resume-1", tenantId: "t", projectId: "p", memberId: "m", attemptId: "a1",
  workspacePath: workspace,
  prompt: `Remember this exact token: ${secret}. Reply with only: SAVED`,
  model, sandbox: "none",
});
for await (const _ of first.events) { /* drain */ }
const r1 = await first.settled;
if (r1.status !== "completed") { console.error("run1 failed", r1); process.exit(1); }

// Locate the session pi just persisted for this workspace.
const sessionsRoot = path.join(os.homedir(), ".pi/agent/sessions");
const encoded = workspace.replace(/\//g, "-").replace(/^-/, "--");
const candidates = fs.existsSync(sessionsRoot)
  ? fs.readdirSync(sessionsRoot).filter((d) => d.includes(encoded.replace(/^--/, "")) || d === encoded)
  : [];
let sessionFile = null;
for (const dir of candidates) {
  const full = path.join(sessionsRoot, dir);
  for (const f of fs.readdirSync(full).filter((f) => f.endsWith(".jsonl"))) {
    const p = path.join(full, f);
    if (!sessionFile || fs.statSync(p).mtimeMs > fs.statSync(sessionFile).mtimeMs) sessionFile = p;
  }
}
if (!sessionFile) { console.error("NO SESSION PERSISTED"); process.exit(1); }

const second = await adapter.start({
  runId: "resume-2", tenantId: "t", projectId: "p", memberId: "m", attemptId: "a2",
  workspacePath: workspace,
  prompt: "What was the exact token I gave you? Reply with only the token.",
  session: {
    sessionId: path.basename(sessionFile, ".jsonl"),
    sessionDir: path.dirname(sessionFile),
    sessionPath: sessionFile,
    resume: true,
  },
  model, sandbox: "none",
});
let text = "";
for await (const ev of second.events) {
  if (ev.type === "message_end" && ev.text) text += ev.text;
  if (ev.type === "message_update" && ev.text) text += ev.text;
}
const r2 = await second.settled;
const remembered = text.includes(secret);
console.log(JSON.stringify({ run1: r1.status, run2: r2.status, sessionFile: path.basename(sessionFile), remembered, expected: secret }));
if (!remembered) { console.error("RESUME FAILED: model did not recall token; history not loaded"); process.exit(1); }
console.log("resume smoke OK: history loaded, model recalled the token");
