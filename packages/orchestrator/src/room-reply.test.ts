import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { CanonicalEvent, RunHandle, RuntimeAdapter } from "@my-team-agents/runtime-core";
import { ExecutionStore } from "./execution-store.js";
import { RoomStore } from "./room-store.js";
import { createDurableWorker } from "./durable-worker.js";
import { postRoomMessage } from "./room-trigger.js";

/**
 * I4's second half: an agent's reply has to land back in the room stream.
 * Without it the "shared history" injected into the next trigger could only ever
 * contain user messages, and group chat (Q30) would be a formality.
 */

const summary = (text: string) => JSON.stringify({
  outcome: "success", summary: text, artifacts: [], remainingRisks: [],
});

const adapterFor = (reply: string): RuntimeAdapter => ({
  kind: "pi",
  capabilities: {
    streaming: true, steer: true, cancel: true, approval: "none", sandbox: "none",
    workspacePerRun: true, agentDirPerRun: false, usageAttribution: "message",
    costCap: false, sessionResume: false,
  },
  async start(spec): Promise<RunHandle> {
    const event: CanonicalEvent = {
      type: "message_end", runId: spec.runId, timestamp: "", text: summary(reply),
    };
    return {
      runId: spec.runId,
      events: (async function* () { yield event; })(),
      settled: Promise.resolve({ runId: spec.runId, status: "completed" }),
      async cancel() {},
    };
  },
});

const setup = (reply = "方案已定：先拆接口") => {
  const store = new ExecutionStore(":memory:");
  const rooms = new RoomStore(store.db);
  const room = rooms.createRoom({ projectId: "proj-1", name: "研发群", rules: "## 规则" }, 100);
  const lead = rooms.addAgent(
    { roomId: room.id, name: "架构师", role: "架构", prompt: "You design.", agentDir: "/persona/arch" }, 100,
  );
  const qa = rooms.addAgent(
    { roomId: room.id, name: "QA", role: "测试", prompt: "You test.", agentDir: "/persona/qa" }, 101,
  );
  const worker = createDurableWorker(store, {
    workerId: "w1", adapterFor: () => adapterFor(reply), rooms, now: () => 200,
  });
  const trigger = (content: string) => postRoomMessage(rooms, store, {
    roomId: room.id, content, tenantId: "default", workspacePath: "/workspace/proj-1", now: 200,
  });
  return { store, rooms, room, lead, qa, worker, trigger };
};

describe("agent reply lands in the room stream (I4)", () => {
  it("appends one agent message carrying the member id and its task id", async () => {
    const h = setup();
    const posted = h.trigger("请 @架构师 定方案");
    expect(await h.worker.runOnce()).toBe(true);

    const messages = h.rooms.listMessages(h.room.id);
    expect(messages.map((m) => m.authorKind)).toEqual(["user", "agent"]);
    const reply = messages[1]!;
    expect(reply.content).toBe("方案已定：先拆接口");
    expect(reply.authorAgentId).toBe(h.lead.id);
    expect(reply.taskId).toBe(posted.tasks[0]!.id);
    expect(h.store.getTask(posted.tasks[0]!.id)?.status).toBe("succeeded");
    h.store.close();
  });

  it("is idempotent: replaying the same Task cannot make the agent speak twice", async () => {
    const h = setup("只说一次");
    const posted = h.trigger("请 @架构师 定方案");
    const taskId = posted.tasks[0]!.id;
    expect(await h.worker.runOnce()).toBe(true);
    // Crash replay: the same Task is re-queued and runs again as a new Attempt.
    // Bound through `prepare` — `exec` takes no parameters and would silently
    // match nothing, making the test prove the wrong thing.
    h.store.db.prepare(
      "UPDATE tasks SET status='queued', batch_attempts=0, available_at=200, active_attempt_id=NULL WHERE id=?",
    ).run(taskId);
    expect(await h.worker.runOnce()).toBe(true);

    const replies = h.rooms.listMessages(h.room.id).filter((m) => m.authorKind === "agent");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.taskId).toBe(posted.tasks[0]!.id);
    expect(h.rooms.countMessages(h.room.id)).toBe(2);
    expect(h.store.getAttempts(posted.tasks[0]!.id).map((a) => a.sequence)).toEqual([1, 2]);
    h.store.close();
  });

  it("feeds the previous agent reply into the next trigger's history", async () => {
    const h = setup("架构师说：先拆接口");
    h.trigger("请 @架构师 定方案");
    expect(await h.worker.runOnce()).toBe(true);

    // QA is triggered afterwards and must see what the architect actually said.
    const second = h.trigger("请 @QA 复核");
    expect(await h.worker.runOnce()).toBe(true);
    const prompt = h.store.getTask(second.tasks[0]!.id)!.prompt;
    expect(prompt).toContain("[2] 架构师: 架构师说：先拆接口");
    expect(prompt).toContain("[3] 用户: 请 @QA 复核");
    // Q31: history is re-injected, so the same reply is never handed over twice.
    expect(prompt.split("架构师说：先拆接口").length - 1).toBe(1);
    h.store.close();
  });

  it("leaves the stream alone for a task without a room", async () => {
    const h = setup();
    h.store.createTask(
      { tenantId: "t", projectId: "p", memberId: "loose", workspacePath: "/tmp", prompt: "solo work" }, 200,
    );
    expect(await h.worker.runOnce()).toBe(true);
    expect(await h.worker.runOnce()).toBe(false);
    expect(h.rooms.listMessages(h.room.id)).toEqual([]);
    h.store.close();
  });

  it("runs group tasks normally when no RoomStore is wired", async () => {
    const h = setup();
    const detached = createDurableWorker(h.store, { workerId: "w2", adapterFor: () => adapterFor("无房间可写") });
    h.trigger("请 @架构师 定方案");
    expect(await detached.runOnce()).toBe(true);
    expect(h.store.listTasks()[0]?.status).toBe("succeeded");
    expect(h.rooms.listMessages(h.room.id).map((m) => m.authorKind)).toEqual(["user"]);
    h.store.close();
  });

  it("refuses a RoomStore living on another database handle", () => {
    const store = new ExecutionStore(":memory:");
    const other = new RoomStore(new DatabaseSync(":memory:"));
    expect(() => createDurableWorker(store, { adapterFor: () => adapterFor("x"), rooms: other }))
      .toThrow(/one database handle/);
    other.close();
    store.close();
  });
});
