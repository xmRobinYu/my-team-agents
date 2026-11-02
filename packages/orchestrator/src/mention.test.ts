import { describe, expect, it } from "vitest";
import type { RoomAgent } from "@my-team-agents/domain";
import { resolveMentions, resolveRosterTokens } from "./mention.js";

const agent = (name: string, id = `agent-${name}`, role = ""): RoomAgent => ({
  id,
  roomId: "room-1",
  name,
  role,
  prompt: "",
  agentDir: `/tmp/persona/${id}`,
  model: null,
  thinkingMode: null,
  emoji: null,
  color: null,
  isCoordinator: false,
  createdAt: 0,
});

const ROOM = [
  agent("架构师", "a1"),
  agent("齐活林（交付总监）", "a2"),
  agent("QA", "a3"),
  agent("张三", "a4"),
];

describe("resolveMentions", () => {
  it("行内 @：句中、句末、标点相邻都命中，结果按提及顺序", () => {
    const r = resolveMentions("请@架构师 看一下，然后@QA。@架构师", ROOM);
    expect(r.targets.map((a) => a.id)).toEqual(["a1", "a3"]);
    expect(r.unknown).toEqual([]);
    expect(r.ambiguous).toEqual([]);
  });

  it("一消息 @A @B → 两个目标，重复提及去重（Q35）", () => {
    const r = resolveMentions("@架构师 @QA @架构师", ROOM);
    expect(r.targets.map((a) => a.id)).toEqual(["a1", "a3"]);
    expect(r.unknown).toEqual([]);
  });

  it("重名 agent → ambiguous，不静默取第一个", () => {
    const dup = ROOM.concat([agent("架构师", "a5")]);
    const r = resolveMentions("请 @架构师 处理", dup);
    expect(r.targets).toEqual([]);
    expect(r.ambiguous).toEqual(["架构师"]);
    expect(r.unknown).toEqual([]);
  });

  it("@全体 / @all → unknown（room 内不存在该 agent）", () => {
    const r = resolveMentions("@全体 大家看看，@all 也看看", ROOM);
    expect(r.targets).toEqual([]);
    expect(r.unknown).toEqual(["全体", "all"]);
  });

  it("@不存在的agent → unknown，非静默", () => {
    const r = resolveMentions("@不存在的人 你好", ROOM);
    expect(r.targets).toEqual([]);
    expect(r.unknown).toEqual(["不存在的人"]);
  });

  it("robin@example.com 不算提及", () => {
    const r = resolveMentions("联系 robin@example.com 或 @QA", ROOM);
    expect(r.targets.map((a) => a.id)).toEqual(["a3"]);
    expect(r.unknown).toEqual([]);
  });

  it("@架构师X 是更长的 ASCII 句柄 → unknown，不误触 @架构师", () => {
    const r = resolveMentions("@架构师X", ROOM);
    expect(r.targets).toEqual([]);
    expect(r.unknown).toEqual(["架构师X"]);
  });

  it("长名优先：room 同时有 @张三 与 @张三丰 时，@张三丰 只命中长名", () => {
    const withLong = ROOM.concat([agent("张三丰", "a6")]);
    const r = resolveMentions("@张三丰 和 @张三 都在", withLong);
    expect(r.targets.map((a) => a.id)).toEqual(["a6", "a4"]);
    expect(r.unknown).toEqual([]);
  });

  it("带括号的全名命中：@齐活林（交付总监）", () => {
    const r = resolveMentions("有请@齐活林（交付总监）总结", ROOM);
    expect(r.targets.map((a) => a.id)).toEqual(["a2"]);
    expect(r.unknown).toEqual([]);
  });

  it("裸 @ 不算提及；无提及消息返回空", () => {
    expect(resolveMentions("处理一下 @", ROOM).unknown).toEqual([]);
    const r = resolveMentions("大家看看这条消息", ROOM);
    expect(r.targets).toEqual([]);
    expect(r.unknown).toEqual([]);
    expect(r.ambiguous).toEqual([]);
  });

  // I5: the same resolver serves both paths — a user message (strict caller) and
  // an agent's own reply (lenient caller, `durable-worker.ts`). It classifies and
  // never decides the failure policy, so these cases are exactly what the agent
  // path sees: a resolvable name, an unknown one, and an ambiguous one.
  it("agent 正文与用户消息走同一个解析器（I5 次路径复用）", () => {
    const agentText = "上次 @老王 提过这个，接口还是请 @架构师 定，@QA 补用例。";
    const r = resolveMentions(agentText, ROOM);
    expect(r.targets.map((a) => a.id)).toEqual(["a1", "a3"]);
    expect(r.unknown).toEqual(["老王"]);
    expect(r.ambiguous).toEqual([]);
  });

  it("重名在两种正文里都是 ambiguous，交由调用方决定 4xx 还是不派发", () => {
    const dup = ROOM.concat([agent("QA", "a9")]);
    expect(resolveMentions("@QA 看一下", dup).ambiguous).toEqual(["QA"]);
    expect(resolveMentions("我让 @QA 复核了一下", dup).ambiguous).toEqual(["QA"]);
  });
});

// --- D2: `@角色` must work, without ever guessing a person ------------------
//
// The imported `全栈软件研发` package names its agents 高见远 / 许清楚 / 寇豆码 /
// 严过关 / 齐活林 and puts the function in `role`. Users type the function.
// So a role is a *fallback* address, never a competing one: names are matched
// first, a shared role degrades to `ambiguous` exactly like a shared name, and
// nothing but `name` / `role` is ever consulted.
describe("D2 — 名称优先、角色次之", () => {
  const TEAM = [
    agent("高见远", "g1", "架构师"),
    agent("许清楚", "g2", "产品经理"),
    agent("寇豆码", "g3", "工程师"),
    agent("严过关", "g4", "QA工程师"),
    agent("齐活林", "g5", "交付总监"),
  ];

  it("@架构师 命中 role 唯一的 高见远（缺陷 D2 的主用例）", () => {
    const r = resolveMentions("请 @架构师 出方案", TEAM);
    expect(r.targets.map((a) => a.id)).toEqual(["g1"]);
    expect(r.unknown).toEqual([]);
    expect(r.ambiguous).toEqual([]);
  });

  it("角色匹配仍用同一个 needle：全字面、不折叠大小写、不吃空白", () => {
    expect(resolveMentions("@QA工程师 上", TEAM).targets.map((a) => a.id)).toEqual(["g4"]);
    // `@qa工程师` differs only in case — the name path never folded case either,
    // so the role path must not start folding it now.
    expect(resolveMentions("@qa工程师 上", TEAM).targets).toEqual([]);
    expect(resolveMentions("@ 架构师 上", TEAM).targets).toEqual([]);
  });

  it("@高见远 只解析到 高见远：哪怕别人的 role 恰好也叫高见远也不抢、不 ambiguous", () => {
    const hijack = TEAM.concat([agent("路人甲", "x1", "高见远")]);
    const r = resolveMentions("@高见远 看一下", hijack);
    expect(r.targets.map((a) => a.id)).toEqual(["g1"]);
    expect(r.ambiguous).toEqual([]);
  });

  it("刁钻夹具：A.name=架构师 与 B.role=架构师 并存时，@架构师 归 A", () => {
    const rivals = [agent("架构师", "a-name", ""), agent("高见远", "a-role", "架构师")];
    const r = resolveMentions("请 @架构师 定", rivals);
    expect(r.targets.map((a) => a.id)).toEqual(["a-name"]);
    expect(r.ambiguous).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  it("两个 agent 同为 工程师 → @工程师 进 ambiguous，一个都不派发", () => {
    const twins = TEAM.concat([agent("章代码", "g6", "工程师")]);
    const r = resolveMentions("@工程师 来两个人", twins);
    expect(r.targets).toEqual([]);
    expect(r.ambiguous).toEqual(["工程师"]);
    expect(r.unknown).toEqual([]);
  });

  it("未知的 @不存在 不会被角色匹配意外吞掉", () => {
    const r = resolveMentions("@不存在 你好", TEAM);
    expect(r.targets).toEqual([]);
    expect(r.unknown).toEqual(["不存在"]);
  });

  it("角色路径不匹配 agentId / emoji —— 内部标识不是用户接口", () => {
    const r = resolveMentions("@严过关 请用 @g4 或 @🎯 称呼我", TEAM);
    expect(r.targets.map((a) => a.id)).toEqual(["g4"]);
    expect(r.unknown).toEqual(["g4", "🎯"]);
  });

  it("一条消息里名称与角色各自命中，仍按提及顺序、按目标去重", () => {
    const r = resolveMentions("@架构师 先出方案，@许清楚 补需求，@架构师 再评审", TEAM);
    expect(r.targets.map((a) => a.id)).toEqual(["g1", "g2"]);
  });
});

// --- D4: `@ts-ignore` is code, not a missing colleague ----------------------
//
// Both callers would otherwise answer a code snippet with a member-name
// complaint: `postRoomMessage` with `UNKNOWN_MENTION` (4xx), the agent prose
// path with a system message in the shared stream. Same rule, both paths,
// because the resolver classifies once.
describe("D4 — 代码写法不当作成员提及", () => {
  const CODE_ROOM = [agent("高见远", "g1", "架构师"), agent("Robin", "r1"), agent("dev-1", "d1")];

  it("@ts-ignore / @param / @deprecated 不产生 unknown，也不派发", () => {
    const r = resolveMentions("这里加了 // @ts-ignore 因为 @param 少了一个，@deprecated 再说。", CODE_ROOM);
    expect(r.targets).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  it("@types/node 与任意 @scope/pkg 形态不产生 unknown", () => {
    expect(resolveMentions("装一下 @types/node 和 @vue/test-utils", CODE_ROOM).unknown).toEqual([]);
  });

  it("@media 与带参数的 @media(...) 都不产生 unknown", () => {
    expect(resolveMentions("@media 查询要改", CODE_ROOM).unknown).toEqual([]);
    expect(resolveMentions("@media(max-width: 600px) 下溢出", CODE_ROOM).unknown).toEqual([]);
  });

  it("ASCII 真成员照旧派发：清单不吃名字（Robin / dev-1 / QA）", () => {
    const r = resolveMentions("@Robin 看一下，@dev-1 也看", CODE_ROOM);
    expect(r.targets.map((a) => a.id)).toEqual(["r1", "d1"]);
    expect(r.unknown).toEqual([]);
  });

  it("@不存在 仍然报 unknown —— 漏判无害，误判才致命", () => {
    expect(resolveMentions("@不存在 处理", CODE_ROOM).unknown).toEqual(["不存在"]);
  });

  it("群真声明了这个词（agent 名 Media）→ 不再当代码，按未解析成员名报出来", () => {
    const room = CODE_ROOM.concat([agent("Media", "m1")]);
    const r = resolveMentions("@Media 上，@media 也说一下", room);
    expect(r.targets.map((a) => a.id)).toEqual(["m1"]);
    expect(r.unknown).toEqual(["media"]);
  });
});

// --- D5: the roster also answers a structured `handoff_to` token ----------------
//
// Both dispatch paths must mean the same thing by the same string, or a model can
// pick whichever path its validator happens to accept. These cases pin the shared
// rules `resolveMentions` already had (D2), now applied to a list of tokens.
describe("resolveRosterTokens — 花名册把 handoff_to 的写法解析成人（D5）", () => {
  const ROOM = [
    agent("高见远", "agent-aaa", "架构师"),
    agent("寇豆码", "agent-bbb", "工程师"),
    agent("许清楚", "agent-ccc", "产品经理"),
  ];
  const ids = (tokens: string[]) => resolveRosterTokens(tokens, ROOM).targets.map((a) => a.id);

  it("id、名字、角色三种写法都命中同一个人", () => {
    expect(ids(["agent-aaa"])).toEqual(["agent-aaa"]);
    expect(ids(["高见远"])).toEqual(["agent-aaa"]);
    expect(ids(["架构师"])).toEqual(["agent-aaa"]);
  });

  it("带 @ 的写法照旧解析 —— 模型把正文记法抄进工具里不是另一个人", () => {
    expect(ids(["@高见远", "@架构师"])).toEqual(["agent-aaa"]);
  });

  it("名字优先于角色，即使角色属于另一个人（D2 同规则）", () => {
    // 甲的名字是「工程师」，而乙的 role 是「工程师」：名字是身份，角色是描述。
    const tricky = [agent("工程师", "agent-name-is-role", ""), ...ROOM];
    expect(resolveRosterTokens(["工程师"], tricky).targets.map((a) => a.id))
      .toEqual(["agent-name-is-role"]);
  });

  it("多个目标按首次出现顺序返回，重复写法折叠成一个人（Q35）", () => {
    expect(resolveRosterTokens(["寇豆码", "架构师", "agent-aaa"], ROOM).targets.map((a) => a.id))
      .toEqual(["agent-bbb", "agent-aaa"]);
  });

  it("花名册里没有 → unknown，绝不返回一个猜的人", () => {
    const r = resolveRosterTokens(["老王", "agent-aaa", "不存在"], ROOM);
    expect(r.unknown).toEqual(["老王", "不存在"]);
    expect(r.targets.map((a) => a.id)).toEqual(["agent-aaa"]);
  });

  it("重名 → ambiguous，不派发（与 @ 路径同一条规则）", () => {
    const dup = ROOM.concat([agent("寇豆码", "agent-bbb2", "写代码的")]);
    const r = resolveRosterTokens(["寇豆码"], dup);
    expect(r.ambiguous).toEqual(["寇豆码"]);
    expect(r.targets).toEqual([]);
  });

  it("两个成员共享同一角色 → 角色也 ambiguous", () => {
    const twins = ROOM.concat([agent("另一个人", "agent-ddd", "架构师")]);
    const r = resolveRosterTokens(["架构师"], twins);
    expect(r.ambiguous).toEqual(["架构师"]);
    expect(r.targets).toEqual([]);
  });

  it("近似写法不算命中：大小写、空格、半截名字都拒绝", () => {
    expect(resolveRosterTokens(["高见 远", "架构 ", "gaojian"], ROOM).unknown).toHaveLength(3);
    expect(resolveRosterTokens(["agent-aaa "], ROOM).unknown).toEqual(["agent-aaa "]);
  });

  it("id 永远唯一：即使两个成员同名，按 id 仍能分出是谁", () => {
    const dup = ROOM.concat([agent("寇豆码", "agent-bbb2", "写代码的")]);
    expect(resolveRosterTokens(["agent-bbb2"], dup).targets.map((a) => a.id)).toEqual(["agent-bbb2"]);
  });

  it("空数组与空串：不派发，也不报错", () => {
    expect(resolveRosterTokens([], ROOM).targets).toEqual([]);
    const r = resolveRosterTokens(["", "@"], ROOM);
    expect(r.targets).toEqual([]);
    // reported verbatim, as the caller wrote them — `parseHandoffArgs` strips empty
    // entries before this, so the only realistic shape here is a bare "@".
    expect(r.unknown).toEqual(["", "@"]);
  });
});
