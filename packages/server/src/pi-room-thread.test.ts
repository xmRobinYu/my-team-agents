import { describe, expect, it } from "vitest";
import { createPiHttpClient, projectPiThreadMessages } from "@assistant-ui/react-pi";
import type { PiAgentMessage, PiThreadSnapshot } from "@assistant-ui/react-pi";
import type { TaskRecord } from "@my-team-agents/orchestrator";
import {
  ROOM_AGENT_CUSTOM_TYPE,
  ROOM_SYSTEM_CUSTOM_TYPE,
  roomMessageDetails,
  roomMessageToPiMessage,
  roomThreadStatus,
  roomToMessages,
  roomToSnapshot,
  roomToThreadMetadata,
  type RoomAgentView,
  type RoomMessageView,
  type RoomThreadInput,
  type RoomView,
} from "./pi-room-thread.js";
import { parseRoomThreadId, roomThreadId, threadKind } from "./pi-thread-id.js";

/**
 * I7's projection layer, asserted twice over:
 *  1. the shape the projection produces, and
 *  2. that the REAL react-pi client accepts it. The client's validators DROP a
 *     message whose field types are wrong and report nothing, so "the route
 *     returned 200" proves nothing about the transcript reaching the UI — this
 *     suite runs the actual client and the actual UI projector.
 */

const room: RoomView = {
  id: "room-abc", projectId: "p", name: "研发群", description: "", createdAt: 100,
};

const arch: RoomAgentView = {
  id: "agent-arch", name: "高见远", role: "架构师",
  emoji: "🏗️", color: "#ff0000", isCoordinator: false,
};
const lead: RoomAgentView = {
  id: "agent-lead", name: "齐活林", role: "交付总监",
  emoji: "👑", color: null, isCoordinator: true,
};
const agents = [arch, lead];

const message = (over: Partial<RoomMessageView>): RoomMessageView => ({
  id: `msg-${over.seq ?? 1}`,
  roomId: room.id,
  seq: 1,
  authorKind: "user",
  authorAgentId: null,
  content: "内容",
  taskId: null,
  createdAt: 200,
  ...over,
});

const task = (over: Partial<TaskRecord>): TaskRecord => ({
  id: "task-1", chainId: "chain-1", depth: 0, batch: 1, batchAttempts: 0,
  fencingToken: 0, status: "queued", activeAttemptId: null, availableAt: 100,
  result: null, error: null, createdAt: 100, updatedAt: 100,
  tenantId: "t", projectId: "p", memberId: arch.id, workspacePath: "/ws", prompt: "p",
  groupId: room.id,
  ...over,
});

const input = (over: Partial<RoomThreadInput> = {}): RoomThreadInput => ({
  threadId: roomThreadId(room.id),
  room,
  agents,
  messages: [],
  tasks: [],
  workspacePath: "/ws",
  ...over,
});

describe("thread id namespace", () => {
  it("separates room threads from Task threads by the id itself", () => {
    expect(roomThreadId("room-abc")).toBe("room:room-abc");
    expect(parseRoomThreadId("room:room-abc")).toBe("room-abc");
    expect(threadKind("room:room-abc")).toBe("room");
    // A Task id keeps its raw form — the P7a wire contract, unchanged.
    expect(threadKind("task-9f2c")).toBe("task");
    expect(parseRoomThreadId("task-9f2c")).toBeNull();
    // The separator is not a character either store emits, so neither scheme can
    // forge the other's namespace; an un-prefixed room id is a Task id as far as
    // routing is concerned, which is why the prefix is the only accepted form.
    expect(threadKind("room-abc")).toBe("task");
    expect(parseRoomThreadId("room:")).toBeNull();
    expect(threadKind("")).toBe("task");
  });
});

describe("group thread status", () => {
  it("is running while any room Task is active, idle when none are", () => {
    expect(roomThreadStatus([])).toBe("idle");
    for (const status of ["queued", "running", "retry_wait", "cancelling"] as const) {
      expect(roomThreadStatus([task({ status })])).toBe("running");
    }
    expect(roomThreadStatus([task({ status: "succeeded" }), task({ id: "task-2", status: "succeeded" })]))
      .toBe("idle");
  });

  it("reports failed only from a real failed/blocked Task", () => {
    expect(roomThreadStatus([task({ status: "failed", error: "boom" })])).toBe("failed");
    expect(roomThreadStatus([task({ status: "blocked" })])).toBe("failed");
    // A cancelled round is a user decision, not a failure.
    expect(roomThreadStatus([task({ status: "cancelled" })])).toBe("idle");
    // The most recently updated Task decides when a round mixed outcomes.
    expect(roomThreadStatus([
      task({ id: "task-old", status: "failed", updatedAt: 100 }),
      task({ id: "task-new", status: "succeeded", updatedAt: 200 }),
    ])).toBe("idle");
    // Reversed array order, same answer: the decision is by update time, not by
    // the order the store happened to return.
    expect(roomThreadStatus([
      task({ id: "task-old", status: "failed", updatedAt: 100 }),
      task({ id: "task-new", status: "succeeded", updatedAt: 200 }),
    ])).toBe("idle");
    expect(roomThreadStatus([
      task({ id: "task-old", status: "succeeded", updatedAt: 100 }),
      task({ id: "task-new", status: "failed", updatedAt: 200, error: "boom" }),
    ])).toBe("failed");
  });

  it("participates in no round/chain computation", () => {
    // The predicate reads Task statuses only: nothing in `RoomState` (rounds,
    // chain, terminated) can reach it, because none is even a parameter.
    expect(roomThreadStatus.length).toBe(1);
    expect(roomThreadStatus([task({ status: "succeeded" })])).toBe("idle");
  });
});

describe("author identity in the transcript", () => {
  it("keeps a user message native and gives every other author a custom message", () => {
    const user = roomMessageToPiMessage(message({ seq: 1, authorKind: "user" }), agents);
    expect(user.role).toBe("user");

    const agent = roomMessageToPiMessage(
      message({ seq: 2, authorKind: "agent", authorAgentId: arch.id, content: "方案如下", taskId: "task-1" }),
      agents,
    );
    expect(agent.role).toBe("custom");
    if (agent.role === "custom") {
      expect(agent.customType).toBe(ROOM_AGENT_CUSTOM_TYPE);
      expect(agent.display).toBe(true);
      expect(agent.content).toEqual([{ type: "text", text: "方案如下" }]);
      expect(agent.details).toMatchObject({
        authorKind: "agent", agentId: arch.id, name: "高见远", role: "架构师",
        emoji: "🏗️", color: "#ff0000", isCoordinator: false, taskId: "task-1", seq: 2,
      });
    }

    const system = roomMessageToPiMessage(
      message({ seq: 3, authorKind: "system", content: "【流程守卫·循环】" }),
      agents,
    );
    expect(system.role).toBe("custom");
    if (system.role === "custom") {
      expect(system.customType).toBe(ROOM_SYSTEM_CUSTOM_TYPE);
      // A system notice must not masquerade as an agent: no agent identity.
      expect(system.details).toMatchObject({ authorKind: "system", agentId: null, name: "系统" });
    }
  });

  it("never smuggles the author into the message text", () => {
    const agent = roomMessageToPiMessage(
      message({ authorKind: "agent", authorAgentId: arch.id, content: "我同意" }), agents,
    );
    expect(JSON.stringify(agent)).not.toContain("高见远：");
    if (agent.role === "custom") {
      expect(agent.content).toEqual([{ type: "text", text: "我同意" }]);
    }
  });

  it("keeps the raw agent id when the persona is gone, instead of misattributing", () => {
    const details = roomMessageDetails(
      message({ authorKind: "agent", authorAgentId: "agent-gone", content: "x" }), agents,
    );
    expect(details).toMatchObject({ agentId: "agent-gone", name: "agent-gone", isCoordinator: false });
    // Never "系统", never an empty name: the stream must not be rewritten.
    expect(details.name).not.toBe("系统");
    expect(details.authorKind).toBe("agent");
  });

  it("emits string/number-typed identity fields (the client cannot catch a wrong type)", () => {
    // `details` is opaque to react-pi's validators: a number where a string
    // belongs would reach the UI broken and unreported, so the projection is the
    // only place that can guarantee it.
    const details = roomMessageDetails(
      message({ seq: 4, authorKind: "agent", authorAgentId: lead.id }), agents,
    );
    expect(typeof details.name).toBe("string");
    expect(typeof details.role).toBe("string");
    expect(typeof details.authorKind).toBe("string");
    expect(typeof details.seq).toBe("number");
    // A persona without a colour stays null — never "" or undefined, which the
    // UI would have to special-case when it picks an avatar tint.
    expect(details.color).toBeNull();
    expect(details.emoji).toBe("👑");
  });

  it("orders the transcript by seq, not by timestamp", () => {
    // Deliberately out of order, with timestamps INVERTED against seq.
    const messages = [
      message({ seq: 3, createdAt: 10, authorKind: "system", content: "三" }),
      message({ seq: 1, createdAt: 999, content: "一" }),
      message({ seq: 2, createdAt: 500, authorKind: "agent", authorAgentId: lead.id, content: "二" }),
    ];
    const projected = roomToMessages(messages, agents);
    expect(projected.map((m) => m.role)).toEqual(["user", "custom", "custom"]);
    if (projected[1]!.role === "custom") {
      expect(projected[1]!.content).toEqual([{ type: "text", text: "二" }]);
      expect(projected[1]!.details).toMatchObject({ name: "齐活林" });
    }
    if (projected[2]!.role === "custom") expect(projected[2]!.customType).toBe(ROOM_SYSTEM_CUSTOM_TYPE);
  });
});

describe("group thread metadata", () => {
  it("namespaces the id, counts messages and keeps updatedAt honest", () => {
    const meta = roomToThreadMetadata(input({
      messages: [message({ seq: 1 }), message({ seq: 2, createdAt: 700 })],
      tasks: [task({ status: "running", activeAttemptId: "attempt-9", updatedAt: 300 })],
      stateUpdatedAt: 400,
    }));
    expect(meta.id).toBe("room:room-abc");
    expect(meta.title).toBe("研发群");
    expect(meta.status).toBe("running");
    expect(meta.runningRunId).toBe("attempt-9");
    expect(meta.messageCount).toBe(2);
    expect(meta.archived).toBe(false);
    expect(meta.createdAt).toBe(new Date(100).toISOString());
    // The latest of room creation, message time, Task update and flow-state time.
    expect(meta.updatedAt).toBe(new Date(700).toISOString());
    // No invented fields: `kind` is NOT part of `PiThreadMetadata`, so the
    // namespace lives in the id alone — the truth source for the UI.
    expect(Object.keys(meta).sort()).toEqual([
      "archived", "createdAt", "id", "messageCount", "runningRunId", "status",
      "title", "updatedAt", "workspacePath",
    ]);
  });

  it("drops runningRunId when nothing is in flight", () => {
    const meta = roomToThreadMetadata(input({ tasks: [task({ status: "succeeded" })] }));
    expect("runningRunId" in meta).toBe(false);
  });

  it("carries the last failure as lastError, and nothing when there was none", () => {
    const failed = roomToSnapshot(input({ tasks: [task({ status: "failed", error: "模型超时" })] }));
    expect(failed.lastError).toBe("模型超时");
    expect(roomToSnapshot(input({ tasks: [task({ status: "succeeded" })] })).lastError).toBeUndefined();
    // "Newest first" is asserted, not assumed: `lastError` is one slot, so two
    // failures must report the later one or the UI learns about a stale error.
    const two = roomToSnapshot(input({
      tasks: [
        task({ id: "task-old", status: "failed", error: "旧错误", updatedAt: 100 }),
        task({ id: "task-new", status: "failed", error: "新错误", updatedAt: 200 }),
      ],
    }));
    expect(two.lastError).toBe("新错误");
  });
});

describe("react-pi accepts the group transcript (no silent drop)", () => {
  const snapshot = roomToSnapshot(input({
    messages: [
      message({ seq: 1, authorKind: "user", content: "@高见远 定方案" }),
      message({ seq: 2, authorKind: "agent", authorAgentId: arch.id, content: "分层架构", taskId: "task-1" }),
      message({ seq: 3, authorKind: "system", content: "【流程守卫·轮次上限】齐活林：已达上限" }),
    ],
    tasks: [task({ status: "succeeded" })],
    seq: 7,
  }));

  const clientFor = (body: unknown) => createPiHttpClient({
    fetchImpl: (async () => new Response(JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch,
  });

  it("survives createPiHttpClient's snapshot validation with all three messages", async () => {
    const read = await clientFor(snapshot).getThread(roomThreadId(room.id));
    expect(read.messages).toHaveLength(3);
    expect(read.metadata.id).toBe("room:room-abc");
    expect(read.metadata.status).toBe("idle");
    expect(read.metadata.messageCount).toBe(3);
  });

  it("pins the display trap: false passes validation yet renders nothing", async () => {
    // Verified against react-pi 0.0.32: `isRenderableTranscriptMessage`
    //    (client/validation.ts:270-303) does NOT
    // check `display`, while the UI projector skips the message when it is false.
    // So emitting `display: true` is load-bearing, not decoration — a message
    // that validates is not automatically a message that renders.
    const hidden = structuredClone(snapshot) as PiThreadSnapshot;
    if (hidden.messages[1]!.role === "custom") hidden.messages[1]!.display = false;
    const project = (messages: readonly PiAgentMessage[]) => projectPiThreadMessages({
      messages, toolExecutions: {}, runStatus: "idle", hostUiRequests: [],
    });
    expect(project(snapshot.messages)).toHaveLength(3);
    expect(project(hidden.messages)).toHaveLength(2);
    // ...and the client is perfectly happy with the invisible one.
    await expect(clientFor(hidden).getThread(roomThreadId(room.id))).resolves.toHaveProperty("messages");
  });

  it("projects author identity into the assistant-ui message parts", () => {
    const projected = projectPiThreadMessages({
      messages: snapshot.messages,
      toolExecutions: {},
      runStatus: "idle",
      hostUiRequests: [],
    });
    expect(projected).toHaveLength(3);
    const dataParts = projected.map((m) =>
      (m.content as Array<{ type: string; name?: string; data?: unknown }>)
        .find((part) => part.type === "data" && part.name === "pi-custom-message"));
    // The user turn stays a plain user message — no data part to confuse it with.
    expect(dataParts[0]).toBeUndefined();
    expect(dataParts[1]).toMatchObject({
      data: {
        customType: ROOM_AGENT_CUSTOM_TYPE,
        details: { name: "高见远", emoji: "🏗️", color: "#ff0000", authorKind: "agent" },
      },
    });
    expect(dataParts[2]).toMatchObject({
      data: { customType: ROOM_SYSTEM_CUSTOM_TYPE, details: { authorKind: "system" } },
    });
    const texts = projected.map((m) =>
      (m.content as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === "text").map((p) => p.text).join(""));
    expect(texts[0]).toBe("@高见远 定方案");
    expect(texts[1]).toBe("分层架构");
    expect(texts[2]).toContain("轮次上限");
  });
});
