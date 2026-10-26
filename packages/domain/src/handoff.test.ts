import { describe, expect, it } from "vitest";
import { DEFAULT_GUARDRAILS, evaluateHandoff } from "./handoff.js";

const ctx = (over: Partial<Parameters<typeof evaluateHandoff>[0]> = {}) => ({
  depth: 0,
  budgetUsed: 0,
  visitCounts: {},
  ...over,
});

describe("evaluateHandoff", () => {
  it("allows a normal handoff", () => {
    expect(evaluateHandoff(ctx(), ["m2"]).allowed).toBe(true);
  });

  it("rejects empty targets", () => {
    expect(evaluateHandoff(ctx(), [])).toMatchObject({ allowed: false, reason: "no targets" });
  });

  it("rejects fanout above the limit", () => {
    const targets = Array.from({ length: DEFAULT_GUARDRAILS.fanoutMax + 1 }, (_, i) => `m${i}`);
    expect(evaluateHandoff(ctx(), targets)).toMatchObject({ allowed: false });
    expect(evaluateHandoff(ctx(), targets).reason).toContain("fanout");
  });

  it("rejects at max depth", () => {
    expect(evaluateHandoff(ctx({ depth: DEFAULT_GUARDRAILS.depthMax }), ["m2"])).toMatchObject({
      allowed: false,
    });
  });

  it("rejects when budget is exhausted", () => {
    expect(evaluateHandoff(ctx({ budgetUsed: DEFAULT_GUARDRAILS.budgetMax }), ["m2"])).toMatchObject({
      allowed: false,
    });
  });

  it("stops ping-pong by rejecting members at the revisit limit", () => {
    const decision = evaluateHandoff(ctx({ visitCounts: { m2: DEFAULT_GUARDRAILS.revisitMax } }), ["m2"]);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("revisit");
  });

  it("honours overridden guardrails", () => {
    expect(evaluateHandoff(ctx({ depth: 3 }), ["m2"], { ...DEFAULT_GUARDRAILS, depthMax: 3 }).allowed).toBe(
      false,
    );
    expect(evaluateHandoff(ctx({ depth: 3 }), ["m2"], { ...DEFAULT_GUARDRAILS, depthMax: 4 }).allowed).toBe(
      true,
    );
  });
});
