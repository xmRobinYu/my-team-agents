import { describe, expect, it, vi } from "vitest";
import { dispatch, type DispatcherDeps } from "./dispatcher.js";
import { HANDOFF_TOOL_NAME } from "./handoff-intent.js";
import type { CanonicalEvent, RuntimeAdapter, RuntimeCapabilities, RunHandle, RunSpec } from "@my-team-agents/runtime-core";
import { DEFAULT_GUARDRAILS } from "@my-team-agents/domain";

const CAPS: RuntimeCapabilities = {
  streaming: true,
  steer: true,
  cancel: true,
  approval: "none",
  sandbox: "none",
  workspacePerRun: true,
  agentDirPerRun: false,
  usageAttribution: "message",
  costCap: false,
};

/** Fake adapter: yields the given events then settles with the given status. */
function fakeAdapter(
  events: CanonicalEvent[],
  status: "completed" | "aborted" | "failed" = "completed",
  onStart?: (spec: RunSpec) => void,
): RuntimeAdapter {
  return {
    kind: "pi",
    capabilities: CAPS,
    async start(spec: RunSpec): Promise<RunHandle> {
      onStart?.(spec);
      return {
        runId: spec.runId,
        events: {
          [Symbol.asyncIterator]: () => {
            let i = 0;
            return {
              async next(): Promise<IteratorResult<CanonicalEvent>> {
                const next = events[i];
                if (next === undefined) return { value: undefined, done: true };
                i += 1;
                return { value: next, done: false };
              },
            };
          },
        },
        cancel: async () => {},
        settled: Promise.resolve({ runId: spec.runId, status }),
      };
    },
  };
}

const handoffEvent = (to: string[], reason = "because"): CanonicalEvent => ({
  type: "tool_execution_start",
  runId: "r",
  timestamp: new Date().toISOString(),
  toolName: HANDOFF_TOOL_NAME,
  args: { toMemberIds: to, reason },
});

const baseReq = {
  tenantId: "t1",
  projectId: "p1",
  memberId: "alice",
  workspacePath: "/tmp/proj",
  prompt: "go",
};

const deps = (adapter: RuntimeAdapter): DispatcherDeps => ({ adapterFor: () => adapter });

describe("dispatch", () => {
  it("runs the task and reports completion with no handoffs", async () => {
    const out = await dispatch(baseReq, deps(fakeAdapter([])));
    expect(out.status).toBe("completed");
    expect(out.dispatched).toHaveLength(0);
    expect(out.rejected).toHaveLength(0);
  });

  it("dispatches a declared handoff and increments depth", async () => {
    const out = await dispatch(baseReq, deps(fakeAdapter([handoffEvent(["bob"])])));
    expect(out.dispatched).toEqual([{ toMemberIds: ["bob"], depth: 1 }]);
  });

  it("passes attribution and workspace through to the runtime", async () => {
    const seen: RunSpec[] = [];
    await dispatch(baseReq, deps(fakeAdapter([], "completed", (s) => seen.push(s))));
    expect(seen[0]!.tenantId).toBe("t1");
    expect(seen[0]!.projectId).toBe("p1");
    expect(seen[0]!.memberId).toBe("alice");
    expect(seen[0]!.workspacePath).toBe("/tmp/proj");
  });

  it("streams events to the observer", async () => {
    const onEvent = vi.fn();
    const events = [{ type: "message_update", runId: "r", timestamp: "t", text: "hi" } as CanonicalEvent];
    await dispatch(baseReq, { adapterFor: () => fakeAdapter(events), onEvent });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  // Invariant #1: dispatch happens after settle, never mid-stream.
  it("does NOT dispatch when the run failed", async () => {
    const out = await dispatch(baseReq, deps(fakeAdapter([handoffEvent(["bob"])], "failed")));
    expect(out.status).toBe("failed");
    expect(out.dispatched).toHaveLength(0);
    expect(out.rejected[0]!.reason).toContain("did not complete");
  });

  it("does NOT dispatch when the run was aborted", async () => {
    const out = await dispatch(baseReq, deps(fakeAdapter([handoffEvent(["bob"])], "aborted")));
    expect(out.dispatched).toHaveLength(0);
    expect(out.status).toBe("aborted");
  });

  // Invariant #2: guardrails hold even if the model asks for something absurd.
  it("rejects a fanout beyond the limit", async () => {
    const many = Array.from({ length: DEFAULT_GUARDRAILS.fanoutMax + 5 }, (_, i) => `m${i}`);
    const out = await dispatch(baseReq, deps(fakeAdapter([handoffEvent(many)])));
    expect(out.dispatched).toHaveLength(0);
    expect(out.rejected[0]!.reason).toContain("fanout");
  });

  it("rejects at max depth", async () => {
    const out = await dispatch(
      { ...baseReq, depth: DEFAULT_GUARDRAILS.depthMax },
      deps(fakeAdapter([handoffEvent(["bob"])])),
    );
    expect(out.dispatched).toHaveLength(0);
  });

  it("rejects when the chain budget is exhausted", async () => {
    const out = await dispatch(
      baseReq,
      deps(fakeAdapter([handoffEvent(["bob"])])),
      { budgetUsed: DEFAULT_GUARDRAILS.budgetMax, visitCounts: {} },
    );
    expect(out.dispatched).toHaveLength(0);
  });

  it("stops ping-pong by rejecting a member at the revisit limit", async () => {
    const out = await dispatch(
      baseReq,
      deps(fakeAdapter([handoffEvent(["bob"])])),
      { budgetUsed: 0, visitCounts: { bob: DEFAULT_GUARDRAILS.revisitMax } },
    );
    expect(out.dispatched).toHaveLength(0);
    expect(out.rejected[0]!.reason).toContain("revisit");
  });

  it("honours injected guardrails", async () => {
    const out = await dispatch(baseReq, {
      adapterFor: () => fakeAdapter([handoffEvent(["bob", "carol"])]),
      guardrails: { ...DEFAULT_GUARDRAILS, fanoutMax: 1 },
    });
    expect(out.dispatched).toHaveLength(0);
  });

  it("surfaces malformed handoff args as issues without crashing", async () => {
    const bad: CanonicalEvent = {
      type: "tool_execution_start",
      runId: "r",
      timestamp: "t",
      toolName: HANDOFF_TOOL_NAME,
      args: { toMemberIds: "not-an-array" },
    };
    const out = await dispatch(baseReq, deps(fakeAdapter([bad])));
    expect(out.issues.length).toBeGreaterThan(0);
    expect(out.dispatched).toHaveLength(0);
  });

  it("reports a thrown runtime as failed, not as a crash", async () => {
    const throwing: RuntimeAdapter = {
      kind: "pi",
      capabilities: CAPS,
      async start(): Promise<RunHandle> {
        throw new Error("spawn ENOENT");
      },
    };
    const out = await dispatch(baseReq, deps(throwing));
    expect(out.status).toBe("failed");
    expect(out.issues.join()).toContain("spawn ENOENT");
  });

  it("uses the injected run id factory", async () => {
    const out = await dispatch(baseReq, {
      adapterFor: () => fakeAdapter([]),
      runIdFactory: () => "fixed-run",
    });
    expect(out.runId).toBe("fixed-run");
  });
});
