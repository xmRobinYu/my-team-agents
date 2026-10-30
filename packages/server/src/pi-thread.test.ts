import { describe, expect, it } from "vitest";
import { ExecutionStore } from "@my-team-agents/orchestrator";
import { taskToMessages, taskToSnapshot, taskToThreadMetadata, toPiClientEvent } from "./pi-thread.js";
import { buildApp } from "./app.js";
import { createDurableWorker } from "@my-team-agents/orchestrator";
import type { RuntimeAdapter } from "@my-team-agents/runtime-core";

const input = { tenantId: "t", projectId: "p", memberId: "a", workspacePath: "/tmp", prompt: "do work" };

describe("pi-thread projection", () => {
  it("maps a task to thread metadata with status", () => {
    const store = new ExecutionStore();
    const task = store.createTask(input, 100);
    const meta = taskToThreadMetadata(task);
    expect(meta.id).toBe(task.id);
    expect(meta.status).toBe("running"); // queued is still active
    expect(meta.title).toBe("do work");
    store.close();
  });

  it("folds streaming deltas into one assistant message per attempt", () => {
    const store = new ExecutionStore();
    const task = store.createTask(input, 100);
    const claimed = store.claimNext("w", 100)!;
    store.appendEvent(claimed.attempt.id, claimed.attempt.fencingToken,
      { type: "message_update", runId: "r", timestamp: "", text: "Hello " });
    store.appendEvent(claimed.attempt.id, claimed.attempt.fencingToken,
      { type: "message_update", runId: "r", timestamp: "", text: "world" });
    const events = store.getEvents(task.id);
    const messages = taskToMessages(task, events);
    expect(messages).toHaveLength(2); // user + assistant
    const assistant = messages[1]!;
    expect(assistant.role).toBe("assistant");
    if (assistant.role === "assistant") {
      const parts = assistant.content as Array<{ type: string; text?: string }>;
      expect(parts[0]).toEqual({ type: "text", text: "Hello world" });
    }
    store.close();
  });

  it("message_end replaces accumulated text with authoritative content", () => {
    const store = new ExecutionStore();
    const task = store.createTask(input, 100);
    const claimed = store.claimNext("w", 100)!;
    store.appendEvent(claimed.attempt.id, claimed.attempt.fencingToken,
      { type: "message_update", runId: "r", timestamp: "", text: "partial" });
    store.appendEvent(claimed.attempt.id, claimed.attempt.fencingToken,
      { type: "message_end", runId: "r", timestamp: "", text: "final answer" });
    const messages = taskToMessages(task, store.getEvents(task.id));
    const finalAssistant = messages[1]!;
    if (finalAssistant.role === "assistant") {
      const parts = finalAssistant.content as Array<{ type: string; text?: string }>;
      expect(parts[0]).toEqual({ type: "text", text: "final answer" });
    }
    store.close();
  });

  it("translates message_update into a Pi frame with full message and delta", () => {
    const store = new ExecutionStore();
    const task = store.createTask(input, 100);
    const claimed = store.claimNext("w", 100)!;
    store.appendEvent(claimed.attempt.id, claimed.attempt.fencingToken,
      { type: "message_update", runId: "r", timestamp: "", text: "hi" });
    const rows = store.getEvents(task.id);
    const frame = toPiClientEvent(task.id, rows[0]!, rows);
    expect(frame?.type).toBe("message_update");
    if (frame?.type === "message_update") {
      expect(frame.threadId).toBe(task.id);
      expect(frame.message.role).toBe("assistant");
      expect(frame.assistantMessageEvent.type).toBe("text_delta");
    }
    store.close();
  });

  it("skips frames the Pi contract cannot represent instead of mis-shaping them", () => {
    const store = new ExecutionStore();
    const task = store.createTask(input, 100);
    const claimed = store.claimNext("w", 100)!;
    store.appendEvent(claimed.attempt.id, claimed.attempt.fencingToken,
      { type: "tool_execution_start", runId: "r", timestamp: "", toolName: "bash", toolCallId: "c1" });
    const rows = store.getEvents(task.id);
    expect(toPiClientEvent(task.id, rows[0]!, rows)).toBeNull();
    store.close();
  });

  it("snapshot carries metadata, messages and a sequence", () => {
    const store = new ExecutionStore();
    const task = store.createTask(input, 100);
    const snap = taskToSnapshot(task, store.getEvents(task.id));
    expect(snap.metadata.id).toBe(task.id);
    expect(snap.messages[0]!.role).toBe("user");
    expect(snap.seq).toBe(0);
    store.close();
  });
});

const okAdapter: RuntimeAdapter = {
  kind: "pi",
  capabilities: {
    streaming: true, steer: false, cancel: true, approval: "none", sandbox: "none",
    workspacePerRun: true, agentDirPerRun: false, usageAttribution: "message", costCap: false, sessionResume: false,
  },
  async start(spec) {
    return {
      runId: spec.runId,
      events: (async function* () {
        yield { type: "message_end", runId: spec.runId, timestamp: "", text: JSON.stringify({ outcome: "success", summary: "ok", artifacts: [], remainingRisks: [] }) } as never;
      })(),
      settled: Promise.resolve({ runId: spec.runId, status: "completed" }),
      async cancel() {},
    };
  },
};

describe("/api/pi routes", () => {
  const worker = () => createDurableWorker(new ExecutionStore(), { adapterFor: () => okAdapter });

  it("creates an empty placeholder thread then activates it on first message", async () => {
    const store = new ExecutionStore();
    const app = await buildApp({ store, worker: worker() });
    // react-pi initialize: no initialMessage.
    const created = await app.inject({ method: "POST", url: "/api/pi/threads", payload: {} });
    expect(created.statusCode).toBe(201);
    const threadId = created.json().metadata.id as string;
    // Placeholder is parked and must not be claimable yet.
    expect(store.claimNext("w", Date.now())).toBeNull();

    // First real message activates it with the actual prompt.
    const sent = await app.inject({
      method: "POST", url: `/api/pi/threads/${threadId}/messages`,
      payload: { input: { content: "real first task" } },
    });
    expect(sent.statusCode).toBe(204);
    expect(store.getTask(threadId)?.prompt).toBe("real first task");
    // Now it IS claimable.
    expect(store.claimNext("w", Date.now())?.task.id).toBe(threadId);
    await app.close();
  });

  it("lists threads and reads a snapshot", async () => {
    const store = new ExecutionStore();
    store.createTask(input, 100);
    const app = await buildApp({ store, worker: worker() });
    const list = await app.inject({ method: "GET", url: "/api/pi/threads" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    const id = list.json()[0].id as string;
    const snap = await app.inject({ method: "GET", url: `/api/pi/threads/${id}` });
    expect(snap.statusCode).toBe(200);
    expect(snap.json().metadata.id).toBe(id);
    expect(snap.json().messages[0].role).toBe("user");
    await app.close();
  });

  it("returns 404 for an unknown thread", async () => {
    const store = new ExecutionStore();
    const app = await buildApp({ store, worker: worker() });
    expect((await app.inject({ method: "GET", url: "/api/pi/threads/nope" })).statusCode).toBe(404);
    await app.close();
  });
});
