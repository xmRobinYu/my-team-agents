import { describe, expect, it } from "vitest";
import type { CanonicalEvent, RunHandle, RuntimeAdapter } from "@my-team-agents/runtime-core";
import { ExecutionStore, type TaskResult } from "./execution-store.js";
import { createDurableWorker } from "./durable-worker.js";

const result: TaskResult = { outcome: "success", summary: "done", artifacts: [], remainingRisks: [] };
const event = (attemptId: string, extra: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  type: "message_end", runId: attemptId, timestamp: new Date(0).toISOString(), text: JSON.stringify(result), ...extra,
});
const adapter = (run: (attemptId: string) => Promise<CanonicalEvent[]>): RuntimeAdapter => ({
  kind: "pi",
  capabilities: {
    streaming: true, steer: true, cancel: true, approval: "none", sandbox: "none",
    workspacePerRun: true, agentDirPerRun: false, usageAttribution: "message", costCap: false,
  },
  async start(spec): Promise<RunHandle> {
    const events = await run(spec.runId);
    return {
      runId: spec.runId,
      events: (async function* () { for (const item of events) yield item; })(),
      settled: Promise.resolve({ runId: spec.runId, status: "completed" }),
      async cancel() {},
    };
  },
});
const failingAdapter: RuntimeAdapter = {
  kind: "pi",
  capabilities: {
    streaming: true, steer: false, cancel: true, approval: "none", sandbox: "none",
    workspacePerRun: true, agentDirPerRun: false, usageAttribution: "message", costCap: false,
  },
  async start(spec): Promise<RunHandle> {
    return {
      runId: spec.runId,
      events: (async function* () {
        yield { type: "error", runId: spec.runId, timestamp: "", error: "boom", isError: true } as CanonicalEvent;
      })(),
      settled: Promise.resolve({ runId: spec.runId, status: "failed", error: "boom" }),
      async cancel() {},
    };
  },
};
const input = {
  tenantId: "t1", projectId: "p1", memberId: "a", workspacePath: "/workspace/p1", prompt: "do work",
};

describe("ExecutionStore", () => {
  it("persists queued work and claims it once", () => {
    const store = new ExecutionStore();
    store.createTask(input, 100);
    const first = store.claimNext("w1", 100);
    expect(first?.task.status).toBe("running");
    expect(store.claimNext("w2", 100)).toBeNull();
    expect(store.getAttempts(first!.task.id)).toHaveLength(1);
    store.close();
  });

  it("deduplicates task creation by idempotency key", () => {
    const store = new ExecutionStore();
    const one = store.createTask({ ...input, idempotencyKey: "request-1" });
    const two = store.createTask({ ...input, idempotencyKey: "request-1" });
    expect(two.id).toBe(one.id);
    expect(store.listTasks()).toHaveLength(1);
  });

  it("rejects late writes from an expired attempt", () => {
    const store = new ExecutionStore();
    store.createTask(input, 100);
    const claimed = store.claimNext("w1", 100)!;
    store.recoverAttempt(claimed.attempt.id, "lost worker", false, 200);
    expect(store.appendEvent(claimed.attempt.id, claimed.attempt.fencingToken, event(claimed.attempt.id), 201)).toBe(false);
    expect(() => store.completeSuccess(claimed.attempt.id, claimed.attempt.fencingToken, result, [], 201)).toThrow(/fencing/);
    expect(store.getTask(claimed.task.id)?.status).toBe("retry_wait");
  });

  it("retries at most three automatic attempts, then preserves history for a new batch", () => {
    const store = new ExecutionStore();
    store.createTask(input, 100);
    for (let i = 0; i < 3; i += 1) {
      const claimed = store.claimNext("w1", 100 + i * 30000)!;
      expect(store.finishFailure(claimed.attempt.id, claimed.attempt.fencingToken, "temporary", { now: 110 + i * 30000 })).toBe(i < 2 ? "retry_wait" : "failed");
    }
    expect(store.claimNext("w1", 100000)).toBeNull();
    expect(store.getAttempts(store.listTasks()[0]!.id)).toHaveLength(3);
    expect(store.retryTask(store.listTasks()[0]!.id, 100001)).toBe(true);
    const next = store.claimNext("w1", 100001)!;
    expect(next.attempt.sequence).toBe(4);
    expect(next.attempt.batch).toBe(2);
  });

  it("deduplicates handoffs and commits the chain budget only once", () => {
    const store = new ExecutionStore();
    const parent = store.createTask(input, 100);
    const claimed = store.claimNext("w1", 100)!;
    const handoff = {
      sourceToolCallId: "call-1", toMemberId: "b", reason: "review",
      input: { ...input, memberId: "b", prompt: "review implementation" },
    };
    store.completeSuccess(claimed.attempt.id, claimed.attempt.fencingToken, result, [handoff], 200);
    expect(() => store.completeSuccess(claimed.attempt.id, claimed.attempt.fencingToken, result, [handoff], 201)).toThrow(/fencing/);
    expect(store.listTasks()).toHaveLength(2);
    expect(store.getOutbox()).toHaveLength(1);
    expect(store.getChain(parent.chainId).budgetUsed).toBe(1);
    expect(store.getTask(parent.id)?.status).toBe("succeeded");
  });

  it("deduplicates cumulative usage per attempt", () => {
    const store = new ExecutionStore();
    store.createTask(input, 100);
    const claimed = store.claimNext("w1", 100)!;
    const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } };
    store.appendEvent(claimed.attempt.id, claimed.attempt.fencingToken, event(claimed.attempt.id, { usage, provider: "p", model: "m" }));
    store.appendEvent(claimed.attempt.id, claimed.attempt.fencingToken, event(claimed.attempt.id, { usage, provider: "p", model: "m" }));
    expect(store.getUsage()[0]?.totalTokens).toBe(15);
    expect(store.getUsage()[0]?.totalCost).toBe(2);
  });
});

describe("durable worker", () => {
  it("persists events and succeeds only with a structured result", async () => {
    const store = new ExecutionStore();
    store.createTask(input, 100);
    const worker = createDurableWorker(store, {
      adapterFor: () => adapter(async (attemptId) => [event(attemptId)]),
    });
    expect(await worker.runOnce()).toBe(true);
    const task = store.listTasks()[0]!;
    expect(task.status).toBe("succeeded");
    expect(task.result?.summary).toBe("done");
    expect(store.getEvents(task.id)).toHaveLength(1);
  });

  it("recovers a queued task after a worker restart", async () => {
    const store = new ExecutionStore();
    store.createTask(input, 100);
    const worker = createDurableWorker(store, { adapterFor: () => adapter(async (id) => [event(id)]) });
    await worker.runOnce();
    expect(store.listTasks()[0]?.status).toBe("succeeded");
    const restarted = createDurableWorker(store, { adapterFor: () => adapter(async (id) => [event(id)]) });
    expect(await restarted.runOnce()).toBe(false);
  });

  it("keeps the failure reason in the recovery snapshot for the next attempt", async () => {
    const store = new ExecutionStore();
    const task = store.createTask(input, 1000);
    const worker = createDurableWorker(store, { adapterFor: () => failingAdapter, now: () => 1000 });
    expect(await worker.runOnce()).toBe(true);
    const failed = store.getTask(task.id)!;
    expect(failed.status).toBe("retry_wait");
    const snapshot = JSON.parse(failed.recoverySnapshot ?? "{}") as { previousError?: string; originalTask?: string };
    expect(snapshot.previousError).toContain("boom");
    expect(snapshot.originalTask).toBe(input.prompt);
  });

  it("blocks an unknown non-read-only tool outcome", async () => {
    const store = new ExecutionStore();
    store.createTask(input, 100);
    const worker = createDurableWorker(store, {
      adapterFor: () => adapter(async (id) => [
        { type: "tool_execution_start", runId: id, timestamp: "", toolCallId: "tool-1", toolName: "send_feishu" },
        event(id),
      ]),
    });
    await worker.runOnce();
    expect(store.listTasks()[0]?.status).toBe("blocked");
    expect(store.listTasks()[0]?.error).toContain("send_feishu");
  });

  it("dispatches a handoff into a durable child task", async () => {
    const store = new ExecutionStore();
    store.createTask(input, 100);
    const worker = createDurableWorker(store, {
      adapterFor: () => adapter(async (id) => [
        { type: "tool_execution_start", runId: id, timestamp: "", toolCallId: "call-1", toolName: "handoff_to",
          args: { toMemberIds: ["b"], reason: "independent review", workPackage: "Review the diff and report risks." } },
        { type: "tool_execution_end", runId: id, timestamp: "", toolCallId: "call-1", toolName: "handoff_to" },
        event(id),
      ]),
    });
    await worker.runOnce();
    const child = store.listTasks().find((task) => task.memberId === "b");
    expect(child?.status).toBe("queued");
    expect(child?.prompt).toBe("Review the diff and report risks.");
    expect(child?.depth).toBe(1);
    await worker.runOnce();
    expect(store.getTask(child!.id)?.status).toBe("succeeded");
    expect(store.getChain(child!.chainId).budgetUsed).toBe(1);
  });
});
