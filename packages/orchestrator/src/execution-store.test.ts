import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { CanonicalEvent, RunHandle, RuntimeAdapter } from "@my-team-agents/runtime-core";
import { ExecutionStore, retryDelay, type TaskResult } from "./execution-store.js";
import { createDurableWorker } from "./durable-worker.js";

describe("agent_dir migration (I3)", () => {
  it("adds agent_dir to databases created before the column existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "mta-migrate-"));
    const dbPath = join(dir, "queue.sqlite");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        chain_id TEXT NOT NULL,
        parent_task_id TEXT,
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        prompt TEXT NOT NULL,
        group_id TEXT,
        model TEXT,
        depth INTEGER NOT NULL DEFAULT 0,
        batch INTEGER NOT NULL DEFAULT 1,
        batch_attempts INTEGER NOT NULL DEFAULT 0,
        fencing_token INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT UNIQUE,
        recovery_snapshot TEXT,
        session_file TEXT,
        status TEXT NOT NULL,
        active_attempt_id TEXT,
        available_at INTEGER NOT NULL,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO tasks(id,chain_id,tenant_id,project_id,member_id,workspace_path,prompt,status,available_at,created_at,updated_at)
        VALUES('legacy-task','legacy-chain','t1','p1','a','/workspace/legacy','old work','queued',100,100,100);
    `);
    legacy.close();

    const store = new ExecutionStore(dbPath);
    const migrated = store.createTask({ ...input, agentDir: "/tmp/persona/a1" }, 100);
    const plain = store.createTask(input, 100);
    expect(store.getTask(migrated.id)?.agentDir).toBe("/tmp/persona/a1");
    expect(store.getTask(plain.id)?.agentDir).toBeUndefined();
    expect(store.getTask("legacy-task")?.agentDir).toBeUndefined();
    expect(store.getTask(migrated.id)?.workspacePath).toBe(input.workspacePath);
    store.close();

    const probe = new DatabaseSync(dbPath);
    const columns = probe.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    probe.close();
    expect(columns.some((column) => column.name === "agent_dir")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

const result: TaskResult = { outcome: "success", summary: "done", artifacts: [], remainingRisks: [] };
const event = (attemptId: string, extra: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  type: "message_end", runId: attemptId, timestamp: new Date(0).toISOString(), text: JSON.stringify(result), ...extra,
});
const adapter = (run: (attemptId: string) => Promise<CanonicalEvent[]>): RuntimeAdapter => ({
  kind: "pi",
  capabilities: {
    streaming: true, steer: true, cancel: true, approval: "none", sandbox: "none",
    workspacePerRun: true, agentDirPerRun: false, usageAttribution: "message", costCap: false, sessionResume: false,
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
    workspacePerRun: true, agentDirPerRun: false, usageAttribution: "message", costCap: false, sessionResume: false,
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
    // rng pinned to 0.5 => zero jitter (exactly 5s/25s). This case walks exact
    // claim clocks; the jitter window itself is asserted in the cases below.
    const store = new ExecutionStore(":memory:", { rng: () => 0.5 });
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

  it("throttles a failed task inside the bounded jitter window", () => {
    const store = new ExecutionStore();
    store.createTask(input, 100);
    const claimed = store.claimNext("w1", 100)!;
    store.finishFailure(claimed.attempt.id, claimed.attempt.fencingToken, "boom", { now: 110 });
    const availableAt = store.getTask(claimed.task.id)!.availableAt;
    // First tier: 5_000 x [0.8, 1.2]. Assert the interval, never an exact value.
    expect(availableAt).toBeGreaterThanOrEqual(110 + 4_000);
    expect(availableAt).toBeLessThanOrEqual(110 + 6_000);
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

  it("holds a group's second task while its first Attempt is live (I3 AC3)", () => {
    const store = new ExecutionStore();
    // availableAt is pinned to 100 for all four: createTask's `now` also stamps
    // available_at, and these tests claim at t=100.
    const first = store.createTask({ ...input, memberId: "a", groupId: "room-1", availableAt: 100 }, 100);
    const second = store.createTask({ ...input, memberId: "b", groupId: "room-1", availableAt: 100 }, 101);
    const other = store.createTask({ ...input, memberId: "c", groupId: "room-2", availableAt: 100 }, 102);
    const loose = store.createTask({ ...input, memberId: "d", availableAt: 100 }, 103);
    expect(store.claimNext("w1", 100)?.task.id).toBe(first.id);
    // Another Worker cannot slip a second room-1 task in beside the live Attempt.
    expect(store.claimNext("w2", 100)?.task.id).toBe(other.id);
    expect(store.claimNext("w3", 100)?.task.id).toBe(loose.id);
    expect(store.claimNext("w4", 100)).toBeNull();

    // The blocked task is untouched, still queued — not failed, not lost.
    expect(store.getTask(second.id)?.status).toBe("queued");
    store.completeSuccess(
      store.getTask(first.id)!.activeAttemptId!,
      store.getTask(first.id)!.fencingToken,
      result, [], 200,
    );
    expect(store.claimNext("w5", 200)?.task.id).toBe(second.id);
    store.close();
  });

  it("releases a group when the live Attempt's lease expires", () => {
    const store = new ExecutionStore();
    const first = store.createTask({ ...input, groupId: "room-1" }, 100);
    const second = store.createTask({ ...input, memberId: "b", groupId: "room-1" }, 101);
    const claimed = store.claimNext("dead-worker", 100, 1_000)!;
    expect(claimed.task.id).toBe(first.id);
    expect(store.claimNext("w2", 1_050)).toBeNull();
    // Past the lease the holder is presumed gone, so the room must not deadlock.
    expect(store.claimNext("w2", 1_100)?.task.id).toBe(second.id);
    store.close();
  });
});

describe("retryDelay", () => {
  it("is exact and bounded for an injected random source", () => {
    expect(retryDelay(1, () => 0)).toBe(4_000);
    expect(retryDelay(1, () => 0.5)).toBe(5_000);
    expect(retryDelay(1, () => 1)).toBe(6_000);
    expect(retryDelay(2, () => 0)).toBe(20_000);
    expect(retryDelay(3, () => 0.5)).toBe(25_000);
    expect(retryDelay(5, () => 1)).toBe(30_000);
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

  it("passes the task's agentDir to the adapter as a per-run persona dir (I3)", async () => {
    const store = new ExecutionStore();
    const seen: Array<string | undefined> = [];
    const recording: RuntimeAdapter = {
      kind: "pi",
      capabilities: {
        streaming: true, steer: false, cancel: true, approval: "none", sandbox: "none",
        workspacePerRun: true, agentDirPerRun: true, usageAttribution: "message", costCap: false, sessionResume: false,
      },
      async start(spec): Promise<RunHandle> {
        seen.push(spec.agentDir);
        return {
          runId: spec.runId,
          events: (async function* () { yield event(spec.runId); })(),
          settled: Promise.resolve({ runId: spec.runId, status: "completed" }),
          async cancel() {},
        };
      },
    };
    store.createTask({ ...input, agentDir: "/persona/a1" }, 100);
    store.createTask({ ...input, memberId: "b" }, 101);
    const worker = createDurableWorker(store, { adapterFor: () => recording });
    await worker.runOnce();
    await worker.runOnce();
    // A task without an agentDir stays undefined, not an empty string.
    expect(seen).toEqual(["/persona/a1", undefined]);
    store.close();
  });
});
