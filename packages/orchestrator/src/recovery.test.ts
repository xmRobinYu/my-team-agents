import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExecutionStore } from "./execution-store.js";
import { createDurableWorker } from "./durable-worker.js";
import type { CanonicalEvent, RunHandle, RuntimeAdapter } from "@my-team-agents/runtime-core";

const input = { tenantId: "t", projectId: "p", memberId: "a", workspacePath: "/tmp", prompt: "task" };
/** Set by the resume test before the first Attempt reports it. */
let sessionPath = "";
const success = JSON.stringify({ outcome: "success", summary: "ok", artifacts: [], remainingRisks: [] });
const successfulAdapter: RuntimeAdapter = {
  kind: "pi",
  capabilities: { streaming: true, steer: true, cancel: true, approval: "none", sandbox: "none",
    workspacePerRun: true, agentDirPerRun: false, usageAttribution: "message", costCap: false, sessionResume: false },
  async start(spec): Promise<RunHandle> {
    const event: CanonicalEvent = { type: "message_end", runId: spec.runId, timestamp: "", text: success };
    return {
      runId: spec.runId,
      events: (async function* () { yield event; })(),
      settled: Promise.resolve({ runId: spec.runId, status: "completed" }),
      async cancel() {},
    };
  },
};

/**
 * Fails on the first Attempt while reporting a session file, so the retry can be
 * checked for resume wiring (Q18: resume the original session when supported).
 */
const sessionAdapter = (seen: Array<string | undefined>): RuntimeAdapter => ({
  kind: "pi",
  capabilities: { streaming: true, steer: true, cancel: true, approval: "none", sandbox: "none",
    workspacePerRun: true, agentDirPerRun: false, usageAttribution: "message", costCap: false, sessionResume: true },
  async start(spec): Promise<RunHandle> {
    seen.push(spec.session?.sessionPath);
    const first = seen.length === 1;
    const event: CanonicalEvent = first
      ? { type: "error", runId: spec.runId, timestamp: "", isError: true, error: "boom" }
      : { type: "message_end", runId: spec.runId, timestamp: "", text: success };
    return {
      runId: spec.runId,
      events: (async function* () { yield event; })(),
      settled: Promise.resolve(first
        ? { runId: spec.runId, status: "failed", error: "boom", sessionFile: sessionPath }
        : { runId: spec.runId, status: "completed" }),
      async cancel() {},
    };
  },
});

describe("durable execution recovery", () => {
  it("recovers queued work from an actual SQLite file after reopening", () => {
    const directory = mkdtempSync(join(tmpdir(), "mta-store-"));
    const filename = join(directory, "queue.sqlite");
    const first = new ExecutionStore(filename);
    const task = first.createTask(input, 100);
    first.close();

    const reopened = new ExecutionStore(filename);
    expect(reopened.getTask(task.id)?.status).toBe("queued");
    expect(reopened.claimNext("new-worker", 200)?.task.id).toBe(task.id);
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("resumes the original session on retry when the runtime supports it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mta-session-"));
    sessionPath = join(directory, "s1.jsonl");
    writeFileSync(sessionPath, "{}\n");
    const store = new ExecutionStore();
    const task = store.createTask(input, 100);
    const seen: Array<string | undefined> = [];
    let clock = 100;
    const worker = createDurableWorker(store, {
      adapterFor: () => sessionAdapter(seen), now: () => clock, leaseMs: 1000,
    });
    expect(await worker.runOnce()).toBe(true);
    // First Attempt: no session to resume, and it reports where Pi wrote one.
    expect(seen[0]).toBeUndefined();
    expect(store.getTask(task.id)?.status).toBe("retry_wait");
    expect(store.getTask(task.id)?.sessionFile).toBe(sessionPath);

    clock = 100_000;
    expect(await worker.runOnce()).toBe(true);
    // Second Attempt resumes the same session file instead of starting fresh.
    expect(seen[1]).toBe(sessionPath);
    expect(store.getTask(task.id)?.status).toBe("succeeded");
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("recovers an expired running attempt and preserves its history", async () => {
    const store = new ExecutionStore();
    const task = store.createTask(input, 100);
    const claimed = store.claimNext("dead-worker", 100)!;
    store.appendEvent(claimed.attempt.id, claimed.attempt.fencingToken,
      { type: "message_update", runId: claimed.attempt.id, timestamp: "", text: "partial" }, 110);
    expect(store.expiredAttempts(31_100)).toHaveLength(1);
    const worker = createDurableWorker(store, { adapterFor: () => successfulAdapter, now: () => 31_100 });
    expect(worker.recoverExpired()).toBe(1);
    expect(store.getTask(task.id)?.status).toBe("retry_wait");
    expect(store.getTask(task.id)?.recoverySnapshot).toContain("partial");
    expect(await worker.runOnce()).toBe(true);
    expect(store.getTask(task.id)?.status).toBe("succeeded");
    expect(store.getAttempts(task.id)).toHaveLength(2);
    expect(store.getAttempts(task.id)[0]?.status).toBe("orphaned");
  });

  it("cancels unfinished descendants without reviving a cancelled chain on manual retry", () => {
    const store = new ExecutionStore();
    const parent = store.createTask(input, 100);
    const claimed = store.claimNext("w", 100)!;
    store.completeSuccess(claimed.attempt.id, claimed.attempt.fencingToken,
      { outcome: "success", summary: "ok", artifacts: [], remainingRisks: [] }, [{
        sourceToolCallId: "h1", toMemberId: "b", reason: "next",
        input: { ...input, memberId: "b" },
      }], 110);
    const child = store.getChainTasks(parent.chainId).find((t) => t.id !== parent.id)!;
    const worker = createDurableWorker(store, { adapterFor: () => successfulAdapter });
    expect(worker.requestCancel(parent.id).affected).toBe(1);
    expect(store.getTask(child.id)?.status).toBe("cancelled");
    // A cancelled chain must not be resurrected by manual retry.
    expect(store.retryTask(child.id, 200)).toBe(false);
    expect(store.claimNext("w", 200)).toBeNull();
    expect(store.getTask(child.id)?.status).toBe("cancelled");
  });
});
