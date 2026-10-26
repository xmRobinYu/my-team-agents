import { describe, expect, it } from "vitest";
import { extractHandoffs, HANDOFF_TOOL_NAME, parseHandoffArgs } from "./handoff-intent.js";

const toolEvent = (args: unknown, toolName = HANDOFF_TOOL_NAME) => ({
  type: "tool_execution_start",
  toolName,
  args,
});

describe("parseHandoffArgs", () => {
  it("accepts a well-formed declaration", () => {
    const r = parseHandoffArgs({ toMemberIds: ["bob", "carol"], reason: "needs review" });
    expect(r.intents).toHaveLength(1);
    expect(r.intents[0]!.toMemberIds).toEqual(["bob", "carol"]);
    expect(r.intents[0]!.reason).toBe("needs review");
    expect(r.issues).toEqual([]);
  });

  it("supports the short `to` alias", () => {
    expect(parseHandoffArgs({ to: ["bob"], reason: "x" }).intents[0]!.toMemberIds).toEqual(["bob"]);
  });

  it("rejects an empty target list", () => {
    const r = parseHandoffArgs({ toMemberIds: [], reason: "x" });
    expect(r.intents).toHaveLength(0);
    expect(r.issues.join()).toContain("non-empty");
  });

  it("rejects ill-typed targets rather than coercing them", () => {
    expect(parseHandoffArgs({ toMemberIds: [1, 2], reason: "x" }).intents).toHaveLength(0);
    expect(parseHandoffArgs({ toMemberIds: "bob", reason: "x" }).intents).toHaveLength(0);
  });

  it("collapses duplicates and reports it", () => {
    const r = parseHandoffArgs({ toMemberIds: ["bob", "bob"], reason: "x" });
    expect(r.intents[0]!.toMemberIds).toEqual(["bob"]);
    expect(r.issues.join()).toContain("duplicate");
  });

  it("flags a missing reason without discarding the intent", () => {
    const r = parseHandoffArgs({ toMemberIds: ["bob"] });
    expect(r.intents).toHaveLength(1);
    expect(r.issues.join()).toContain("missing reason");
  });

  it("truncates an oversized reason", () => {
    const r = parseHandoffArgs({ toMemberIds: ["bob"], reason: "x".repeat(5000) });
    expect(r.intents[0]!.reason).toHaveLength(2000);
    expect(r.issues.join()).toContain("truncated");
  });

  it("rejects non-object args", () => {
    expect(parseHandoffArgs(null).intents).toHaveLength(0);
    expect(parseHandoffArgs("bob").issues.join()).toContain("must be an object");
  });
});

describe("extractHandoffs", () => {
  it("only reads the declared tool, never prose", () => {
    const events = [
      { type: "message_update", text: "@bob please take a look" },
      { type: "tool_execution_start", toolName: "bash", args: { command: "ls" } },
      toolEvent({ toMemberIds: ["bob"], reason: "real" }),
    ];
    const r = extractHandoffs(events);
    expect(r.intents).toHaveLength(1);
    expect(r.intents[0]!.toMemberIds).toEqual(["bob"]);
  });

  it("ignores a similarly named tool", () => {
    const r = extractHandoffs([toolEvent({ toMemberIds: ["bob"], reason: "x" }, "handoff_to_v2")]);
    expect(r.intents).toHaveLength(0);
  });

  it("collects multiple declared handoffs", () => {
    const r = extractHandoffs([
      toolEvent({ toMemberIds: ["bob"], reason: "a" }),
      toolEvent({ toMemberIds: ["carol"], reason: "b" }),
    ]);
    expect(r.intents.map((i) => i.toMemberIds[0])).toEqual(["bob", "carol"]);
  });

  it("returns nothing for a run with no handoff", () => {
    expect(extractHandoffs([{ type: "agent_end" }]).intents).toHaveLength(0);
  });
});
