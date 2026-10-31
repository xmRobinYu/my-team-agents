import { describe, expect, it, vi } from "vitest";
import type { ChatRoom, RoomAgent, RoomMessage } from "@my-team-agents/domain";
import { ExecutionStore } from "./execution-store.js";
import { RoomStore } from "./room-store.js";
import {
  buildRoomPrompt,
  postRoomMessage,
  ROOM_HISTORY_LIMIT,
  RoomTriggerError,
  type RoomTriggerErrorCode,
} from "./room-trigger.js";

/**
 * I3's target -> Task mapping and failure contract. Rooms and tasks share one
 * database handle, exactly like `buildApp` wires them, so "one transaction" is
 * genuinely one transaction here rather than two that happen to be adjacent.
 */
const setup = () => {
  const store = new ExecutionStore(":memory:");
  const rooms = new RoomStore(store.db);
  // `createRoomWithAgents` forwards the caller's roomId and cannot know the id
  // minted inside its own transaction (template-import.ts:894-905), so the
  // fixture builds the room the way the importer does.
  const room = rooms.createRoom({ projectId: "proj-1", name: "研发群" }, 100);
  const agents = [
    rooms.addAgent({ roomId: room.id, name: "架构师", role: "架构", prompt: "You design.", agentDir: "/persona/arch" }, 100),
    rooms.addAgent({ roomId: room.id, name: "QA", role: "测试", prompt: "You test.", agentDir: "/persona/qa" }, 101),
  ];
  const trigger = (content: string, executions: ExecutionStore = store, roomId: string = room.id) =>
    postRoomMessage(rooms, executions, {
      roomId,
      content,
      tenantId: "default",
      workspacePath: "/workspace/proj-1",
      now: 200,
    });
  const codeOf = (run: () => unknown): RoomTriggerErrorCode | "none" => {
    try { run(); return "none"; } catch (err) {
      if (err instanceof RoomTriggerError) return err.code;
      throw err;
    }
  };
  const close = () => { rooms.close(); store.close(); };
  return { store, rooms, room, agents, trigger, codeOf, close };
};

describe("postRoomMessage (I3 mention trigger)", () => {
  it("maps each mentioned agent to a Task carrying its own agentDir, in mention order", () => {
    const h = setup();
    const posted = h.trigger("请 @架构师 定方案，然后 @QA 复核");
    expect(posted.message.authorKind).toBe("user");
    expect(posted.message.content).toContain("@架构师");
    expect(posted.tasks.map((t) => t.memberId)).toEqual(h.agents.map((a) => a.id));

    const tasks = posted.tasks.map((t) => h.store.getTask(t.id)!);
    expect(tasks.map((t) => t.agentDir)).toEqual(["/persona/arch", "/persona/qa"]);
    expect(tasks.map((t) => t.workspacePath)).toEqual(["/workspace/proj-1", "/workspace/proj-1"]);
    // groupId is the room: it is what serialises the room in claimNext (AC3).
    expect(tasks.map((t) => t.groupId)).toEqual([h.room.id, h.room.id]);
    expect(tasks[0]?.prompt).toContain("You design.");
    expect(tasks[0]?.prompt).toContain("@架构师 定方案");
    h.close();
  });

  it("refuses @unknown, duplicate names and plain chat with distinct codes", () => {
    const h = setup();
    expect(h.codeOf(() => h.trigger("请 @不存在的agent 看一下"))).toBe("UNKNOWN_MENTION");
    expect(h.codeOf(() => h.trigger("大家好，随便聊聊"))).toBe("NO_MENTION");
    expect(h.codeOf(() => h.trigger("@全体 开会"))).toBe("UNKNOWN_MENTION");
    expect(h.codeOf(() => h.trigger("   "))).toBe("CONTENT_REQUIRED");

    h.rooms.addAgent({ roomId: h.room.id, name: "架构师", prompt: "clone", agentDir: "/persona/dup" }, 150);
    expect(h.codeOf(() => h.trigger("请 @架构师 处理"))).toBe("AMBIGUOUS_MENTION");

    // every refusal is a refusal to write: no message, no Task
    expect(h.rooms.listMessages(h.room.id)).toEqual([]);
    expect(h.store.listTasks()).toEqual([]);
    h.close();
  });

  it("leaves no half product when Task creation fails mid-transaction", () => {
    const h = setup();
    // The second insert explodes after the message is already written — the exact
    // state a non-transactional implementation would leak.
    const real = h.store.createTask.bind(h.store);
    let calls = 0;
    vi.spyOn(h.store, "createTask").mockImplementation((input, now) => {
      calls += 1;
      if (calls === 2) throw new Error("simulated insert failure");
      return real(input, now);
    });

    expect(() => h.trigger("请 @架构师 和 @QA 一起看")).toThrow("simulated insert failure");
    expect(h.rooms.listMessages(h.room.id)).toEqual([]);
    expect(h.store.listTasks()).toEqual([]);
    h.close();
  });

  it("404s an unknown room instead of writing anywhere", () => {
    const h = setup();
    expect(h.codeOf(() => h.trigger("@QA hi", h.store, "room-missing"))).toBe("ROOM_NOT_FOUND");
    expect(h.store.listTasks()).toEqual([]);
    h.close();
  });

  it("injects the shared history instead of just the latest message", () => {
    const h = setup();
    h.rooms.appendMessage({ roomId: h.room.id, authorKind: "agent", authorAgentId: h.agents[1]!.id, content: "QA 先看过" }, 150);
    const posted = h.trigger("请 @架构师 定方案，然后 @QA 复核");
    const prompt = h.store.getTask(posted.tasks[0]!.id)!.prompt;
    // Q30: the other agent's message is in there, labelled with its name.
    expect(prompt).toContain("[1] QA: QA 先看过");
    expect(prompt).toContain("[2] 用户: 请 @架构师 定方案，然后 @QA 复核");
    // I4: the trigger message reaches the prompt exactly once — it is the last
    // history line, not a second "用户消息" block bolted onto the end.
    expect(prompt.split("定方案").length - 1).toBe(1);
    // Every target gets the SAME history, each under its OWN role prompt.
    const qaPrompt = h.store.getTask(posted.tasks[1]!.id)!.prompt;
    expect(qaPrompt).toContain("You test.");
    expect(qaPrompt).not.toContain("You design.");
    expect(prompt).not.toContain("You test.");
    expect(qaPrompt).toContain("[1] QA: QA 先看过");
    expect(qaPrompt.split("定方案").length - 1).toBe(1);
  });

  it("reports how much history the limit dropped instead of cutting silently", () => {
    const h = setup();
    // Fill to the cap BEFORE the trigger, so the injected window must admit it
    // left the oldest line out rather than quietly starting mid-conversation.
    for (let i = 1; i <= ROOM_HISTORY_LIMIT; i += 1) {
      h.rooms.appendMessage({ roomId: h.room.id, authorKind: "system", content: `旧消息${i}` }, 150);
    }
    const posted = h.trigger("请 @架构师 定方案");
    const prompt = h.store.getTask(posted.tasks[0]!.id)!.prompt;
    expect(h.rooms.countMessages(h.room.id)).toBe(ROOM_HISTORY_LIMIT + 1);
    expect(prompt).toContain("# 群聊记录\n（已省略较早的 1 条消息）");
    // The newest messages survive; the oldest one is gone and named as gone.
    expect(prompt).toContain(`[${ROOM_HISTORY_LIMIT + 1}] 用户: 请 @架构师 定方案`);
    expect(prompt).toContain(`[${ROOM_HISTORY_LIMIT}] 系统: 旧消息${ROOM_HISTORY_LIMIT}`);
    expect(prompt).not.toContain("[1] 系统: 旧消息1");
    h.close();
  });
});

const chatRoom = (over: Partial<ChatRoom> = {}): ChatRoom => ({
  id: "room-1", projectId: "proj-1", name: "研发群", description: "",
  rules: "## 规则\n先方案后编码。", coordinatorAgentId: "a-lead", maxRounds: 6, createdAt: 100,
  ...over,
});

const roomAgent = (over: Partial<RoomAgent> = {}): RoomAgent => ({
  id: "a-lead", roomId: "room-1", name: "齐活林", role: "交付总监", prompt: "You coordinate.",
  agentDir: "/persona/lead", model: null, thinkingMode: null, emoji: null, color: null,
  isCoordinator: true, createdAt: 100, ...over,
});

const note = (seq: number, authorKind: RoomMessage["authorKind"], content: string, authorAgentId: string | null = null): RoomMessage => ({
  id: `msg-${seq}`, roomId: "room-1", seq, authorKind, authorAgentId, content, taskId: null, createdAt: 100 + seq,
});

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("buildRoomPrompt (I4 shared history injection)", () => {
  const qa = roomAgent({ id: "a-qa", name: "QA", role: "测试", prompt: "You test.", isCoordinator: false });
  const members = [roomAgent(), qa];

  it("lays the sections out in the fixed order, history in seq order", () => {
    // Deliberately unsorted input: the prompt must still read oldest -> newest.
    const history = [note(3, "agent", "QA 复核通过", qa.id), note(1, "user", "开工"), note(2, "system", "本轮开始")];
    const prompt = buildRoomPrompt(chatRoom(), roomAgent(), members, history);
    const order = ["You coordinate.", "# 角色：", "# 群：研发群", "# 群规则", "# 成员", "# 群聊记录", "# 你的任务"];
    const positions = order.map((s) => prompt.indexOf(s));
    positions.forEach((at, index) => {
      expect(at, `section ${order[index]} present`).toBeGreaterThan(-1);
      if (index > 0) expect(at, `section ${order[index]} after the previous`).toBeGreaterThan(positions[index - 1]!);
    });
    const lines = prompt.split("\n");
    const historyStart = lines.findIndex((l) => l === "# 群聊记录") + 1;
    expect(lines.slice(historyStart, historyStart + 3)).toEqual([
      "[1] 用户: 开工",
      "[2] 系统: 本轮开始",
      "[3] QA: QA 复核通过",
    ]);
  });

  it("names every author kind and falls back to the agent id when the member is gone", () => {
    const gone = note(4, "agent", "我已经离开这个群了", "a-deleted");
    const prompt = buildRoomPrompt(chatRoom(), roomAgent(), members, [note(1, "user", "u"), note(2, "system", "s"), note(3, "agent", "a", qa.id), gone]);
    expect(prompt).toContain("[1] 用户: u");
    expect(prompt).toContain("[2] 系统: s");
    expect(prompt).toContain("[3] QA: a");
    // A deleted agent must not crash the injection and must not lose its message.
    expect(prompt).toContain("[4] a-deleted: 我已经离开这个群了");
  });

  it("carries this agent's own role prompt, the roster and the coordinator marks", () => {
    const prompt = buildRoomPrompt(chatRoom(), qa, members, [note(1, "user", "看这里")]);
    expect(prompt.indexOf("You test.")).toBeLessThan(prompt.indexOf("# 角色："));
    expect(prompt).toContain("# 角色：QA（测试）");
    expect(prompt).toContain("- 齐活林（交付总监）（协调者）");
    expect(prompt).toContain("- QA（测试）");
    expect(prompt).toContain("# 群：研发群");
    expect(prompt).toContain("先方案后编码。");
    expect(prompt).not.toContain("You coordinate.");
  });

  it("omits an empty role and an empty rules block", () => {
    const bare = roomAgent({ name: "无名", role: "  ", prompt: "Solo.", isCoordinator: false });
    const prompt = buildRoomPrompt(chatRoom({ rules: "  " }), bare, [bare], []);
    expect(prompt).toContain("# 角色：无名\n");
    expect(prompt).not.toContain("无名（）");
    expect(prompt).not.toContain("# 群规则");
    expect(prompt).toContain("（暂无消息）");
    // A coordinator with no role still gets the mark, without an empty pair.
    const lead = roomAgent({ name: "无名", role: "  ", prompt: "Solo." });
    expect(buildRoomPrompt(chatRoom(), lead, [lead], [])).toContain("# 角色：无名（协调者）\n");
  });

  it("announces a truncation instead of hiding one", () => {
    const prompt = buildRoomPrompt(chatRoom(), roomAgent(), members, [note(1, "user", "u")], 7);
    expect(prompt).toContain("# 群聊记录\n（已省略较早的 7 条消息）");

    // Oversized history passed directly: the window itself trims and reports it.
    const many = Array.from({ length: ROOM_HISTORY_LIMIT + 3 }, (_, i) => note(i + 1, "user", `m${i + 1}`));
    const trimmed = buildRoomPrompt(chatRoom(), roomAgent(), members, many);
    expect(trimmed).toContain(`（已省略较早的 3 条消息）`);
    expect(trimmed).not.toContain("[1] 用户: m1\n");
    expect(trimmed).toContain(`[${ROOM_HISTORY_LIMIT + 3}] 用户: m${ROOM_HISTORY_LIMIT + 3}`);
    expect(occurrences(trimmed, "] 用户: m")).toBe(ROOM_HISTORY_LIMIT);
    expect(occurrences(trimmed, "] 用户: m1\n")).toBe(0);
  });

  it("asks the agent to answer the latest message without reciting history", () => {
    const prompt = buildRoomPrompt(chatRoom(), roomAgent(), members, [note(1, "user", "u")]);
    const task = prompt.slice(prompt.indexOf("# 你的任务"));
    expect(task).toContain("最新的一条消息");
    expect(task).toContain("不要重复其他成员");
    expect(task).toContain("不要复述整段群聊记录");
  });
});
