import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_ROUNDS } from "@my-team-agents/domain";
import { RoomStore } from "./room-store.js";

const room = (name = "全栈软件研发") => ({
  projectId: "proj-1",
  name,
  description: "desc",
  rules: "## 规则",
});

describe("RoomStore — rooms and agents", () => {
  it("creates a room with defaults", () => {
    const store = new RoomStore();
    const created = store.createRoom(room());
    expect(created.name).toBe("全栈软件研发");
    expect(created.maxRounds).toBe(DEFAULT_MAX_ROUNDS);
    expect(created.coordinatorAgentId).toBeNull();
    expect(store.getRoom(created.id)?.id).toBe(created.id);
    store.close();
  });

  it("creates agents and marks the coordinator", () => {
    const store = new RoomStore();
    const r = store.createRoom(room());
    const a = store.addAgent({ roomId: r.id, name: "高见远", prompt: "architect", agentDir: "/d/a" });
    const c = store.addAgent({
      roomId: r.id, name: "齐活林", prompt: "pm", agentDir: "/d/c", isCoordinator: true,
    });
    expect(a.isCoordinator).toBe(false);
    expect(c.isCoordinator).toBe(true);
    expect(store.getRoom(r.id)?.coordinatorAgentId).toBe(c.id);
    expect(store.listAgents(r.id)).toHaveLength(2);
    expect(store.findAgentByName(r.id, "高见远")?.id).toBe(a.id);
    store.close();
  });

  it("rolls back the whole room when an agent insert fails", () => {
    const store = new RoomStore();
    expect(() =>
      store.createRoomWithAgents(room("bad"), [
        { roomId: "", name: "x", prompt: "p", agentDir: "/d" },
      ]),
    ).toThrow();
    expect(store.listRooms()).toHaveLength(0);
    store.close();
  });
});

describe("RoomStore — message stream", () => {
  it("orders messages by seq", () => {
    const store = new RoomStore();
    const r = store.createRoom(room());
    store.appendMessage({ roomId: r.id, authorKind: "user", content: "第一句" });
    store.appendMessage({ roomId: r.id, authorKind: "agent", authorAgentId: "a1", content: "第二句" });
    const msgs = store.listMessages(r.id);
    expect(msgs.map((m) => m.content)).toEqual(["第一句", "第二句"]);
    expect(msgs[1]?.authorAgentId).toBe("a1");
    store.close();
  });

  it("keeps per-room streams independent", () => {
    const store = new RoomStore();
    const a = store.createRoom(room("A"));
    const b = store.createRoom(room("B"));
    store.appendMessage({ roomId: a.id, authorKind: "user", content: "in a" });
    store.appendMessage({ roomId: b.id, authorKind: "user", content: "in b" });
    expect(store.listMessages(a.id).map((m) => m.content)).toEqual(["in a"]);
    expect(store.listMessages(b.id).map((m) => m.content)).toEqual(["in b"]);
    store.close();
  });
});

describe("RoomStore — flow state persistence", () => {
  it("counts triggers and records the chain", () => {
    const store = new RoomStore();
    const r = store.createRoom(room());
    store.recordTrigger(r.id, "a1");
    const after = store.recordTrigger(r.id, "a2");
    expect(after.roundCount).toBe(2);
    expect(after.chain).toEqual(["a1", "a2"]);
    store.close();
  });

  it("resets rounds, chain and termination on a new user message", () => {
    const store = new RoomStore();
    const r = store.createRoom(room());
    store.recordTrigger(r.id, "a1");
    store.markTerminated(r.id);
    expect(store.getState(r.id).terminated).toBe(true);
    const reset = store.resetState(r.id);
    expect(reset.roundCount).toBe(0);
    expect(reset.chain).toEqual([]);
    expect(reset.terminated).toBe(false);
    store.close();
  });

  it("survives reopening the database (terminated is not in-memory)", () => {
    const file = `/tmp/mta-room-${Date.now()}-${Math.random()}.sqlite`;
    const first = new RoomStore(file);
    const r = first.createRoom(room());
    first.recordTrigger(r.id, "a1");
    first.markTerminated(r.id);
    first.close();

    const second = new RoomStore(file);
    const state = second.getState(r.id);
    expect(state.terminated).toBe(true);
    expect(state.roundCount).toBe(1);
    expect(state.chain).toEqual(["a1"]);
    second.close();
  });

  it("returns an empty state for a room with no row yet", () => {
    const store = new RoomStore();
    const r = store.createRoom(room());
    const state = store.getState(r.id);
    expect(state).toMatchObject({ roundCount: 0, chain: [], terminated: false });
    store.close();
  });
});
