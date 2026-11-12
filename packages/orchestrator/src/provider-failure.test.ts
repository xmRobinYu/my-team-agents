/**
 * P9c — "the provider never answered" must not be reported as "the agent gave a
 * bad answer".
 *
 * A real session (2026-11-13) showed the user a bare English contract string —
 * `missing valid structured result (outcome, summary, artifacts, remainingRisks)` —
 * while the Task was already retrying. The Attempt had produced no text at all: the
 * provider had refused every call and Pi's own `auto_retry` had exhausted itself.
 * Blaming the agent for that is wrong twice: the message is unreadable to the
 * person reading the panel, and an operator counting failures cannot see rate
 * limits as rate limits.
 */

import { describe, expect, it } from "vitest";
import type { CanonicalEvent, RunHandle, RuntimeAdapter } from "@my-team-agents/runtime-core";
import { ExecutionStore } from "./execution-store.js";
import { createDurableWorker } from "./durable-worker.js";

const input = {
  tenantId: "t1", projectId: "p1", memberId: "agent-eng", workspacePath: "/tmp/ws", prompt: "规划",
};

const adapter = (events: (runId: string) => CanonicalEvent[]): RuntimeAdapter => ({
  kind: "pi",
  capabilities: {
    streaming: true, steer: true, cancel: true, approval: "none", sandbox: "none",
    workspacePerRun: true, agentDirPerRun: false, usageAttribution: "message",
    costCap: false, sessionResume: false,
  },
  async start(spec: { runId: string }): Promise<RunHandle> {
    return {
      runId: spec.runId,
      events: (async function* () { for (const event of events(spec.runId)) yield event; })(),
      settled: Promise.resolve({ runId: spec.runId, status: "completed" as const }),
      async cancel() {},
    };
  },
});

const stamp = new Date(0).toISOString();

describe("P9c — an empty reply after upstream retries is a provider failure", () => {
  it("classifies it as provider_unavailable and says so in Chinese", async () => {
    const store = new ExecutionStore(":memory:");
    const worker = createDurableWorker(store, {
      // The real shape: the injected persona/prompt comes back as a message
      // first, so "no text anywhere" is the wrong test — the FINAL message is.
      adapterFor: () => adapter((runId) => [
        { type: "message_end", runId, timestamp: stamp, text: "---\nname: software-team-lead" } as CanonicalEvent,
        { type: "auto_retry_start", runId, timestamp: stamp } as CanonicalEvent,
        { type: "message_end", runId, timestamp: stamp, text: "" } as CanonicalEvent,
      ]),
    });
    const task = store.createTask(input, 100);

    await worker.runOnce();

    const attempt = store.getAttempts(task.id)[0]!;
    expect(attempt.errorKind).toBe("provider_unavailable");
    expect(attempt.error).toContain("provider 没有返回任何内容");
    // Retryable: it is transient by nature, so the Task goes back to the queue.
    expect(store.getTask(task.id)?.status).toBe("retry_wait");
    store.close();
  });

  it("keeps result_invalid for a reply that exists but lacks the contract", async () => {
    const store = new ExecutionStore(":memory:");
    const worker = createDurableWorker(store, {
      adapterFor: () => adapter((runId) => [
        { type: "message_end", runId, timestamp: stamp, text: "我先说一下计划，但没有 JSON。" } as CanonicalEvent,
      ]),
    });
    const task = store.createTask(input, 100);

    await worker.runOnce();

    const attempt = store.getAttempts(task.id)[0]!;
    expect(attempt.errorKind).toBe("result_invalid");
    expect(attempt.error).toContain("missing valid structured result");
    store.close();
  });
});
