import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CanonicalEvent, RunHandle, RuntimeAdapter } from "@my-team-agents/runtime-core";
import { ExecutionStore } from "./execution-store.js";
import { createDurableWorker } from "./durable-worker.js";

/**
 * I3 AC3 — one room never runs two agents at once.
 *
 * The serialisation lives in `ExecutionStore.claimNext`, so it is falsified by
 * the multi-process shape: two Worker instances over the same SQLite file. With a
 * single Worker the queue would look serial purely by accident, which is exactly
 * the false positive this test exists to rule out.
 *
 * The tracker counts one room's members only. A task WITHOUT a groupId and a task
 * in another room are queued as well: if the key were over-broad (e.g. global)
 * those would serialise too and the peak would still read 1, so the second
 * assertion pins the scope — cross-room work genuinely does run together.
 */

const ROOM = new Set(["arch", "qa", "pm"]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const success = JSON.stringify({ outcome: "success", summary: "ok", artifacts: [], remainingRisks: [] });

interface Harness {
  readonly adapter: RuntimeAdapter;
  readonly peak: number;
  readonly running: number;
  readonly started: string[];
}

const harness = (): Harness => {
  let running = 0;
  let peak = 0;
  const started: string[] = [];
  const adapter: RuntimeAdapter = {
    kind: "pi",
    capabilities: {
      streaming: true, steer: false, cancel: true, approval: "none", sandbox: "none",
      workspacePerRun: true, agentDirPerRun: false, usageAttribution: "message", costCap: false, sessionResume: false,
    },
    async start(spec): Promise<RunHandle> {
      started.push(spec.memberId);
      const tracked = ROOM.has(spec.memberId);
      if (tracked) {
        running += 1;
        peak = Math.max(peak, running);
      }
      const event: CanonicalEvent = { type: "message_end", runId: spec.runId, timestamp: "", text: success };
      return {
        runId: spec.runId,
        events: (async function* () {
          try {
            await sleep(20);
            yield event;
          } finally { if (tracked) running -= 1; }
        })(),
        settled: Promise.resolve({ runId: spec.runId, status: "completed" }),
        async cancel() { if (tracked) running -= 1; },
      };
    },
  };
  return {
    adapter,
    get peak() { return peak; },
    get running() { return running; },
    started,
  };
};

/** Runs every Worker until none can claim anything. */
const drain = async (...workers: Array<ReturnType<typeof createDurableWorker>>) => {
  for (;;) {
    const touched = await Promise.all(workers.map((worker) => worker.runOnce()));
    if (!touched.some(Boolean)) return;
  }
};

const input = (memberId: string, groupId?: string) => ({
  tenantId: "t", projectId: "p", memberId,
  workspacePath: "/workspace/project", prompt: `work for ${memberId}`,
  ...(groupId ? { groupId } : {}),
});

describe("same-group serialisation (I3 AC3)", () => {
  it("keeps one room's peak concurrency at 1 across two Workers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mta-group-"));
    const file = join(dir, "queue.sqlite");
    // Two connections, one file: the same shape as API process + Worker process.
    const storeA = new ExecutionStore(file);
    const storeB = new ExecutionStore(file);
    const seen = harness();

    storeA.createTask(input("arch", "room-1"), 100);
    storeA.createTask(input("qa", "room-1"), 101);
    storeA.createTask(input("pm", "room-1"), 102);
    storeA.createTask(input("other", "room-2"), 103);

    const workers = [storeA, storeB].map((store, index) =>
      createDurableWorker(store, { workerId: `w${index + 1}`, adapterFor: () => seen.adapter }));
    await drain(...workers);

    expect(seen.peak, "同群并发峰值").toBe(1);
    expect(seen.running).toBe(0);
    // room-1 ran serially, in creation order.
    expect(seen.started.filter((m) => ROOM.has(m))).toEqual(["arch", "qa", "pm"]);
    // room-2 is not blocked by room-1, so the key is scoped per room.
    expect(seen.started).toContain("other");
    expect(storeA.listTasks().filter((task) => task.status === "succeeded")).toHaveLength(4);
    storeA.close();
    storeB.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
