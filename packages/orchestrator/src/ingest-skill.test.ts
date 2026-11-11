/**
 * P9b — `skill` stops being a declared-but-inert field.
 *
 * Two halves, and the second is the one that was missing all along:
 *   1. registration refuses a skill the target persona cannot load, so a rule can
 *      never promise a capability that does not exist (AC1.3's rule, applied to
 *      skills);
 *   2. dispatch resolves the persona's `agentDir`, because Pi only receives
 *      `--skill <dir>` for a run that HAS a persona dir. Until now an event Task
 *      carried none, so even a valid skill could not reach the run.
 */

import { describe, expect, it } from "vitest";
import { ExecutionStore } from "./execution-store.js";
import { IngestStore } from "./ingest-store.js";
import { createIngestService } from "./ingest-service.js";
import { MAX_PARALLEL, type TargetPersona } from "./ingest.js";

const PERSONA_DIR = "/tmp/mta-persona";
const persona = (over: Partial<TargetPersona> = {}): TargetPersona => ({
  agentDir: PERSONA_DIR, model: "airouter/deepseek-v4.1-flash",
  loadableSkills: ["incident-review"], ...over,
});

const harness = (
  opts: { persona?: (id: string) => TargetPersona | null } = {},
) => {
  const executions = new ExecutionStore(":memory:");
  const ingest = new IngestStore(executions.db);
  const service = createIngestService({
    executions, ingest, memberExists: () => true, ...opts,
  });
  return { executions, ingest, service };
};

const ruleBody = (over: Record<string, unknown> = {}) => ({
  name: "r", ask: "查一下", lane: "L1", when: { sources: ["s"] },
  to: { memberId: "agent-pm", workspacePath: "/tmp/ws" }, ...over,
});

describe("P9b skill declaration", () => {
  it("a skill the persona does not hold is refused AT REGISTRATION", () => {
    const h = harness({ persona: () => persona() });
    const res = h.service.registerRule(ruleBody({ skill: "not-installed" }));
    expect(res.ok).toBe(false);
    expect(res.errors?.map((e) => e.code)).toContain("SKILL_NOT_AVAILABLE");
    // Nothing stored: a refused rule must not exist at all.
    expect(h.ingest.listRules()).toHaveLength(0);
  });

  it("the refusal names what IS available, so the operator can fix it in one go", () => {
    const h = harness({ persona: () => persona({ loadableSkills: ["incident-review", "weekly-report"] }) });
    const res = h.service.registerRule(ruleBody({ skill: "nope" }));
    const message = res.errors?.[0]?.message ?? "";
    expect(message).toContain("incident-review");
    expect(message).toContain("weekly-report");
  });

  it("an illegal slug is refused before the roster is ever consulted", () => {
    const h = harness({ persona: () => persona({ loadableSkills: ["Bad Name"] }) });
    const res = h.service.registerRule(ruleBody({ skill: "Bad Name" }));
    expect(res.errors?.map((e) => e.code)).toContain("INVALID_SLUG");
  });

  it("a held skill registers, and the run is told to use it", () => {
    const h = harness({ persona: () => persona() });
    const res = h.service.registerRule(ruleBody({ skill: "incident-review" }));
    expect(res.ok).toBe(true);
    expect(res.rule?.skill).toBe("incident-review");

    const submitted = h.service.submit({ id: "e1", source: "s", type: "t", subject: "x", summary: "y" },
      { tenantId: "t1", projectId: "p1" });
    const task = h.executions.getTask(submitted.taskIds[0]!)!;
    // The instruction is operator-authored, so it sits with `ask` — and the fenced
    // data block is still the only place external text goes.
    expect(task.prompt).toContain("本次任务要求使用技能 `incident-review`");
    expect(task.prompt.indexOf("incident-review")).toBeLessThan(task.prompt.indexOf("# 事件"));
  });

  it("a skill with no roster to check is accepted but reported as unverified", () => {
    const h = harness();
    const res = h.service.registerRule(ruleBody({ skill: "incident-review" }));
    expect(res.ok).toBe(true);
    expect(res.warnings?.[0]).toContain("未对照名册校验");
  });

  it("a persona-less caller changes nothing about the Task (P6 spine intact)", () => {
    const h = harness();
    h.service.registerRule(ruleBody());
    const submitted = h.service.submit({ id: "e1", source: "s", type: "t", summary: "y" },
      { tenantId: "t1", projectId: "p1" });
    const task = h.executions.getTask(submitted.taskIds[0]!)!;
    expect(task.agentDir).toBeUndefined();
    expect(task.model).toBeUndefined();
  });

  it("dispatch carries the resolved agentDir and model to the Task", () => {
    const h = harness({ persona: () => persona() });
    h.service.registerRule(ruleBody());
    const submitted = h.service.submit({ id: "e1", source: "s", type: "t", summary: "y" },
      { tenantId: "t1", projectId: "p1" });
    const task = h.executions.getTask(submitted.taskIds[0]!)!;
    // This is the link that makes `--skill` reachable: PiAdapter derives the skill
    // dirs from `spec.agentDir` (runtime-pi/src/skills.ts), and I9 proved that
    // argv. Without agentDir on the row, a declared skill can never load.
    expect(task.agentDir).toBe(PERSONA_DIR);
    expect(task.model).toBe("airouter/deepseek-v4.1-flash");
  });

  it("a target with no persona row still dispatches, without a persona dir", () => {
    const h = harness({ persona: () => null });
    h.service.registerRule(ruleBody());
    const submitted = h.service.submit({ id: "e1", source: "s", type: "t", summary: "y" },
      { tenantId: "t1", projectId: "p1" });
    expect(submitted.outcome).toBe("dispatched");
    expect(h.executions.getTask(submitted.taskIds[0]!)!.agentDir).toBeUndefined();
  });

  it("the persona is read per dispatch, so installing a skill needs no re-registration", () => {
    let held: string[] = [];
    const h = harness({ persona: () => persona({ loadableSkills: held }) });
    const before = h.service.registerRule(ruleBody({ skill: "incident-review" }));
    expect(before.ok).toBe(false);

    held = ["incident-review"];
    const after = h.service.registerRule(ruleBody({ skill: "incident-review" }));
    expect(after.ok).toBe(true);
  });
});

describe("P9c rule parallel is honoured", () => {
  const withRules = (parallel: number) => {
    const h = harness({ persona: () => persona() });
    const res = h.service.registerRule(ruleBody({ lane: "fan", parallel }));
    return { h, res };
  };

  it("parallel=3 stores 3 and every dispatched Task inherits it", () => {
    const { h, res } = withRules(3);
    expect(res.ok).toBe(true);
    expect(res.rule?.parallel).toBe(3);
    const submitted = h.service.submit({ id: "e1", source: "s", type: "t", summary: "y" },
      { tenantId: "t1", projectId: "p1" });
    expect(h.executions.getTask(submitted.taskIds[0]!)!.parallel).toBe(3);
  });

  it("above MAX_PARALLEL it is refused, not silently capped", () => {
    const { res } = withRules(MAX_PARALLEL + 1);
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.field).toBe("parallel");
  });

  it("the old refusal is gone: parallel=1 still registers", () => {
    expect(withRules(1).res.ok).toBe(true);
  });
});
