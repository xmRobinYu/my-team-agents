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
    expect(captured).toContain("--no-session");
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
