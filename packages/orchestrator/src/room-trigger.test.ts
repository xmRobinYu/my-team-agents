import { describe, expect, it, vi } from "vitest";
import { ExecutionStore } from "./execution-store.js";
import { RoomStore } from "./room-store.js";
import {
  buildMentionPrompt,
  postRoomMessage,
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

  it("puts the role prompt before the user message", () => {
    const h = setup();
    const agent = h.agents[0]!;
    const prompt = buildMentionPrompt(agent, "请开始");
    expect(prompt.indexOf("You design.")).toBeLessThan(prompt.indexOf("请开始"));
    expect(prompt).toContain("架构");
    h.close();
  });
});
