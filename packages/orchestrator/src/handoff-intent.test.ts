import { describe, expect, it } from "vitest";
import { dedupeByOrigin, extractHandoffs, HANDOFF_TOOL_NAME, parseHandoffArgs, type DispatchTarget } from "./handoff-intent.js";

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

describe("dedupeByOrigin — 两条路径按目标折叠（Q35 / AC3.3）", () => {
  const t = (toMemberId: string, origin: DispatchTarget["origin"]): DispatchTarget & { tag: string } => ({
    toMemberId, origin, tag: `${origin}:${toMemberId}`,
  });

  it("同一目标两条路径命中 → 保留 handoff_to，且不论谁先出现", () => {
    const mentionFirst = [t("b", "mention"), t("b", "handoff_to")];
    expect(dedupeByOrigin(mentionFirst).map((x) => x.origin)).toEqual(["handoff_to"]);
    expect(dedupeByOrigin([t("b", "handoff_to"), t("b", "mention")]).map((x) => x.origin)).toEqual(["handoff_to"]);
  });

  it("不同目标都保留，并保持首次出现顺序", () => {
    const batch = [t("c", "mention"), t("b", "handoff_to"), t("c", "mention")];
    expect(dedupeByOrigin(batch).map((x) => x.toMemberId)).toEqual(["c", "b"]);
  });

  it("同一路径内部重复 → 保留第一条（先到先得，不按 reason 猜）", () => {
    const doubled = [t("b", "handoff_to"), t("b", "handoff_to")];
    expect(dedupeByOrigin(doubled)).toHaveLength(1);
    expect(dedupeByOrigin(doubled)[0]!.tag).toBe("handoff_to:b");
  });

  it("空输入返回空；单条原样返回", () => {
    expect(dedupeByOrigin([])).toEqual([]);
    expect(dedupeByOrigin([t("b", "mention")])).toHaveLength(1);
  });
});
