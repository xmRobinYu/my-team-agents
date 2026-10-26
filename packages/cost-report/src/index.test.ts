import { describe, expect, it } from "vitest";
import { parseSessionJsonl } from "./parse.js";
import { aggregate, nextCursor, renderReport, totals } from "./aggregate.js";

const FIXTURE = `
{"type":"session","version":3,"id":"sess-1","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/tmp/proj"}
{"type":"message","id":"e1","timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"hi"}}
{"type":"message","id":"e2","timestamp":"2024-12-03T14:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]},"usage":{"input":100,"output":10,"cacheRead":0,"cacheWrite":0,"totalTokens":110,"cost":{"input":0.001,"output":0.002,"cacheRead":0,"cacheWrite":0,"total":0.003}},"provider":"anthropic","model":"claude-sonnet-4-5"}
not-json-line
{"type":"usage","id":"e3","timestamp":"2024-12-03T14:00:03.000Z","kind":"cache_warm","usage":{"input":0,"output":0,"cacheRead":500,"cacheWrite":200,"totalTokens":700,"cost":{"input":0,"output":0,"cacheRead":0.0005,"cacheWrite":0.0004,"total":0.0009}}}
{"type":"message","id":"e4","timestamp":"2024-12-03T14:00:04.000Z","message":{"role":"assistant","content":[{"type":"text","text":"again"}]},"usage":{"input":50,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":55,"cost":{"input":0.0005,"output":0.001,"cacheRead":0,"cacheWrite":0,"total":0.0015}},"provider":"anthropic","model":"claude-sonnet-4-5"}
{"type":"message","id":"e5","timestamp":"2024-12-03T14:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"other model"}]},"usage":{"input":20,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":22,"cost":{"input":0.0001,"output":0.0002,"cacheRead":0,"cacheWrite":0,"total":0.0003}},"provider":"openai","model":"gpt-5"}
`;

const ATTRIBUTION = { tenant: "t1", project: "p1", member: "m1" };

describe("parseSessionJsonl", () => {
  it("collects assistant messages and standalone usage entries only", () => {
    const { records } = parseSessionJsonl(FIXTURE, "s.jsonl");
    expect(records.map((r) => r.entryId)).toEqual(["e2", "e3", "e4", "e5"]);
    expect(records[0]!.kind).toBe("assistant");
    expect(records[1]!.kind).toBe("usage");
    expect(records[1]!.usageKind).toBe("cache_warm");
  });

  it("records an issue for invalid JSON without aborting", () => {
    const { records, issues } = parseSessionJsonl(FIXTURE, "s.jsonl");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.line).toBe(5);
    expect(records).toHaveLength(4);
  });

  it("respects the since cursor (exclusive) for incremental daily runs", () => {
    const { records } = parseSessionJsonl(FIXTURE, "s.jsonl", { since: "e2" });
    expect(records.map((r) => r.entryId)).toEqual(["e3", "e4", "e5"]);
  });

  it("tolerates a usage entry with an unknown kind", () => {
    const { records } = parseSessionJsonl(
      '{"type":"usage","id":"u1","timestamp":"t","kind":"brand_new_kind","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}',
      "s.jsonl",
    );
    expect(records[0]!.usageKind).toBe("brand_new_kind");
  });
});

describe("aggregate", () => {
  it("groups by provider+model and sorts by cost descending", () => {
    const { records } = parseSessionJsonl(FIXTURE, "s.jsonl");
    const rows = aggregate(records, ATTRIBUTION);
    expect(rows).toHaveLength(3); // claude-sonnet-4-5, unknown (cache_warm), gpt-5
    const top = rows[0]!;
    expect(top.model).toBe("claude-sonnet-4-5");
    expect(top.calls).toBe(2);
    expect(top.totalTokens).toBe(165);
    expect(top.totalCost).toBeCloseTo(0.0045, 6);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1]!.totalCost).toBeGreaterThanOrEqual(rows[i]!.totalCost);
    }
  });

  it("carries attribution keys through every row", () => {
    const { records } = parseSessionJsonl(FIXTURE, "s.jsonl");
    for (const row of aggregate(records, ATTRIBUTION)) {
      expect(row.tenant).toBe("t1");
      expect(row.project).toBe("p1");
      expect(row.member).toBe("m1");
    }
  });
});

describe("report", () => {
  it("renders totals and a per-model table", () => {
    const { records } = parseSessionJsonl(FIXTURE, "s.jsonl");
    const rows = aggregate(records, ATTRIBUTION);
    const report = renderReport(rows);
    expect(report).toContain("totalTokens");
    expect(report).toContain("totalCost");
    expect(report).toContain("claude-sonnet-4-5");
    expect(totals(rows).totalTokens).toBe(887);
  });

  it("renders an empty report without crashing", () => {
    expect(renderReport([])).toContain("no usage records");
    expect(totals([])).toEqual({ calls: 0, totalTokens: 0, totalCost: 0 });
  });

  it("advances the cursor to the last record, preserving it when empty", () => {
    const { records } = parseSessionJsonl(FIXTURE, "s.jsonl");
    expect(nextCursor(records)).toBe("e5");
    expect(nextCursor([], "e5")).toBe("e5");
  });
});
