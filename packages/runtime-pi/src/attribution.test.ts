import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { PiAdapter } from "./adapter.js";
import type { CanonicalEvent, RunSpec } from "@my-team-agents/runtime-core";

const spec: RunSpec = {
  runId: "run-attr", tenantId: "t1", projectId: "p1", memberId: "m1",
  workspacePath: "/tmp/project", prompt: "ship it",
};

type FakeChild = EventEmitter & {
  stdout: { setEncoding(): void; on(ev: string, fn: (chunk: string) => void): void };
  stdin: { write(value: string): void };
  kill(): void;
  killed: boolean;
  exitCode: number | null;
};

/** A fake `pi` child whose stdout can be written to from the test. */
function makeChild(): FakeChild & { feed(record: unknown): void; close(): void } {
  const child = new EventEmitter() as FakeChild & { feed(record: unknown): void; close(): void };
  child.killed = false;
  child.exitCode = null;
  child.kill = () => { child.killed = true; };
  child.stdin = { write: () => {} };
  const listeners: Array<(chunk: string) => void> = [];
  child.stdout = {
    setEncoding: () => {},
    on: (event, listener) => { if (event === "data") listeners.push(listener); },
  };
  child.feed = (record) => { for (const l of listeners) l(`${JSON.stringify(record)}\n`); };
  child.close = () => { child.emit("exit", 0, null); };
  return child;
}

const usage = (n: number) => ({
  input: n, output: 3, cacheRead: 512, cacheWrite: 0, totalTokens: n + 515,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const assistant = (over: Record<string, unknown> = {}) => ({
  role: "assistant", api: "openai-completions", provider: "airouter",
  model: "deepseek-v4.1-flash", usage: usage(906), stopReason: "stop", ...over,
});

const byType = (events: CanonicalEvent[], type: string) => events.filter((e) => e.type === type);

/** Drives one run over an explicit record sequence and returns the canonical events. */
async function collect(records: unknown[], runSpec: RunSpec = spec): Promise<CanonicalEvent[]> {
  const child = makeChild();
  const spawn = ((_command: string, _args: string[]) => child) as unknown as typeof import("node:child_process").spawn;
  const handle = await new PiAdapter({ approveProjectResources: true, spawn }).start(runSpec);
  for (const record of records) child.feed(record);
  // Terminates the iterator; the fake has no real process closing stdout.
  child.close();
  const seen: CanonicalEvent[] = [];
  for await (const event of handle.events) seen.push(event);
  return seen;
}

describe("PiAdapter model attribution", () => {
  it("reads provider/model off the message_end message", async () => {
    // The real wire shape: attribution only ever exists inside `message`.
    const events = await collect([
      { type: "message_end", message: assistant() },
      { type: "agent_settled", aborted: false },
    ]);
    const [end] = byType(events, "message_end");
    expect(end?.provider).toBe("airouter");
    expect(end?.model).toBe("deepseek-v4.1-flash");
  });

  it("prefers responseModel over the requested model", async () => {
    // Aligns with upstream's own aggregation key (usage-totals.js:47 — provider /
    // responseModel ?? model). Billing follows the model that actually answered.
    const events = await collect([
      { type: "message_end", message: assistant({ responseModel: "deepseek-v4.1-pro" }) },
    ]);
    expect(byType(events, "message_end")[0]?.model).toBe("deepseek-v4.1-pro");
    expect(byType(events, "message_end")[0]?.provider).toBe("airouter");
  });

  it("backfills a delta-only message_update from the preceding message_start", async () => {
    // toJsonEvent() strips the cumulative message from message_update, so the frame
    // carries usage but nothing to attribute it to. This is the case that used to
    // produce ('unknown','unknown') and merge two models into one MAX() row.
    const events = await collect([
      { type: "message_start", message: assistant({ usage: usage(0) }) },
      { type: "message_update", usage: usage(906), assistantMessageEvent: { delta: "hel" } },
      { type: "message_update", usage: usage(1200), assistantMessageEvent: { delta: "lo" } },
      { type: "message_end", message: assistant({ usage: usage(1200) }) },
    ]);
    const updates = byType(events, "message_update");
    expect(updates).toHaveLength(2);
    for (const update of updates) {
      expect(update.provider).toBe("airouter");
      expect(update.model).toBe("deepseek-v4.1-flash");
      expect(update.usage).toBeDefined();
    }
    const end = byType(events, "message_end")[0];
    expect(updates[0]?.provider).toBe(end?.provider);
    expect(updates[0]?.model).toBe(end?.model);
  });

  it("takes the last assistant message from agent_end's messages array", async () => {
    // agent_end carries the transcript, not a single message; trailing user/toolResult
    // entries have no provider/model and must not win.
    const events = await collect([
      {
        type: "agent_end",
        willRetry: false,
        messages: [
          assistant({ usage: usage(10) }),
          { role: "user", content: "again", timestamp: 0 },
          assistant({ provider: "openrouter", model: "llama-4" }),
          { role: "toolResult", content: "ok", timestamp: 0 },
        ],
      },
    ]);
    expect(byType(events, "agent_end")[0]?.provider).toBe("openrouter");
    expect(byType(events, "agent_end")[0]?.model).toBe("llama-4");
  });

  it("seeds attribution from get_state so the FIRST message_update is attributable", async () => {
    // Deltas before the first message_end are exactly where a session-level source
    // matters: the response frame arrives while no message exists yet.
    const events = await collect([
      {
        type: "response", command: "get_state", success: true,
        data: { model: { id: "deepseek-v4.1-flash", provider: "airouter", api: "openai-completions" }, sessionFile: "/s.jsonl" },
      },
      { type: "message_update", usage: usage(906), assistantMessageEvent: { delta: "hel" } },
    ]);
    const first = byType(events, "message_update")[0];
    expect(first?.provider).toBe("airouter");
    expect(first?.model).toBe("deepseek-v4.1-flash");
    // The control frame itself is still not surfaced as an event.
    expect(events.map((e) => e.type)).toEqual(["message_update"]);
  });

  it("switches attribution when a retry or compaction changes the model mid-run", async () => {
    const events = await collect([
      { type: "message_end", message: assistant() },
      { type: "message_update", usage: usage(100), assistantMessageEvent: { delta: "x" } },
      { type: "message_start", message: assistant({ provider: "openrouter", model: "llama-4" }) },
      { type: "message_update", usage: usage(500), assistantMessageEvent: { delta: "y" } },
    ]);
    const updates = byType(events, "message_update");
    expect(updates[0]?.model).toBe("deepseek-v4.1-flash");
    // Two models in one Attempt must stay two distinct rows downstream, otherwise
    // appendEvent's MAX() upsert merges them and understates the total.
    expect(updates[1]?.provider).toBe("openrouter");
    expect(updates[1]?.model).toBe("llama-4");
  });

  it("leaves provider/model undefined when nothing carries attribution", async () => {
    // `undefined`, not "": ExecutionStore's `?? "unknown"` stays the explicit signal
    // that attribution was never observed.
    const events = await collect([
      { type: "agent_start" },
      { type: "message_update", usage: usage(906), assistantMessageEvent: { delta: "hel" } },
      { type: "message_end", message: { role: "user", content: "hi", timestamp: 0 } },
    ]);
    const update = byType(events, "message_update")[0]!;
    expect(update.usage).toBeDefined();
    expect(update.provider).toBeUndefined();
    expect(update.model).toBeUndefined();
    expect("provider" in update).toBe(false);
    expect("model" in update).toBe(false);
  });

  it("never leaks attribution across runs of one adapter instance", async () => {
    // The memory lives inside streamEvents(), not on the class, so a retried Attempt
    // cannot inherit the model of the Attempt before it — even when the same adapter
    // object drives both runs.
    const children = [makeChild(), makeChild()];
    let spawned = 0;
    const spawn = ((_command: string, _args: string[]) => children[spawned++]) as unknown as typeof import("node:child_process").spawn;
    const adapter = new PiAdapter({ approveProjectResources: true, spawn });

    const drain = async (handle: Awaited<ReturnType<PiAdapter["start"]>>): Promise<CanonicalEvent[]> => {
      const seen: CanonicalEvent[] = [];
      for await (const event of handle.events) seen.push(event);
      return seen;
    };

    const one = await adapter.start(spec);
    children[0]!.feed({ type: "message_end", message: assistant() });
    children[0]!.close();
    expect(byType(await drain(one), "message_end")[0]?.model).toBe("deepseek-v4.1-flash");

    const two = await adapter.start({ ...spec, runId: "run-attr-2" });
    children[1]!.feed({ type: "message_update", usage: usage(7), assistantMessageEvent: { delta: "z" } });
    children[1]!.close();
    const update = byType(await drain(two), "message_update")[0]!;
    expect(update.model).toBeUndefined();
    expect(update.provider).toBeUndefined();
  });
});
