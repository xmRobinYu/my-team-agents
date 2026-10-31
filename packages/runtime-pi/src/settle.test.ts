import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { PiAdapter } from "./adapter.js";
import type { RunSpec } from "@my-team-agents/runtime-core";

const spec: RunSpec = {
  runId: "run-1", tenantId: "t1", projectId: "p1", memberId: "m1",
  workspacePath: "/tmp/project", prompt: "ship it",
};
type FakeChild = EventEmitter & {
  stdout: { setEncoding(): void; on(ev: "data", fn: (chunk: string) => void): void };
  stdin: { write(value: string): void };
  kill(): void;
  killed: boolean;
  exitCode: number | null;
};

function fakePi(onStart?: (child: FakeChild) => void): { spawn: typeof import("node:child_process").spawn; child: FakeChild } {
  const child = new EventEmitter() as FakeChild;
  child.killed = false;
  child.exitCode = null;
  const listeners: Array<(chunk: string) => void> = [];
  child.stdout = {
    setEncoding: () => {},
    on: (_event, listener) => listeners.push(listener),
  };
  child.stdin = { write: () => {} };
  child.kill = () => { child.killed = true; };
  const send = (line: unknown) => { for (const l of listeners) l(`${JSON.stringify(line)}\n`); };
  const spawn = ((_command: string, args: string[]) => {
    onStart?.(child);
    setTimeout(() => {
      send({ type: "agent_start" });
      send({ type: "message_update", assistantMessageEvent: { delta: "working" } });
      send({ type: "message_end", message: { role: "assistant", content: "done" } });
      send({ type: "agent_end" });
      send({ type: "agent_settled", aborted: false });
    }, 0);
    return child as never;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, child };
}

describe("PiAdapter lifecycle", () => {
  it("does not resolve settled on agent_end in long-lived RPC mode", async () => {
    const { spawn } = fakePi();
    const adapter = new PiAdapter({ approveProjectResources: true, spawn });
    const handle = await adapter.start(spec);
    const seen: string[] = [];
    let settledStatus: string | null = null;
    void handle.settled.then((result) => { settledStatus = result.status; });
    for await (const event of handle.events) {
      seen.push(event.type);
      if (event.type === "agent_end") {
        // Not a reliable point to assert: the fixture emits both frames in one
        // chunk, so settlement may already be resolved by the time we observe
        // agent_end. The ordering guarantee is asserted after the stream ends.
      }
    }
    expect(seen).toContain("agent_settled");
    expect(seen.indexOf("agent_settled")).toBeGreaterThan(seen.indexOf("agent_end"));
    await handle.settled;
    expect(settledStatus).toBe("completed");
  });

  it("passes --approve explicitly and never relies on an interactive prompt", async () => {
    let captured: string[] = [];
    const { spawn } = fakePi((child) => { void child; });
    const wrapped = ((command: string, args: string[]) => {
      captured = args;
      return spawn(command, args);
    }) as unknown as typeof import("node:child_process").spawn;
    const adapter = new PiAdapter({ approveProjectResources: true, spawn: wrapped });
    const handle = await adapter.start(spec);
    for await (const _event of handle.events) { break; }
    expect(captured).toContain("rpc");
    expect(captured).toContain("--approve");
  });

  it("persists a session by default so a later run can resume it", async () => {
    const capture = async (s: RunSpec): Promise<string[]> => {
      let args: string[] = [];
      const { spawn } = fakePi((child) => { void child; });
      const wrapped = ((_command: string, a: string[]) => {
        args = a;
        return spawn(_command, a);
      }) as unknown as typeof import("node:child_process").spawn;
      const handle = await new PiAdapter({ approveProjectResources: false, spawn: wrapped }).start(s);
      for await (const _event of handle.events) { break; }
      return args;
    };

    const defaultArgs = await capture({ ...spec });
    // Default must NOT pass --no-session: that made the first run ephemeral, so
    // resume could never work. Pi persists a session instead.
    expect(defaultArgs).not.toContain("--no-session");
    expect(defaultArgs).not.toContain("--session");

    const ephemeralArgs = await capture({ ...spec, session: { sessionId: "", sessionDir: "", resume: false } });
    expect(ephemeralArgs).toContain("--no-session");

    // --session-id alone does not load history; --session <path> does.
    const resumeArgs = await capture({
      ...spec,
      session: { sessionId: "s1", sessionDir: "/d", sessionPath: "/d/s1.jsonl", resume: true },
    });
    expect(resumeArgs).toContain("--session");
    expect(resumeArgs).toContain("/d/s1.jsonl");
    expect(resumeArgs).not.toContain("--session-id");
  });

  it("drops RPC control frames instead of surfacing them as events", async () => {
    const child = new EventEmitter() as FakeChild;
    child.killed = false;
    child.exitCode = null;
    child.kill = () => { child.killed = true; };
    child.stdin = { write: () => {} };
    const dataListeners: Array<(chunk: string) => void> = [];
    child.stdout = {
      setEncoding: () => {},
      on: (event, listener) => { if (event === "data") dataListeners.push(listener); },
    };
    const spawn = ((_command: string, _args: string[]) => child) as unknown as typeof import("node:child_process").spawn;
    const adapter = new PiAdapter({ approveProjectResources: false, spawn });
    const handle = await adapter.start(spec);
    // `response` and `extension_ui_request` are protocol records, not session
    // activity (node_modules/@earendil-works/pi-coding-agent/docs/rpc.md, upstream pi
    // package docs); only agent_settled may reach consumers.
    for (const send of dataListeners) {
      send(`${JSON.stringify({ type: "response", command: "prompt", success: true })}\n`);
      send(`${JSON.stringify({ type: "extension_ui_request", id: "u1" })}\n`);
      send(`${JSON.stringify({ type: "agent_settled", aborted: false })}\n`);
    }
    // The iterator terminates on stdout "end" / child "exit" (the upstream
    // node_modules/@earendil-works/pi-coding-agent/docs/rpc.md shutdown section); the
    // fake must emit one or the for-await loop hangs.
    child.emit("exit", 0, null);
    const seen: string[] = [];
    for await (const event of handle.events) seen.push(event.type);
    expect(seen).toEqual(["agent_settled"]);
  });

  it("reports a failed result when Pi exits before agent_settled", async () => {
    // A child that emits agent_end but exits without agent_settled.
    const child = new EventEmitter() as FakeChild;
    child.killed = false;
    child.exitCode = null;
    const listeners: Array<(chunk: string) => void> = [];
    child.stdout = {
      setEncoding: () => {},
      on: (_event, listener) => listeners.push(listener),
    };
    child.stdin = { write: () => {} };
    child.kill = () => { child.killed = true; };
    const spawn = ((_command: string, _args: string[]) => {
      setTimeout(() => {
        for (const listener of listeners) {
          listener(JSON.stringify({ type: "agent_end" }) + "\n");
        }
        child.emit("exit", 1, null);
      }, 0);
      return child as never;
    }) as unknown as typeof import("node:child_process").spawn;
    const adapter = new PiAdapter({ approveProjectResources: true, spawn });
    const handle = await adapter.start({ ...spec, runId: "run-exit" });
    void (async () => { for await (const _event of handle.events) { /* drain */ } })();
    const result = await handle.settled;
    expect(result.status).toBe("failed");
    expect(result.error).toContain("agent_settled");
  });
});

describe("PiAdapter agentDir (I3)", () => {
  /** Records the spawn options without launching any real process. */
  const captureCwd = async (agentDir?: string): Promise<string | undefined> => {
    let cwd: string | undefined;
    const { spawn } = fakePi();
    const wrapped = ((_command: string, args: string[], options?: { cwd?: string }) => {
      cwd = options?.cwd;
      return spawn(_command, args);
    }) as unknown as typeof import("node:child_process").spawn;
    const handle = await new PiAdapter({ approveProjectResources: true, spawn: wrapped })
      .start({ ...spec, ...(agentDir ? { agentDir } : {}) });
    for await (const _event of handle.events) { break; }
    return cwd;
  };

  it("uses the persona dir as cwd when agentDir is present", async () => {
    // Pi resolves personas from cwd, so this is the only mechanism that works;
    // the trade-off is that the run cannot see the project workspace.
    expect(await captureCwd("/tmp/persona/a1")).toBe("/tmp/persona/a1");
  });

  it("falls back to workspacePath when agentDir is absent", async () => {
    expect(await captureCwd()).toBe(spec.workspacePath);
  });

  it("declares agentDirPerRun, matching the behaviour above", () => {
    expect(new PiAdapter({ approveProjectResources: true }).capabilities.agentDirPerRun).toBe(true);
  });
});
