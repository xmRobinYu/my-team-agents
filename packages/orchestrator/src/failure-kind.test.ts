/**
 * P9c — a failure carries a countable reason, and two reasons are not failures.
 *
 * The load-bearing assertion is the second block: a budget stop must land in
 * `blocked`, not `retry_wait`/`failed`. A retry would spend the budget again and
 * then call the result "failed", which blames the agent for an operator ceiling.
 */

import { describe, expect, it } from "vitest";
import { ExecutionStore } from "./execution-store.js";
import { classifyRuntimeError, requiresHuman } from "./failure-kind.js";

describe("P9c failure classification", () => {
  it("classifies the adapter strings we do not author, narrowly", () => {
    expect(classifyRuntimeError("spawn pi ENOENT")).toBe("runtime_unavailable");
    expect(classifyRuntimeError("command not found: pi")).toBe("runtime_unavailable");
    expect(classifyRuntimeError("EACCES: permission denied")).toBe("runtime_unavailable");
    expect(classifyRuntimeError("no events for 120000ms")).toBe("idle_timeout");
    expect(classifyRuntimeError("timed out waiting for provider")).toBe("idle_timeout");
    expect(classifyRuntimeError("provider returned 500")).toBe("runtime_error");
    // An unrecognised message never becomes a guess at a specific cause.
    expect(classifyRuntimeError("")).toBe("runtime_error");
  });

  it("marks only the human-decision kinds as non-retryable", () => {
    expect(requiresHuman("budget_exceeded")).toBe(true);
    expect(requiresHuman("unresolved_tools")).toBe(true);
    expect(requiresHuman("idle_timeout")).toBe(false);
    expect(requiresHuman("runtime_error")).toBe(false);
  });

  it("a budget stop is BLOCKED and its kind survives on the Attempt", () => {
    const store = new ExecutionStore(":memory:");
    const task = store.createTask({ tenantId: "t", projectId: "p", memberId: "m", workspacePath: "/tmp/ws", prompt: "x" });
    const claim = store.claimNext("w1", Date.now())!;
    expect(claim.task.id).toBe(task.id);

    const status = store.finishFailure(claim.attempt.id, claim.attempt.fencingToken, "预算超限", {
      kind: "budget_exceeded", now: Date.now(),
    });
    // Not `retry_wait`: the meter is already spent.
    expect(status).toBe("blocked");
    expect(store.getTask(task.id)!.status).toBe("blocked");
    expect(store.getAttempt(claim.attempt.id)!.errorKind).toBe("budget_exceeded");
    store.close();
  });

  it("a retryable kind still re-arms the Task", () => {
    const store = new ExecutionStore(":memory:");
    const task = store.createTask({ tenantId: "t", projectId: "p", memberId: "m", workspacePath: "/tmp/ws", prompt: "x" });
    const claim = store.claimNext("w1", Date.now())!;
    const status = store.finishFailure(claim.attempt.id, claim.attempt.fencingToken, "wedged", {
      kind: "idle_timeout", now: Date.now(),
    });
    expect(status).toBe("retry_wait");
    expect(store.getAttempt(claim.attempt.id)!.errorKind).toBe("idle_timeout");
    store.close();
  });
});
