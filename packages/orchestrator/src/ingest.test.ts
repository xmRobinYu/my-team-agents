/**
 * P9a acceptance — Stories 1 and 2 (event in, repeats don't explode).
 *
 * Every test runs against a real in-memory SQLite pair and the real
 * `IngestService`; nothing here mocks the store. The router is an operator-written
 * string and the event body a producer object, which is exactly the boundary these
 * ACs are about.
 */

import { describe, expect, it } from "vitest";
import { ExecutionStore } from "./execution-store.js";
import { IngestStore } from "./ingest-store.js";
import { createIngestService } from "./ingest-service.js";

interface Harness {
  store: ExecutionStore;
  ingest: IngestStore;
  service: ReturnType<typeof createIngestService>;
  scope: { tenantId: string; projectId: string };
}

function harness(now?: () => number): Harness {
  const store = new ExecutionStore(":memory:");
  const ingest = new IngestStore(store.db);
  const scope = { tenantId: "t1", projectId: "p1" };
  // The roster: two members that "exist". AC1.3 is about a rule naming one that does
  // not, so the set is deliberately small and explicit.
  const members = new Set(["agent-pm", "agent-eng"]);
  const service = createIngestService({
    executions: store,
    ingest,
    memberExists: (id) => members.has(id),
    ...(now ? { now } : {}),
  });
  return { store, ingest, service, scope };
}

const ruleBody = (over: Record<string, unknown> = {}) => ({
  name: "线上告警",
  ask: "看这条告警，判断是否需要回滚。",
  lane: "alerts",
  when: { sources: ["aihot"], types: ["alert.now"] },
  to: { memberId: "agent-pm", workspacePath: "/tmp/ws" },
  ...over,
});

const eventBody = (over: Record<string, unknown> = {}) => ({
  id: "evt-1",
  source: "aihot",
  type: "alert.now",
  subject: "checkout-latency",
  summary: "结账接口 P99 超过 3s",
  detail: "过去 10 分钟 P99=4200ms",
  ...over,
});

describe("Story 1 — an event gets in", () => {
  it("AC1.1 writes the event and dispatches a Task; unknown fields survive in payload", () => {
    const h = harness();
    expect(h.service.registerRule(ruleBody()).ok).toBe(true);

    const result = h.service.submit(eventBody({ extra: { nested: true }, severity: "P1" }), h.scope);
    expect(result.status).toBe(200);
    expect(result.outcome).toBe("dispatched");
    expect(result.taskIds).toHaveLength(1);

    const stored = h.ingest.getEvent("evt-1")!;
    // G5: the producer's own fields are kept verbatim, including ones we never read.
    expect(stored.event.payload).toMatchObject({ extra: { nested: true }, severity: "P1" });

    const task = h.store.getTask(result.taskIds[0]!)!;
    expect(task.memberId).toBe("agent-pm");
    expect(task.lane).toBe("alerts");
    expect(task.eventId).toBe("evt-1");
    // AC5.1: instruction and data are two voices in one prompt, data fenced.
    expect(task.prompt).toContain("看这条告警");
    expect(task.prompt).toContain("# 事件（来自外部生产者的数据");
    expect(task.prompt).toContain("结账接口 P99 超过 3s");
  });

  it("AC1.2 an unmatched event is recorded, not thrown away", () => {
    const h = harness();
    h.service.registerRule(ruleBody());
    const result = h.service.submit(eventBody({ id: "evt-x", type: "feedback.new" }), h.scope);
    // A well-formed event with no rule is a 200 `unmatched`: recording it is the
    // point (G5), and a 4xx would tell the producer to stop sending it.
    expect(result.status).toBe(200);
    expect(result.outcome).toBe("unmatched");
    expect(result.taskIds).toHaveLength(0);
    const stored = h.ingest.getEvent("evt-x")!;
    expect(stored.outcome).toBe("unmatched");
    expect(stored.ruleIds).toEqual([]);
  });

  it("AC1.3 refuses a rule whose memberId does not exist — at registration", () => {
    const h = harness();
    const refused = h.service.registerRule(ruleBody({ to: { memberId: "寇豆码", workspacePath: "/tmp/ws" } }));
    expect(refused.ok).toBe(false);
    expect(refused.errors?.[0]?.code).toBe("UNKNOWN_MEMBER");
    // Nothing stored: a bad rule cannot exist to fail silently later.
    expect(h.ingest.listRules()).toHaveLength(0);
  });

  it("AC1.4 priority orders multiple matches, and ties break on name deterministically", () => {
    const h = harness();
    h.service.registerRule(ruleBody({ name: "B-rule", priority: 1 }));
    h.service.registerRule(ruleBody({ name: "A-rule", priority: 5 }));

    const result = h.service.submit(eventBody(), h.scope);
    expect(result.taskIds).toHaveLength(2);
    const names = result.ruleIds.map((id) => h.ingest.getRule(id)!.name);
    // priority 5 before priority 1.
    expect(names).toEqual(["A-rule", "B-rule"]);

    // Same priority -> name order, stable across runs.
    const h2 = harness();
    h2.service.registerRule(ruleBody({ name: "Z", priority: 0 }));
    h2.service.registerRule(ruleBody({ name: "A", priority: 0 }));
    const order = h2.service.submit(eventBody(), h2.scope).ruleIds.map((id) => h2.ingest.getRule(id)!.name);
    expect(order).toEqual(["A", "Z"]);
  });

  it("AC1.4 a rule that constrains neither source nor types is refused as unbounded", () => {
    const h = harness();
    const refused = h.service.registerRule(ruleBody({ when: {} }));
    expect(refused.ok).toBe(false);
    expect(refused.errors?.some((e) => e.code === "TOO_BROAD")).toBe(true);
  });
});

describe("Story 2 — repeats do not explode", () => {
  it("AC2.1/AC2.4 the same (source,id) N times yields ONE event and ONE Task, as 200", () => {
    const h = harness();
    h.service.registerRule(ruleBody());
    const first = h.service.submit(eventBody(), h.scope);
    const second = h.service.submit(eventBody(), h.scope);
    const third = h.service.submit({ ...eventBody(), summary: "结账接口 P99 超过 3s" }, h.scope);

    expect(first.outcome).toBe("dispatched");
    // AC2.4: `delivered`, status 200 — NOT 409. AIHOT only accepts 200, so a 409
    // makes the producer retry forever.
    expect([second.status, third.status]).toEqual([200, 200]);
    expect([second.outcome, third.outcome]).toEqual(["delivered", "delivered"]);
    expect(second.taskIds).toEqual(first.taskIds);
    expect(h.store.listTasks().filter((t) => t.eventId === "evt-1")).toHaveLength(1);
    expect(h.ingest.listEvents()).toHaveLength(1);
  });

  it("AC2.2/AC2.3 a live Task on the same (rule,lane,subject) coalesces, and the set is auditable", () => {
    const h = harness();
    h.service.registerRule(ruleBody());
    const first = h.service.submit(eventBody(), h.scope);
    const taskId = first.taskIds[0]!;

    // The Task is still queued (no worker ran), so it owns the lane.
    const second = h.service.submit(eventBody({ id: "evt-2", summary: "P99 仍在升高" }), h.scope);
    expect(second.outcome).toBe("coalesced");
    expect(second.coalescedInto).toBe(taskId);
    expect(second.taskIds).toEqual([taskId]);
    // No second Task.
    expect(h.store.listTasks()).toHaveLength(1);
    // AC2.3: the set of events MERGED IN is queryable from the original Task.
    // The origin is `task.eventId` (evt-1); `event_coalesce` holds what joined it,
    // so the two together give AC6.1 the full provenance without double-counting the
    // event that created the Task as if it had been coalesced.
    expect(h.ingest.coalescedEventIds(taskId)).toEqual(["evt-2"]);
    expect(h.store.getTask(taskId)!.eventId).toBe("evt-1");
  });

  it("AC2.2 an empty subject never coalesces: collapsing unrelated events would be a merge nobody asked for", () => {
    const h = harness();
    h.service.registerRule(ruleBody());
    h.service.submit(eventBody({ subject: "" }), h.scope);
    h.service.submit(eventBody({ id: "evt-2", subject: "" }), h.scope);
    expect(h.store.listTasks()).toHaveLength(2);
  });

  it("AC2.5 exceeding the rate window defers the EVENT, and a redrive later dispatches it", () => {
    let clock = 1_000_000;
    const h = harness(() => clock);
    const registered = h.service.registerRule(ruleBody({ rate: { max: 1, windowMs: 60_000 } }));
    expect(registered.ok).toBe(true);

    expect(h.service.submit(eventBody({ id: "a", subject: "s1" }), h.scope).outcome).toBe("dispatched");
    const deferred = h.service.submit(eventBody({ id: "b", subject: "s2" }), h.scope);
    // Deferred, NOT dropped: the row exists and says so.
    expect(deferred.outcome).toBe("deferred");
    expect(h.ingest.getEvent("b")!.outcome).toBe("deferred");
    expect(h.store.listTasks()).toHaveLength(1);

    // AC2.5 + AC6.1: the deferral carries the rule it was waiting on.
    expect(h.ingest.getEvent("b")!.ruleIds).toHaveLength(1);

    // Redrive inside the window: still rate-limited.
    expect(h.service.redriveDeferred(clock + 1)).toBe(0);
    expect(h.ingest.getEvent("b")!.outcome).toBe("deferred");

    // After the window, the redrive dispatches it.
    clock += 61_000;
    expect(h.service.redriveDeferred(clock)).toBe(1);
    expect(h.ingest.getEvent("b")!.outcome).toBe("dispatched");
    expect(h.store.listTasks()).toHaveLength(2);
  });
});

describe("P9e — the AIHOT producer shape", () => {
  /**
   * `ref/AIHOT/packages/backend/src/notify/agent.ts:70-78` builds the event as
   * `{ id, type, subject, summary, detail, link }` — there is NO `source` key on the
   * wire. These two tests pin both halves of that: the deployment must be able to
   * name the source, and a body that DOES name one must not be overwritten.
   */
  const harness = (defaultSource?: string) => {
    const executions = new ExecutionStore(":memory:");
    const ingest = new IngestStore(executions.db);
    const service = createIngestService({
      executions, ingest, memberExists: () => true,
      ...(defaultSource ? { defaultSource } : {}),
    });
    service.registerRule({
      name: "收录告警", ask: "查一下", lane: "aihot",
      when: { sources: [defaultSource ?? "aihot-prod"] },
      to: { memberId: "agent-pm", workspacePath: "/tmp/ws" },
    });
    return { executions, ingest, service };
  };

  it("a source-less AIHOT body is accepted when the deployment names one", () => {
    const h = harness("aihot-prod");
    const result = h.service.submit(
      { id: "content.collect:2026-11-11T00:00:00.000Z", type: "alert.now",
        subject: "content.collect", summary: "网站停止收录新文章", detail: "影响：读者看不到新文章",
        link: "https://aihot.example/admin/runs" },
      { tenantId: "t1", projectId: "p1" });
    expect(result.status).toBe(200);
    expect(result.outcome).toBe("dispatched");
    expect(result.event!.event.source).toBe("aihot-prod");
    // The producer's own fields survive verbatim (G5).
    expect(result.event!.event.link).toBe("https://aihot.example/admin/runs");
    expect(result.event!.event.subject).toBe("content.collect");
  });

  it("without a configured source the same body is a 400, not a silent guess", () => {
    const h = harness();
    const result = h.service.submit(
      { id: "x", type: "alert.now", subject: "s", summary: "t" },
      { tenantId: "t1", projectId: "p1" });
    expect(result.status).toBe(400);
    expect(result.errors?.[0]?.code).toBe("BODY_INVALID");
  });

  it("an explicit source on the body always beats the deployment default", () => {
    const h = harness("aihot-prod");
    const result = h.service.submit(
      { id: "x", source: "other-vendor", type: "alert.now", subject: "s", summary: "t" },
      { tenantId: "t1", projectId: "p1" });
    expect(result.outcome).toBe("unmatched");
    expect(result.event!.event.source).toBe("other-vendor");
  });

  it("three deliveries of one alert id make exactly one Task (AC2.1/AC2.4)", () => {
    const h = harness("aihot-prod");
    const body = { id: "balance.deepseek:2026-11-11T00:00:00.000Z", type: "alert.today",
      subject: "balance.deepseek", summary: "余额不足", detail: "充值" };
    const scope = { tenantId: "t1", projectId: "p1" };
    const first = h.service.submit(body, scope);
    const again = h.service.submit(body, scope);
    const third = h.service.submit(body, scope);
    expect(first.outcome).toBe("dispatched");
    expect(again.outcome).toBe("delivered");
    expect(third.outcome).toBe("delivered");
    expect(again.taskIds).toEqual(first.taskIds);
    expect(h.executions.listTasks()).toHaveLength(1);
  });
});
