import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CanonicalEvent, RunSpec } from "@my-team-agents/runtime-core";
import { PiAdapter } from "./adapter.js";
import { handoffExtensionPath } from "./handoff-extension.js";
import { piSessionDirForAgent } from "./session-isolation.js";

/**
 * Opt-in proof against the installed `pi` binary — the only kind that can falsify
 * D1 and D3, because both are claims about what Pi DOES, not about what we hand it:
 *
 *   MTA_REAL_PI=1 pnpm vitest run packages/runtime-pi
 *   MTA_REAL_PI_MODEL=airouter/deepseek-v4.1-flash   # provider/model for the D1 run
 *
 * Same convention as `just pi-smoke` and the I9 coupling test in
 * `packages/server/src/skill-import-e2e.test.ts`: needs the binary, and the D1 case
 * needs a working provider, so both stay out of `just check`. The orchestrator's own
 * parser is asserted over the same events in `packages/server`, the package already
 * depending on both sides; importing orchestrator from `runtime-pi` would make a
 * runtime depend on its own consumer.
 *
 * The D3 cases redirect `HOME` and `PI_CODING_AGENT_DIR` into a scratch directory, so
 * the operator's real session store is neither written to nor read from (measured:
 * `<scratch>/.pi/agent/sessions` stayed ABSENT while the transcript landed in the
 * persona dir). Isolation survives a failed provider call — measured with a
 * deliberately invalid `DEEPSEEK_API_KEY`: Pi settled with `stopReason: "error"`,
 * reported 401, and still wrote one file containing the user turn into
 * `--session-dir` — but the RESUME cases need a reply, so they use
 * `deepseek/deepseek-flash`: it is in Pi's shipped catalog (a fresh config dir cannot
 * know a custom provider id) and authenticates from the inherited `DEEPSEEK_API_KEY`.
 */

const REAL_PI = process.env.MTA_REAL_PI === "1";
const MODEL = process.env.MTA_REAL_PI_MODEL ?? "airouter/deepseek-v4.1-flash";
const OFFLINE_MODEL = "deepseek/deepseek-flash";

const tempDir = mkdtempSync(join(tmpdir(), "pi-real-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

const personaDir = (name: string): string => {
  const dir = join(tempDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const drain = async (handle: Awaited<ReturnType<PiAdapter["start"]>>): Promise<CanonicalEvent[]> => {
  const seen: CanonicalEvent[] = [];
  for await (const event of handle.events) seen.push(event);
  return seen;
};

describe.skipIf(!REAL_PI)("real pi binary", () => {
  it("declares handoff_to to a real model, which then calls it", async () => {
    const agentDir = personaDir("d1-persona");
    const adapter = new PiAdapter({ approveProjectResources: true });
    const base: Omit<RunSpec, "runId"> = {
      tenantId: "t", projectId: "p", memberId: "m",
      workspacePath: agentDir, agentDir, model: MODEL,
      prompt: [
        "You have a tool named handoff_to. Call it exactly once.",
        'Arguments: {"toMemberIds":["reviewer-bot"],"reason":"需要第二遍审阅这段实现"}.',
        "Do not use any other tool and do not answer in prose before the call.",
      ].join("\n"),
    };

    const declared: CanonicalEvent[] = [];
    const attempts: string[] = [];
    // Bounded retries: the model is the flaky part, not the harness. Every attempt
    // still runs a real Pi process against a real provider.
    for (let attempt = 1; attempt <= 3 && declared.length === 0; attempt += 1) {
      const handle = await adapter.start({ ...base, runId: `d1-a${attempt}` });
      const events = await drain(handle);
      const result = await handle.settled;
      declared.push(...events.filter(
        (event) => event.type === "tool_execution_start" && event.toolName === "handoff_to",
      ));
      const text = [...events].reverse().find((event) => event.type === "message_end" && event.text)?.text ?? "";
      const tools = [...new Set(events.map((event) => event.toolName).filter(Boolean))];
      attempts.push(`#${attempt} status=${result.status} tools=[${tools.join(", ")}] text=${text.slice(0, 160)}`);
    }

    // Raw evidence either way: on failure this prints what the model actually did.
    console.log(`[D1 real pi] model=${MODEL}\n  ${attempts.join("\n  ")}`);

    expect(declared, "no handoff_to tool_execution_start reached the adapter").toHaveLength(1);
    const event = declared[0]!;
    // The worker needs a toolCallId to dispatch durably, and the args must be the
    // object form `{toMemberIds: string[], reason: string}` — never prose.
    expect(typeof event.toolCallId).toBe("string");
    expect(event.toolCallId).not.toBe("");
    const args = event.args as { toMemberIds: unknown; reason: unknown };
    expect(args.toMemberIds).toEqual(["reviewer-bot"]);
    expect(String(args.reason)).toContain("审阅");
    expect(existsSync(handoffExtensionPath())).toBe(true);
  }, 300_000);

  it("keeps a persona's sessions inside its own dir and still resumes them", async () => {
    const agentDir = personaDir("d3-persona");
    const fakeHome = join(tempDir, "d3-home");
    const fakeAgentConfig = join(fakeHome, ".pi", "agent");
    mkdirSync(fakeAgentConfig, { recursive: true });

    const previousHome = process.env.HOME;
    const previousConfig = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = fakeHome;
    process.env.PI_CODING_AGENT_DIR = fakeAgentConfig;
    try {
      const adapter = new PiAdapter({ approveProjectResources: true });
      const first = await adapter.start({
        runId: "d3-first", tenantId: "t", projectId: "p", memberId: "m",
        workspacePath: agentDir, agentDir, model: OFFLINE_MODEL,
        prompt: "Remember the token ZEBRA-D3. Reply SAVED.",
      });
      await drain(first);
      const r1 = await first.settled;
      const sessionFile = r1.sessionFile;

      expect(sessionFile, "adapter reported no session file").toBeTruthy();
      const isolated = piSessionDirForAgent(agentDir);
      expect(isolated).toBe(join(agentDir, ".pi", "sessions"));
      // Measured: Pi writes the transcript flat into --session-dir.
      const separator = sessionFile!.slice(isolated.length, isolated.length + 1);
      expect(["/", "\\"]).toContain(separator);
      expect(sessionFile!.startsWith(isolated), `transcript left the persona dir: ${sessionFile}`).toBe(true);
      expect(existsSync(sessionFile!)).toBe(true);
      // The shared/global store stayed empty — that IS the isolation claim.
      expect(existsSync(join(fakeAgentConfig, "sessions"))).toBe(false);
      expect(readdirSync(isolated).length).toBe(1);

      const linesBefore = readFileSync(sessionFile!, "utf8").split("\n").filter(Boolean).length;

      // Q18 under D3: `--session <path>` together with `--session-dir` must reopen
      // the same file with its history instead of starting a fresh one.
      const second = await adapter.start({
        runId: "d3-second", tenantId: "t", projectId: "p", memberId: "m",
        workspacePath: agentDir, agentDir, model: OFFLINE_MODEL,
        prompt: "What token did I give you?",
        session: {
          sessionId: "irrelevant", sessionDir: isolated,
          sessionPath: sessionFile!, resume: true,
        },
      });
      await drain(second);
      const r2 = await second.settled;

      expect(r2.sessionFile).toBe(sessionFile);
      const linesAfter = readFileSync(sessionFile!, "utf8").split("\n").filter(Boolean).length;
      expect(linesAfter, "the resumed run appended nothing: history was not loaded").toBeGreaterThan(linesBefore);
      // One file, still inside the persona dir, and it still holds the first turn.
      expect(readdirSync(isolated).length).toBe(1);
      expect(readFileSync(sessionFile!, "utf8")).toContain("ZEBRA-D3");
      expect(statSync(sessionFile!).size).toBeGreaterThan(0);
      console.log(`[D3 real pi] run1=${r1.status} run2=${r2.status} lines ${linesBefore} -> ${linesAfter} file=${sessionFile}`);
    } finally {
      process.env.HOME = previousHome;
      if (previousConfig === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousConfig;
    }
  }, 300_000);

  it("still resumes a session recorded before isolation existed (legacy rows)", async () => {
    // Tasks already in the store carry a `sessionFile` under the shared agent dir.
    // Q18 outranks D3: `--session <path>` must reopen THAT file, and `--session-dir`
    // must not redirect the resume into the persona dir. Measured against the real
    // binary: messageCount went 3 -> 5, the legacy file grew, and the persona dir was
    // created but stayed empty.
    const agentDir = personaDir("d3-legacy-persona");
    const fakeHome = join(tempDir, "d3-legacy-home");
    const fakeAgentConfig = join(fakeHome, ".pi", "agent");
    mkdirSync(fakeAgentConfig, { recursive: true });

    const previousHome = process.env.HOME;
    const previousConfig = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = fakeHome;
    process.env.PI_CODING_AGENT_DIR = fakeAgentConfig;
    try {
      const plain = new PiAdapter({ approveProjectResources: true });
      // No agentDir: the pre-D3 run, writing to the shared store.
      const legacy = join(tempDir, "d3-legacy-workspace");
      mkdirSync(legacy, { recursive: true });
      const first = await plain.start({
        runId: "d3-legacy-first", tenantId: "t", projectId: "p", memberId: "m",
        workspacePath: legacy, model: OFFLINE_MODEL,
        prompt: "Remember the token OLD-TOKEN. Reply SAVED.",
      });
      await drain(first);
      const legacyFile = (await first.settled).sessionFile;
      expect(legacyFile).toBeTruthy();
      expect(legacyFile!.startsWith(piSessionDirForAgent(agentDir))).toBe(false);
      expect(legacyFile!.startsWith(join(fakeAgentConfig, "sessions"))).toBe(true);
      const linesBefore = readFileSync(legacyFile!, "utf8").split("\n").filter(Boolean).length;
      const isolated = piSessionDirForAgent(agentDir);
      const resumed = await plain.start({
        runId: "d3-legacy-second", tenantId: "t", projectId: "p", memberId: "m",
        workspacePath: legacy, agentDir, model: OFFLINE_MODEL,
        prompt: "What token did I give you?",
        session: { sessionId: "irrelevant", sessionDir: isolated, sessionPath: legacyFile!, resume: true },
      });
      await drain(resumed);
      const second = await resumed.settled;

      // Resume wins: the same file, appended, not a fresh one in the persona dir.
      expect(second.sessionFile).toBe(legacyFile);
      const text = readFileSync(legacyFile!, "utf8");
      expect(text.split("\n").filter(Boolean).length, "legacy resume appended nothing")
        .toBeGreaterThan(linesBefore);
      expect(text).toContain("OLD-TOKEN");
      // The persona dir was created for the run but received no session: the resume
      // was not silently redirected into it.
      expect(existsSync(isolated) ? readdirSync(isolated) : []).toEqual([]);
      console.log(`[D3 legacy resume] file stayed at ${legacyFile} and grew; persona dir ${isolated} exists=${existsSync(isolated)}`);
    } finally {
      process.env.HOME = previousHome;
      if (previousConfig === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousConfig;
    }
  }, 300_000);
});
