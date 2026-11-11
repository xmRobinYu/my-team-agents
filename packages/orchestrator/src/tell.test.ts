/**
 * P9b — `tell` is consumed, and "定过的事不问第二遍" is falsifiable.
 *
 * The ledger is keyed by the notice's IDENTITY (rule, subject, kind), not by the
 * Task, so the interesting case is not "notify twice" but "notify twice about the
 * same thing through two different Tasks". That is what the second test does.
 */

import { describe, expect, it } from "vitest";
import { ExecutionStore } from "./execution-store.js";
import { IngestStore } from "./ingest-store.js";
import { createIngestService } from "./ingest-service.js";
import { createTellService, SILENT_CHANNEL, type TellCard } from "./tell.js";

interface Sent { card: TellCard }

const harness = (tell: "silent" | "needed", opts: { cooldownMs?: number } = {}) => {
  const executions = new ExecutionStore(":memory:");
  const ingest = new IngestStore(executions.db);
  const service = createIngestService({ executions, ingest, memberExists: () => true });
  const rule = service.registerRule({
    name: "告警值班", ask: "看告警", lane: "alerts", tell,
    when: { sources: ["s"] }, to: { memberId: "agent-pm", workspacePath: "/tmp/ws" },
  });
  // `RegisterRuleResult` is `{ ok, rule?, errors? }`, not a discriminated union, so
  // the rule has to be narrowed here rather than assumed.
  if (!rule.ok || !rule.rule) throw new Error(`rule registration failed: ${JSON.stringify(rule.errors)}`);
  const sent: Sent[] = [];
  const channel = {
    name: "test",
    async send(card: TellCard) { sent.push({ card }); },
  };
  let clock = 1_000;
  const tell2 = createTellService({
    executions, ingest, channel, cooldownMs: opts.cooldownMs ?? 600_000, now: () => clock,
  });
  return { executions, ingest, service, sent, tell: tell2, ruleId: rule.rule.id, advance: (ms: number) => { clock += ms; } };
};

/** Drive an event's Task into `blocked`, the state that means "a human must decide". */
function blockTask(executions: ExecutionStore, taskId: string) {
  const claim = executions.claimNext("w1", Date.now())!;
  executions.finishFailure(claim.attempt.id, claim.attempt.fencingToken, "预算超限", {
    kind: "budget_exceeded",
  });
  return executions.getTask(taskId)!.status;
}

describe("P9b tell", () => {
  it("a blocked Task with tell=needed reaches the channel once", async () => {
    const h = harness("needed");
    const submitted = h.service.submit({ id: "e1", source: "s", type: "t", subject: "db-1", summary: "x" },
      { tenantId: "t1", projectId: "p1" });
    expect(submitted.outcome).toBe("dispatched");
    expect(blockTask(h.executions, submitted.taskIds[0]!)).toBe("blocked");

    await h.tell.notify(submitted.taskIds[0]!);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.card).toMatchObject({
      kind: "blocked", ruleId: h.ruleId, ruleName: "告警值班", subject: "db-1",
    });
    expect(h.sent[0]!.card.title).toContain("需人工决策");
  });

  it("定过的事不问第二遍: a second Task for the same subject does not page again", async () => {
    const h = harness("needed");
    const first = h.service.submit({ id: "e1", source: "s", type: "t", subject: "db-1", summary: "x" },
      { tenantId: "t1", projectId: "p1" });
    blockTask(h.executions, first.taskIds[0]!);
    await h.tell.notify(first.taskIds[0]!);
    expect(h.sent).toHaveLength(1);

    // A DIFFERENT event, a DIFFERENT Task, the same object key.
    const second = h.service.submit({ id: "e2", source: "s", type: "t", subject: "db-1", summary: "y" },
      { tenantId: "t1", projectId: "p1" });
    blockTask(h.executions, second.taskIds[0]!);
    await h.tell.notify(second.taskIds[0]!);
    expect(h.sent).toHaveLength(1);
  });

  it("tell=silent sends nothing, and the ledger says nothing", async () => {
    const h = harness("silent");
    const submitted = h.service.submit({ id: "e1", source: "s", type: "t", subject: "db-1", summary: "x" },
      { tenantId: "t1", projectId: "p1" });
    blockTask(h.executions, submitted.taskIds[0]!);
    await h.tell.notify(submitted.taskIds[0]!);
    expect(h.sent).toHaveLength(0);
    expect(h.ingest.lastTellSentAt(h.ruleId)).toBeNull();
  });

  it("a second subject inside the cooldown is held back, then allowed", async () => {
    const h = harness("needed", { cooldownMs: 60_000 });
    const a = h.service.submit({ id: "e1", source: "s", type: "t", subject: "db-1", summary: "x" },
      { tenantId: "t1", projectId: "p1" });
    blockTask(h.executions, a.taskIds[0]!);
    await h.tell.notify(a.taskIds[0]!);
    expect(h.sent).toHaveLength(1);

    // Different subject => a different identity, so the ledger would allow it;
    // the cooldown is what stops it. Two mechanisms, two jobs.
    const b = h.service.submit({ id: "e2", source: "s", type: "t", subject: "db-2", summary: "y" },
      { tenantId: "t1", projectId: "p1" });
    blockTask(h.executions, b.taskIds[0]!);
    await h.tell.notify(b.taskIds[0]!);
    expect(h.sent).toHaveLength(1);

    h.advance(61_000);
    await h.tell.notify(b.taskIds[0]!);
    expect(h.sent).toHaveLength(2);
  });

  it("a rejected send is retryable; a delivered one never is", async () => {
    const h = harness("needed");
    const submitted = h.service.submit({ id: "e1", source: "s", type: "t", subject: "db-1", summary: "x" },
      { tenantId: "t1", projectId: "p1" });
    const taskId = submitted.taskIds[0]!;
    blockTask(h.executions, taskId);

    let fail = true;
    const flaky = {
      name: "flaky",
      async send(card: TellCard) {
        if (fail) throw new Error("webhook returned 500");
        h.sent.push({ card });
      },
    };
    const tell = createTellService({ executions: h.executions, ingest: h.ingest, channel: flaky });
    await tell.notify(taskId);
    expect(h.sent).toHaveLength(0);

    fail = false;
    await tell.notify(taskId);
    expect(h.sent).toHaveLength(1);

    // Now it is delivered: a third pass must be silent, forever.
    await tell.notify(taskId);
    expect(h.sent).toHaveLength(1);
  });

  it("a Task with no event is nobody's business", async () => {
    const h = harness("needed");
    const manual = h.executions.createTask({
      tenantId: "t1", projectId: "p1", memberId: "agent-pm", workspacePath: "/tmp/ws", prompt: "x",
    });
    blockTask(h.executions, manual.id);
    await h.tell.notify(manual.id);
    expect(h.sent).toHaveLength(0);
  });

  it("SILENT_CHANNEL is the default and never throws", async () => {
    await expect(SILENT_CHANNEL.send({
      kind: "failed", title: "t", ruleId: "r", ruleName: "n", taskId: "t1", memberId: "m",
      subject: "s", eventId: null, reason: "x", at: 0,
    })).resolves.toBeUndefined();
  });
});
