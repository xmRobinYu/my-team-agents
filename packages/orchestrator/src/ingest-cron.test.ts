/**
 * P9a acceptance — Story 4 (a schedule is an event) and Story 6 (traceability).
 *
 * AC4.3 is checked against the REAL reference packages under `ref/`, because the
 * whole point of the AC is that upstream's actual `cronTasks` shape stops being
 * dropped. A hand-written fixture would prove the mapper reads a shape I invented.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ExecutionStore } from "./execution-store.js";
import { IngestStore } from "./ingest-store.js";
import { createIngestService } from "./ingest-service.js";
import { parseCron, dueSlots, latestDueSlot, beijingParts, BEIJING_OFFSET_MS } from "./cron.js";
import { createScheduler } from "./scheduler.js";
import { planCronRules } from "./ingest-import.js";
import { importTemplatePackage, parseTemplatePackage } from "./template-import.js";
import { RoomStore } from "./room-store.js";

describe("Story 4 — cron is an event", () => {
  it("AC4.1 parses the reference expressions and refuses what it cannot read", () => {
    for (const good of ["0 */6 * * *", "0 18 * * 5", "0 17 28 * *", "*/15 * * * *", "0 0 1,15 * *"]) {
      expect(parseCron(good).ok, good).toBe(true);
    }
    for (const bad of ["* * * *", "0 0 * * * *", "60 * * * *", "0 24 * * *", "abc", "5/2 * * * *"]) {
      expect(parseCron(bad).ok, bad).toBe(false);
    }
  });

  it("AC4.1 dueSlots is pure clock arithmetic in Beijing time", () => {
    const parsed = parseCron("0 18 * * 5");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // 2026-11-13 is a Friday. A window covering that day in Beijing must contain
    // exactly the 18:00 Beijing slot.
    const start = Date.UTC(2026, 10, 12, 0, 0, 0);
    const end = Date.UTC(2026, 10, 14, 0, 0, 0);
    const slots = dueSlots(parsed.fields, start, end);
    expect(slots).toHaveLength(1);
    const parts = beijingParts(slots[0]!);
    expect([parts.hour, parts.minute, parts.dayOfWeek]).toEqual([18, 0, 5]);
    // Sanity: the offset really is +8h.
    expect(new Date(slots[0]! + BEIJING_OFFSET_MS).getUTCHours()).toBe(18);
  });

  it("AC4.2 a tick fires once per slot; a re-tick fires nothing", () => {
    const store = new ExecutionStore(":memory:");
    const ingest = new IngestStore(store.db);
    const scope = { tenantId: "t1", projectId: "p1" };
    const service = createIngestService({ executions: store, ingest, memberExists: () => true });
    service.registerRule({
      name: "每6小时", ask: "跑心跳", lane: "heartbeat",
      when: { sources: ["cron"] }, to: { memberId: "agent-pm", workspacePath: "/tmp/ws" },
      cron: { expression: "0 */6 * * *", type: "scheduled.tick" },
    });
    const scheduler = createScheduler({ ingest, service, scope });

    const t0 = Date.UTC(2026, 10, 12, 3, 0, 1);
    // First tick SEEDS the cursor (a brand-new rule must not replay history).
    expect(scheduler.tick(t0)).toBe(0);
    // No new slot yet.
    expect(scheduler.tick(t0 + 60_000)).toBe(0);

    // Cross the next 6-hour boundary (Beijing 12:00 = 04:00 UTC).
    const at = Date.UTC(2026, 10, 12, 4, 0, 30);
    expect(scheduler.tick(at)).toBe(1);
    expect(store.listTasks()).toHaveLength(1);
    // Same slot again: the cursor advanced, so nothing fires.
    expect(scheduler.tick(at + 30_000)).toBe(0);
    expect(store.listTasks()).toHaveLength(1);

    // AC4.2 idempotence survives even a LOST cursor: the event id is stable, so a
    // duplicate submit dedups at the delivery layer instead of making a 2nd Task.
    ingest.setCronState(ingest.listRules()[0]!.id, 0);
    expect(scheduler.tick(at)).toBe(1);
    expect(store.listTasks()).toHaveLength(1);
  });

  it("AC4.2 after downtime only the LATEST missed slot fires (missed: once)", () => {
    const parsed = parseCron("0 * * * *"); // hourly
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const from = Date.UTC(2026, 10, 12, 0, 0, 0);
    const to = Date.UTC(2026, 10, 12, 5, 30, 0);
    const slots = dueSlots(parsed.fields, from, to);
    expect(slots.length).toBe(5);
    // The scheduler's choice: the single most recent one.
    expect(latestDueSlot(parsed.fields, from, to)).toBe(slots[slots.length - 1]);
  });

  it("AC4.3 real template cronTasks become rules; un-convertible ones are refused by name", () => {
    const zips = [
      resolve("ref/teamagentx-templates/Git周月报-2026-06-03.zip"),
      resolve("ref/teamagentx-templates/AI自主性探索-2026-06-03.zip"),
    ].filter((p) => existsSync(p));
    if (zips.length === 0) return; // ref/ is git-ignored; CI may not have it

    let converted = 0;
    for (const zip of zips) {
      const parsed = parseTemplatePackage(zip);
      expect(parsed.cronTasks.length, zip).toBeGreaterThan(0);
      const plan = planCronRules(parsed.cronTasks, {
        workspacePath: "/tmp/ws",
        // Every template agent id maps to a fake member id: this test is about the
        // MAPPING, and the roster binding is covered by the import test below.
        memberIdForTemplateAgent: (id) => `agent-${id.slice(0, 6)}`,
        agentIdOf: (task) => (Array.isArray(task.agentIds) && typeof task.agentIds[0] === "string"
          ? task.agentIds[0] : null),
      });
      expect(plan.refused, zip).toEqual([]);
      for (const rule of plan.rules) {
        // The converted rule claims the cron source and carries the upstream payload
        // as its instruction.
        expect(rule.when).toMatchObject({ sources: ["cron"] });
        expect(String(rule.ask).length).toBeGreaterThan(0);
        expect(parseCron(String((rule.cron as { expression: string }).expression)).ok).toBe(true);
      }
      converted += plan.rules.length;
    }
    expect(converted).toBeGreaterThan(0);
  });

  it("AC4.3 a non-cron scheduleType is refused, never guessed into a calendar job", () => {
    const plan = planCronRules([
      { id: "t1", name: "一次性", scheduleType: "once", scheduledAt: "2026-01-01T00:00:00Z", payload: "x", agentIds: ["a"] },
      { id: "t2", name: "间隔", scheduleType: "interval", intervalMinutes: 30, payload: "y", agentIds: ["a"] },
      { id: "t3", name: "无指令", scheduleType: "cron", cronExpression: "0 1 * * *", payload: "", agentIds: ["a"] },
    ], {
      workspacePath: "/tmp/ws", memberIdForTemplateAgent: () => "agent-x", agentIdOf: (t) => (t.agentIds as string[])[0] ?? null,
    });
    expect(plan.rules).toHaveLength(0);
    expect(plan.refused).toHaveLength(3);
    expect(plan.refused.map((r) => r.name).sort()).toEqual(["一次性", "无指令", "间隔"]);
  });

  it("AC4.3 a real import registers rules and reports them in the ignored-field record", () => {
    const store = new RoomStore(":memory:");
    const zip = resolve("ref/teamagentx-templates/Git周月报-2026-06-03.zip");
    if (!existsSync(zip)) return;
    const registered: Record<string, unknown>[] = [];
    const result = importTemplatePackage({
      zip, store, projectId: "p1", now: Date.now(),
      registerCronRule: (input) => { registered.push(input); return null; },
    });
    expect(result.cronRuleInputs.length).toBeGreaterThan(0);
    expect(registered.length).toBe(result.cronRuleInputs.length);
    // AC4.3: the record now SAYS it was converted, not that it was discarded.
    const record = result.ignoredFields.find((f) => f.field === "cronTasks");
    expect(record?.reason).toContain("已转为触发规则");
    expect(record?.reason).not.toContain("丢弃");
  });
});

describe("Story 6 — traceability", () => {
  it("AC6.1/AC6.2 the event resolves to its rules, its Tasks, and each Task's usage", () => {
    const store = new ExecutionStore(":memory:");
    const ingest = new IngestStore(store.db);
    const service = createIngestService({ executions: store, ingest, memberExists: () => true });
    service.registerRule({
      name: "r", ask: "x", lane: "L1", when: { sources: ["s"] },
      to: { memberId: "agent-pm", workspacePath: "/tmp/ws" },
    });
    const result = service.submit({
      id: "e1", source: "s", type: "t", summary: "x", link: "https://example.com/incident/1",
    }, { tenantId: "t1", projectId: "p1" });

    const record = ingest.getEvent("e1")!;
    // AC6.2: the link survives verbatim, so the reader can jump back.
    expect(record.event.link).toBe("https://example.com/incident/1");
    expect(record.taskIds).toEqual(result.taskIds);
    expect(record.ruleIds).toHaveLength(1);
  });

  it("AC6.3 stats aggregate by source/type and count outcomes, including deferred", () => {
    let clock = 1_000_000;
    const store = new ExecutionStore(":memory:");
    const ingest = new IngestStore(store.db);
    const service = createIngestService({ executions: store, ingest, memberExists: () => true, now: () => clock });
    service.registerRule({
      name: "r", ask: "x", lane: "L1", when: { sources: ["s"] },
      to: { memberId: "agent-pm", workspacePath: "/tmp/ws" }, rate: { max: 1, windowMs: 60_000 },
    });
    service.submit({ id: "e1", source: "s", type: "t", subject: "a", summary: "x" }, { tenantId: "t1", projectId: "p1" });
    clock += 10;
    service.submit({ id: "e2", source: "s", type: "t", subject: "b", summary: "y" }, { tenantId: "t1", projectId: "p1" });
    clock += 10;
    service.submit({ id: "e3", source: "other", type: "z", summary: "z" }, { tenantId: "t1", projectId: "p1" });

    const stats = ingest.eventStats();
    const sBucket = stats.find((s) => s.source === "s")!;
    expect(sBucket.total).toBe(2);
    expect(sBucket.byOutcome["dispatched"]).toBe(1);
    expect(sBucket.byOutcome["deferred"]).toBe(1);
    const other = stats.find((s) => s.source === "other")!;
    expect(other.byOutcome["unmatched"]).toBe(1);
  });
});
