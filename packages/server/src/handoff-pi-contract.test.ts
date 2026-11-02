import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { HANDOFF_TOOL_NAME, extractHandoffs, parseHandoffArgs } from "@my-team-agents/orchestrator";
import type { CanonicalEvent, RunSpec } from "@my-team-agents/runtime-core";
import { PiAdapter, handoffExtensionPath } from "@my-team-agents/runtime-pi";

/**
 * D1's coupling test — the one place where BOTH halves of the structured-handoff
 * contract are imported, because the defect was a disagreement between them:
 *
 *  - `orchestrator/durable-worker.ts` dispatches on
 *    `event.toolName === "handoff_to"` and parses `event.args` with
 *    `parseHandoffArgs`.
 *  - `runtime-pi` built an argv with **no** `--extension`, and Pi 1.4.0 owns no
 *    `handoff_to` tool — measured against the binary: a real model, asked to call
 *    it, answered "`handoff_to` is **not available** — it is not in my toolset" and
 *    emitted no tool event at all. The primary path was unreachable, so that branch
 *    was dead code and I5's two-path dedup only ever saw one path.
 *
 * This is the same class of defect as I9's skill bug (importer wrote a path the
 * runtime never mentioned) and gets the same remedy: a test that reads both sides.
 * It cannot live in `runtime-pi` either: the dependency direction there is
 * `orchestrator -> runtime-core <- runtime-pi`, so importing `HANDOFF_TOOL_NAME` and
 * `parseHandoffArgs` into the runtime would make a runtime package depend on its own
 * consumer. `server` already depends on both, which makes it the only legal host.
 */

const tempDir = mkdtempSync(join(tmpdir(), "d1-contract-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

const persona = join(tempDir, "persona-roster");
mkdirSync(persona, { recursive: true });

/** Records argv only; the fake child never runs, so nothing reaches a model. */
function argvRecorder(): {
  spawn: ConstructorParameters<typeof PiAdapter>[0]["spawn"];
  args: string[];
} {
  const args: string[] = [];
  const spawn = ((_command: string, a: string[]) => {
    args.push(...a);
    return {
      stdout: { setEncoding: () => {}, on: () => {} },
      stdin: { write: () => {} },
      kill: () => {},
      on: () => {},
      exitCode: null,
      killed: false,
    } as never;
  }) as unknown as ConstructorParameters<typeof PiAdapter>[0]["spawn"];
  return { spawn, args };
}

const spec: RunSpec = {
  runId: "contract", tenantId: "t", projectId: "p", memberId: "m",
  workspacePath: tempDir, agentDir: persona, prompt: "hand off",
};

describe("PiAdapter argv → orchestrator dispatch is one fact", () => {
  it("registers the tool the worker matches, through the file the argv points at", async () => {
    const { spawn, args } = argvRecorder();
    const handle = await new PiAdapter({ approveProjectResources: true, spawn }).start(spec);
    void handle.settled.catch(() => undefined);

    const index = args.indexOf("--extension");
    expect(index, `no --extension in: ${args.join(" ")}`).toBeGreaterThan(-1);
    const path = args[index + 1] as string;
    // Exactly this package's shipped file: not a copy under dist, not a discovery
    // path Pi would refuse to scan, not a cwd-relative guess.
    expect(path).toBe(handoffExtensionPath());

    // Read the registered name out of THAT file, so a rename on either side fails
    // here instead of silently disabling the primary path.
    const { default: register } = (await import(pathToFileURL(path).href)) as {
      default: (pi: { registerTool(tool: { name: string }): void }) => void;
    };
    const names: string[] = [];
    register({ registerTool: (tool) => { names.push(tool.name); } });
    expect(names).toEqual([HANDOFF_TOOL_NAME]);
  });

  it("a real wire-shaped tool event yields a handoff intent", () => {
    // Verbatim `tool_execution_start`, captured from a live session with this
    // extension loaded: toolCallId / toolName / args, nothing else.
    const wire: CanonicalEvent = {
      type: "tool_execution_start",
      runId: "r",
      timestamp: "",
      toolCallId: "call_00_adrthd1p7sc3e8nvqdjx9f4t",
      toolName: "handoff_to",
      args: { toMemberIds: ["reviewer"], reason: "plain schema probe" },
    };

    expect(wire.toolName).toBe(HANDOFF_TOOL_NAME);
    const parsed = parseHandoffArgs(wire.args);
    expect(parsed.issues).toEqual([]);
    expect(parsed.intents).toEqual([{ toMemberIds: ["reviewer"], reason: "plain schema probe" }]);

    const extracted = extractHandoffs([wire]);
    expect(extracted.intents).toHaveLength(1);
    expect(extracted.issues).toEqual([]);
  });

  it("any other tool name yields nothing — the negative half that used to pass vacuously", () => {
    const nearMisses: CanonicalEvent[] = [
      { type: "tool_execution_start", runId: "r", timestamp: "", toolName: "handoff", args: { toMemberIds: ["a"], reason: "r" } },
      { type: "tool_execution_start", runId: "r", timestamp: "", toolName: "handoff_too", args: { toMemberIds: ["a"], reason: "r" } },
      { type: "tool_execution_start", runId: "r", timestamp: "", toolName: "bash", args: { command: "echo hi" } },
      // A `tool_execution_end` is not a declaration: the worker commits on the start.
      { type: "tool_execution_end", runId: "r", timestamp: "", toolName: HANDOFF_TOOL_NAME, args: { toMemberIds: ["a"], reason: "r" } },
    ];
    expect(extractHandoffs(nearMisses).intents).toEqual([]);
  });

  it("keeps working the `to` alias and the optional workPackage the worker reads", () => {
    expect(parseHandoffArgs({ to: ["a", "b"], reason: "r" }).intents[0]?.toMemberIds).toEqual(["a", "b"]);
    const withPackage = parseHandoffArgs({ toMemberIds: ["a"], reason: "r", workPackage: "do it" });
    expect(withPackage.issues).toEqual([]);
    // `parseHandoffArgs` normalises to {toMemberIds, reason}; `workPackage` stays on
    // the raw args, which is exactly what `durable-worker.ts` reads back.
    expect(withPackage.intents).toEqual([{ toMemberIds: ["a"], reason: "r" }]);
  });

  it("an empty target list is still refused, so a malformed call cannot dispatch", () => {
    expect(parseHandoffArgs({ toMemberIds: [], reason: "r" }).intents).toEqual([]);
    expect(parseHandoffArgs({ toMemberIds: [], reason: "r" }).issues).toContain(
      "handoff requires a non-empty toMemberIds array",
    );
  });
});

const piAvailable = (() => {
  try {
    execFileSync("pi", ["--version"], { stdio: "pipe", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
})();

const REAL_PI = process.env.MTA_REAL_PI === "1";
const MODEL = process.env.MTA_REAL_PI_MODEL ?? "airouter/deepseek-v4.1-flash";

/**
 * End-to-end proof, opt-in like `just pi-smoke`: the adapter's own argv, a real Pi
 * child process, a real model, and the orchestrator's own parser. Three different
 * layers of the stack have to agree for this to pass, which is the point — D1 was
 * invisible precisely because every layer was individually self-consistent.
 */
describe.skipIf(!REAL_PI || !piAvailable)(`real pi + real model + orchestrator parser (${MODEL})`, () => {
  it("the primary handoff path is reachable end to end", async () => {
    const adapter = new PiAdapter({ approveProjectResources: true });
    const base: Omit<RunSpec, "runId"> = {
      tenantId: "t", projectId: "p", memberId: "m",
      workspacePath: persona, agentDir: persona, model: MODEL,
      prompt: [
        "You have a tool named handoff_to. Call it exactly once.",
        'Arguments: {"toMemberIds":["reviewer-bot"],"reason":"需要第二遍审阅","workPackage":"检查错误处理分支"}.',
        "Do not use any other tool and do not answer in prose before the call.",
      ].join("\n"),
    };

    const attempts: string[] = [];
    let intents: ReturnType<typeof extractHandoffs>["intents"] = [];
    let rawArgs: unknown;
    for (let attempt = 1; attempt <= 3 && intents.length === 0; attempt += 1) {
      const handle = await adapter.start({ ...base, runId: `d1-e2e-a${attempt}` });
      const seen: CanonicalEvent[] = [];
      for await (const event of handle.events) seen.push(event);
      const result = await handle.settled;
      const extracted = extractHandoffs(seen);
      intents = extracted.intents;
      rawArgs = seen.find(
        (event) => event.type === "tool_execution_start" && event.toolName === HANDOFF_TOOL_NAME,
      )?.args;
      const text = [...seen].reverse().find((event) => event.type === "message_end" && event.text)?.text ?? "";
      const tools = [...new Set(seen.map((event) => event.toolName).filter(Boolean))];
      attempts.push(`#${attempt} status=${result.status} tools=[${tools.join(", ")}] intents=${JSON.stringify(extracted.intents)} issues=${JSON.stringify(extracted.issues)} text=${text.slice(0, 160)}`);
    }

    // Raw evidence either way: on failure this prints what the model actually did.
    console.log(`[D1 e2e] model=${MODEL}\n  ${attempts.join("\n  ")}`);

    expect(intents, "no handoff intent survived the real Pi event stream").toHaveLength(1);
    expect(intents[0]?.toMemberIds).toEqual(["reviewer-bot"]);
    expect(intents[0]?.reason).toContain("审阅");
    expect((rawArgs as Record<string, unknown>)?.workPackage).toBe("检查错误处理分支");
  }, 300_000);
});
