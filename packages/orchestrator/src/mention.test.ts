import { describe, expect, it } from "vitest";
import type { RoomAgent } from "@my-team-agents/domain";
import { resolveMentions } from "./mention.js";

const agent = (name: string, id = `agent-${name}`): RoomAgent => ({
  id,
  roomId: "room-1",
  name,
  role: "",
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
});
