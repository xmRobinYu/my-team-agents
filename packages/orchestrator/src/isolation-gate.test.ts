/**
 * P9d — the two gates around writable tools, and why both exist.
 *
 * AC5.2 originally refused `bash`/`edit`/`write` outright, which was honest while
 * no sandbox existed. With one, the refusal must RELAX — but only on a
 * measurement, and it must still hold at execution time, where the fact lives.
 * Registration is a moment; a rule accepted then can outlive the daemon.
 */

import { describe, expect, it, vi } from "vitest";
import type { CanonicalEvent, RunHandle, RuntimeAdapter } from "@my-team-agents/runtime-core";
import { ExecutionStore, type TaskResult } from "./execution-store.js";
import { createDurableWorker } from "./durable-worker.js";
import { hasWritableTools, validateRuleInput, type TriggerRuleInput } from "./ingest.js";
import { createIngestService } from "./ingest-service.js";
import { IngestStore } from "./ingest-store.js";

/** A complete rule; `over` lets a test swap only the field under test. */
const ruleBody = (over: { tools?: string[] } = {}): TriggerRuleInput => ({
  name: "线上告警",
  ask: "看这条告警，判断是否需要回滚。",
  lane: "alerts",
  when: { sources: ["aihot"], types: ["alert.now"] },
  to: {
    memberId: "agent-eng",
    workspacePath: "/tmp/ws",
    ...(over.tools ? { tools: over.tools } : {}),
  },
});

const exists = () => true;

describe("P9d — the writable-tool predicate", () => {
  it("is the complement of the read-only set, in one place", () => {
    expect(hasWritableTools(["read", "grep", "handoff_to"])).toBe(false);
    expect(hasWritableTools(["read", "bash"])).toBe(true);
    expect(hasWritableTools([])).toBe(false);
  });
});

describe("P9d — registration relaxes only on a measured backend", () => {
  it("refuses writable tools when the caller supplies no gate", () => {
    // Absent must mean "refused": forgetting an argument cannot widen access.
    const out = validateRuleInput(
      ruleBody({ tools: ["read", "bash"] }),
      exists,
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors.map((e) => e.code)).toContain("WRITABLE_TOOLS_REFUSED");
  });

  it("carries the measured reason into the refusal", () => {
    const out = validateRuleInput(
      ruleBody({ tools: ["bash"] }),
      exists,
      undefined,
      { allowed: false, reason: "docker daemon 不可达：socket 不存在" },
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors[0]?.message).toContain("docker daemon 不可达");
  });

  it("accepts writable tools when isolation is measured to be working", () => {
    const out = validateRuleInput(
      ruleBody({ tools: ["read", "bash", "edit"] }),
      exists,
      undefined,
      { allowed: true },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Accepted, and carried: "read-only" must remain a property of the RUN, so a
    // writable rule's allowlist is stored verbatim rather than dropped.
    expect(out.value.to.tools).toEqual(["read", "bash", "edit"]);
  });

  it("service wires the gate through, and its absence still refuses", () => {
    const store = new ExecutionStore(":memory:");
    const ingest = new IngestStore(store.db);
    const open = createIngestService({
      executions: store, ingest, memberExists: () => true,
      writableTools: () => ({ allowed: true }),
    });
    expect(open.registerRule(ruleBody({ tools: ["bash"] })).ok).toBe(true);

    const closed = createIngestService({ executions: store, ingest, memberExists: () => true });
    expect(closed.registerRule(ruleBody({ tools: ["bash"] })).ok).toBe(false);
    store.close();
  });
});

const result: TaskResult = { outcome: "success", summary: "done", artifacts: [], remainingRisks: [] };
const event = (attemptId: string): CanonicalEvent => ({
  type: "message_end", runId: attemptId, timestamp: new Date(0).toISOString(), text: JSON.stringify(result),
});

/** Records whether anything was spawned at all — the assertion that matters. */
const adapter = (sandbox: "none" | "workspace-write"): RuntimeAdapter & { starts: number } => {
  const self = {
    starts: 0,
    kind: "pi" as const,
    capabilities: {
      streaming: true, steer: true, cancel: true, approval: "none" as const, sandbox,
      workspacePerRun: true, agentDirPerRun: false, usageAttribution: "message" as const,
      costCap: false, sessionResume: false,
    },
    async start(spec: { runId: string }): Promise<RunHandle> {
      self.starts += 1;
      return {
        runId: spec.runId,
        events: (async function* () { yield event(spec.runId); })(),
        settled: Promise.resolve({ runId: spec.runId, status: "completed" as const }),
        async cancel() {},
      };
    },
  };
  return self;
};

const input = {
  tenantId: "t1", projectId: "p1", memberId: "agent-eng", workspacePath: "/tmp/ws", prompt: "改代码",
};

describe("P9d — execution enforces 'writable implies isolated'", () => {
  it("blocks a writable Task on a runtime that reports sandbox=none, without spawning", async () => {
    const store = new ExecutionStore(":memory:");
    const runtime = adapter("none");
    const worker = createDurableWorker(store, { adapterFor: () => runtime });
    const task = store.createTask({ ...input, tools: ["read", "bash", "edit"] }, 100);

    await worker.runOnce();

    const after = store.getTask(task.id)!;
    // BLOCKED, not failed: retrying cannot conjure a sandbox, and blaming the agent
    // for a missing daemon would burn the Task and mislabel the cause.
    expect(after.status).toBe("blocked");
    expect(after.error).toContain("隔离");
    expect(store.getAttempts(task.id)[0]?.errorKind).toBe("isolation_unavailable");
    expect(runtime.starts).toBe(0);
    store.close();
  });

  it("runs the same Task when the runtime really is isolated", async () => {
    const store = new ExecutionStore(":memory:");
    const runtime = adapter("workspace-write");
    const worker = createDurableWorker(store, { adapterFor: () => runtime });
    const task = store.createTask({ ...input, tools: ["read", "bash"] }, 100);

    await worker.runOnce();

    expect(store.getTask(task.id)?.status).toBe("succeeded");
    expect(runtime.starts).toBe(1);
    store.close();
  });

  it("leaves read-only Tasks alone", async () => {
    const store = new ExecutionStore(":memory:");
    const runtime = adapter("none");
    const worker = createDurableWorker(store, { adapterFor: () => runtime });
    const task = store.createTask({ ...input, tools: ["read", "grep"] }, 100);

    await worker.runOnce();

    expect(store.getTask(task.id)?.status).toBe("succeeded");
    expect(runtime.starts).toBe(1);
    store.close();
  });
});
