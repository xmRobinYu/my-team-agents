import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ChatRoom, RoomAgent } from "@my-team-agents/domain";
import type { CanonicalEvent, RunHandle, RuntimeAdapter } from "@my-team-agents/runtime-core";
import { ExecutionStore, type TaskRecord } from "./execution-store.js";
import { RoomStore } from "./room-store.js";
import { createDurableWorker } from "./durable-worker.js";
import { postRoomMessage, RoomTriggerError } from "./room-trigger.js";
import { importTemplatePackage } from "./template-import.js";

/**
 * I5 — the SECONDARY dispatch path (Q34 / AC3.2) and dedup by target
 * (Q35 / AC3.3).
 *
 * One agent reply can dispatch through both paths at once: a `handoff_to` tool
 * call (primary) and `@name` text inside the reply (secondary). Every assertion
 * below is about an observable effect — a child Task row, an outbox row, a system
 * message, a persisted round count — never about an internal list, so each of the
 * four traps has a case that goes red when its fix is reverted:
 *  - dedup moved behind `evaluateTrigger`   -> a false LOOP appears (AC3.3);
 *  - dedup removed                          -> two children for one target;
 *  - a random/timestamp synthetic source id -> a replay queues a second child;
 *  - `agentDir`/`model` dropped from a child -> the persona assertions fail.
 *
 * Multi-turn chains are driven by DRAINING the worker rather than by posting more
 * user messages: a user message resets the turn's flow state (AC4.2), so a second
 * `postRoomMessage` would erase exactly the chain these tests are building.
 */

const summary = (text: string) => JSON.stringify({
  outcome: "success", summary: text, artifacts: [], remainingRisks: [],
});

/**
 * One scripted runtime turn: an optional `handoff_to` tool call plus the reply the
 * room will read. `handoff_to` carries a real runtime tool-call id; the `@` path
 * has none, which is exactly why the worker must synthesise one.
 */
const adapterFor = (options: {
  reply: string;
  handoffTo?: string[];
  reason?: string;
  calls?: Array<{ toolCallId: string; toMemberIds: string[]; reason: string; workPackage?: string }>;
}): RuntimeAdapter => ({
  kind: "pi",
  capabilities: {
    streaming: true, steer: true, cancel: true, approval: "none", sandbox: "none",
    workspacePerRun: true, agentDirPerRun: true, usageAttribution: "message",
    costCap: false, sessionResume: false,
  },
  async start(spec): Promise<RunHandle> {
    const events: CanonicalEvent[] = [];
    const calls = options.calls ?? (options.handoffTo && options.handoffTo.length > 0
      ? [{
        toolCallId: `call-${spec.runId}`,
        toMemberIds: options.handoffTo,
        reason: options.reason ?? "handoff_to 的理由",
      }]
      : []);
    for (const call of calls) {
      events.push({
        type: "tool_execution_start", runId: spec.runId, timestamp: "",
        toolCallId: call.toolCallId, toolName: "handoff_to",
        args: { toMemberIds: call.toMemberIds, reason: call.reason, ...(call.workPackage ? { workPackage: call.workPackage } : {}) },
      });
      events.push({
        type: "tool_execution_end", runId: spec.runId, timestamp: "",
        toolCallId: call.toolCallId, toolName: "handoff_to",
      });
    }
    events.push({ type: "message_end", runId: spec.runId, timestamp: "", text: summary(options.reply) });
    return {
      runId: spec.runId,
      events: (async function* () { yield* events; })(),
      settled: Promise.resolve({ runId: spec.runId, status: "completed" }),
      async cancel() {},
    };
  },
});

interface Setup {
  store: ExecutionStore;
  rooms: RoomStore;
  room: ChatRoom;
  coordinator: RoomAgent;
  arch: RoomAgent;
  qa: RoomAgent;
  /** Script what `speaker` will answer with, optionally including a `handoff_to` call. */
  say(speaker: RoomAgent, reply: string, handoffTo?: string[], reason?: string): void;
  /** Script any member id — used for a Task that has no RoomAgent at all. */
  sayText(memberId: string, reply: string): void;
  /** Same, but with raw control over the declared tool calls (several calls in one run).
   *  Accepts a member id so a Task with no RoomAgent row can be scripted too. */
  sayCalls(speaker: RoomAgent | string, reply: string, calls: Array<{
    toolCallId: string; toMemberIds: string[]; reason: string; workPackage?: string;
  }>): void;
  /** One user message; returns the Task it queued for `speaker`. */
  trigger(speaker: RoomAgent, extra?: string): TaskRecord;
  /** Run exactly one claimed Task. */
  once(): Promise<boolean>;
  children(parent: TaskRecord): TaskRecord[];
  requeue(task: TaskRecord): void;
  close(): void;
}

/**
 * A room where each member has its OWN persona dir and two of them a model, so
 * "did the child inherit the TARGET's persona?" is distinguishable from "it
 * inherited the parent's" and from "it inherited nothing" (trap C).
 */
const setup = (options: { maxRounds?: number; withRoomStore?: boolean } = {}): Setup => {
  const store = new ExecutionStore(":memory:");
  const rooms = new RoomStore(store.db);
  const room = rooms.createRoom({
    projectId: "proj-1", name: "研发群",
    ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
  }, 100);
  const coordinator = rooms.addAgent({
    roomId: room.id, name: "齐活林", role: "交付总监", prompt: "You coordinate.",
    agentDir: "/persona/lead", model: "anthropic/claude-opus", isCoordinator: true,
  }, 100);
  const arch = rooms.addAgent({
    roomId: room.id, name: "架构师", role: "架构", prompt: "You design.",
    agentDir: "/persona/arch", model: "openai/gpt-5",
  }, 101);
  const qa = rooms.addAgent({
    roomId: room.id, name: "QA", role: "测试", prompt: "You test.", agentDir: "/persona/qa",
  }, 102);

  const scripts = new Map<string, Parameters<typeof adapterFor>[0]>();
  const worker = createDurableWorker(store, {
    workerId: "w1",
    ...(options.withRoomStore === false ? {} : { rooms }),
    now: () => 300,
    adapterFor: (memberId) => adapterFor(scripts.get(memberId) ?? { reply: `${memberId} 收到` }),
  });

  const children = (parent: TaskRecord) =>
    store.listTasks().filter((task) => task.parentTaskId === parent.id);

  return {
    store, rooms, room, coordinator, arch, qa, children,
    say: (speaker, reply, handoffTo, reason) => scripts.set(speaker.id, {
      reply, ...(handoffTo ? { handoffTo } : {}), ...(reason ? { reason } : {}),
    }),
    sayText: (memberId, reply) => scripts.set(memberId, { reply }),
    sayCalls: (speaker, reply, calls) => scripts.set(
      typeof speaker === "string" ? speaker : speaker.id, { reply, calls },
    ),
    trigger: (speaker, extra = "定方案") => {
      const posted = postRoomMessage(rooms, store, {
        roomId: room.id, content: `请 @${speaker.name} ${extra}`,
        tenantId: "default", projectId: "proj-1", workspacePath: "/workspace/proj-1", now: 200,
      });
      expect(posted.tasks, `@${speaker.name} 应刚被入队`).toHaveLength(1);
      return store.getTask(posted.tasks[0]!.id)!;
    },
    once: () => worker.runOnce(),
    requeue: (task) => {
      // Crash replay: the SAME Task, exactly as `room-reply.test.ts` does it.
      store.db.prepare(
        "UPDATE tasks SET status='queued', batch_attempts=0, available_at=200, active_attempt_id=NULL WHERE id=?",
      ).run(task.id);
    },
    close: () => { rooms.close(); store.close(); },
  };
};

const systemMessages = (rooms: RoomStore, roomId: string) =>
  rooms.listMessages(roomId).filter((m) => m.authorKind === "system").map((m) => m.content);

const loopNotes = (rooms: RoomStore, roomId: string) =>
  systemMessages(rooms, roomId).filter((m) => m.includes("循环"));

const mentionSource = (parent: TaskRecord) => `mention:${parent.id}`;

describe("AC3.2 — the `@name` secondary path dispatches", () => {
  it("a reply that @-mentions a member queues exactly one child for that member", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "接口先定，具体用例请 @QA 补。");
    expect(await h.once()).toBe(true);

    const children = h.children(parent);
    expect(children.map((t) => t.memberId), "AC3.2：文本 @ 也能触发").toEqual([h.qa.id]);
    expect(children[0]?.status).toBe("queued");
    expect(children[0]?.depth).toBe(1);
    expect(children[0]?.groupId).toBe(h.room.id);
    // The mention is a real trigger: a round is charged in SQLite, so the
    // secondary path cannot quietly outrun the round budget.
    expect(h.rooms.getState(h.room.id)).toMatchObject({
      roundCount: 2, chain: [h.arch.id, h.qa.id],
    });
    // The synthetic source id is what the outbox row is keyed by (trap B).
    expect(h.store.getOutbox().filter((r) => r.source_tool_call_id === mentionSource(parent))).toHaveLength(1);
    h.close();
  });

  it("the mention child carries the TARGET's agentDir and model, not the workspace (Q38 / trap C)", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "请 @齐活林 汇总收尾。");
    await h.once();
    const child = h.children(parent)[0]!;
    expect(child.agentDir, "人格目录必须跟着目标走，不能退回 workspace").toBe("/persona/lead");
    expect(child.model).toBe("anthropic/claude-opus");
    // …while the shared project workspace stays separate (Q38: agentDir IS the cwd).
    expect(child.workspacePath).toBe("/workspace/proj-1");
    h.close();
  });

  it("the primary path carries the same persona fields (trap C is not `@`-only)", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "交给 QA 复核。", [h.qa.id]);
    await h.once();
    const child = h.children(parent)[0]!;
    expect(child.memberId).toBe(h.qa.id);
    expect(child.agentDir, "handoff_to 子 Task 也不能丢人格目录").toBe("/persona/qa");
    h.close();
  });

  it("the mention child is injected with the shared room history, including the reply that mentioned it (I4)", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "接口先定，具体用例请 @QA 补。");
    await h.once();
    const prompt = h.children(parent)[0]!.prompt;
    expect(prompt).toContain("# 群聊记录");
    expect(prompt, "子 Task 用自己的角色 prompt").toContain("You test.");
    // The reply carrying the `@` has not reached the stream yet when the child's
    // prompt is built (it commits in the same transaction, later), so it must be
    // appended by hand — otherwise QA would be triggered by a message it cannot read.
    expect(prompt).toContain("接口先定，具体用例请 @QA 补。");
    expect(prompt).toContain("架构师");
  });

  it("a Task with no `groupId` never reads prose for mentions — the pure P6 path is byte-identical", async () => {
    const h = setup();
    // The trap here would be "collect mentions whenever a RoomStore is wired": a
    // roomless Task whose text names a room member would then start dispatching.
    // So the reply DOES contain @QA, and the room roster is reachable.
    const solo = h.store.createTask({
      tenantId: "t", projectId: "p", memberId: "solo", workspacePath: "/tmp", prompt: "solo work",
    }, 100);
    h.sayText("solo", `这个可以找 @${h.qa.name} 看一下。`);
    const before = {
      tasks: h.store.listTasks().length,
      rounds: h.rooms.getState(h.room.id).roundCount,
      messages: h.rooms.countMessages(h.room.id),
    };
    expect(await h.once(), "先跑 solo Task").toBe(true);
    expect(h.children(solo), "无群 = 无派发").toEqual([]);
    expect(h.store.listTasks().filter((t) => t.parentTaskId).length).toBe(0);
    expect(h.store.getOutbox()).toHaveLength(0);
    // And no room side effects at all: no round, no system note, no reply.
    expect(h.rooms.getState(h.room.id).roundCount).toBe(before.rounds);
    expect(h.rooms.countMessages(h.room.id)).toBe(before.messages);
    expect(h.store.listTasks()).toHaveLength(before.tasks);
    expect(h.store.getTask(solo.id)?.status).toBe("succeeded");
    h.close();
  });

  it("a non-group Task keeps P6's existing behaviour: two calls, two children", async () => {
    const h = setup();
    // Q35's dedup is the group-chat rule. A roomless Task has only one dispatch
    // path, so folding its duplicate targets would silently change what the P6
    // spine already does — this pins that it does NOT.
    const solo = h.store.createTask({
      tenantId: "t", projectId: "p", memberId: "solo", workspacePath: "/tmp", prompt: "solo work",
    }, 100);
    h.sayCalls("solo", "两次都叫 b。", [
      { toolCallId: "call-a", toMemberIds: ["b"], reason: "first" },
      { toolCallId: "call-b", toMemberIds: ["b"], reason: "second" },
    ]);
    expect(await h.once()).toBe(true);
    expect(h.children(solo), "无群 Task 不去重，与改动前一致").toHaveLength(2);
    expect(h.store.getOutbox(solo.id)).toHaveLength(2);
    expect(h.store.getChain(solo.chainId).budgetUsed).toBe(2);
    h.close();
  });
});

describe("AC3.3 — dedup by target across the two paths", () => {
  it("handoff_to and @ on the SAME target: one child, the handoff reason wins, and NO loop message", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "我同时 @QA 一下。", [h.qa.id], "请 QA 出回归用例");
    expect(await h.once()).toBe(true);

    const children = h.children(parent);
    expect(children, "AC3.3/Q35：同一目标最多入队一次").toHaveLength(1);
    expect(children[0]?.memberId).toBe(h.qa.id);
    // Exactly one outbox row, keyed by the primary path's tool call, and the
    // surviving reason is `handoff_to`'s — precedence, not accident of ordering.
    const rows = h.store.getOutbox(parent.id);
    expect(rows, "只有一条 outbox").toHaveLength(1);
    // The surviving row is the PRIMARY one: its anchor is the runtime's tool-call
    // id, not the synthesised `mention:` id, and its reason is `handoff_to`'s.
    expect(String(rows[0]!.source_tool_call_id), "主路径优先").not.toBe(mentionSource(parent));
    expect(String(rows[0]!.source_tool_call_id)).toMatch(/^call-/);
    expect(String(rows[0]!.reason)).toContain("请 QA 出回归用例");
    // One round, not two: one target = one turn regardless of how many paths hit it.
    expect(h.rooms.getState(h.room.id).roundCount).toBe(2);
    // Nothing in the stream claims a loop — dedup ran BEFORE `evaluateTrigger`, so
    // LOOP keeps meaning only a real A→B→A (trap A).
    expect(loopNotes(h.rooms, h.room.id), "去重不得伪装成 LOOP").toEqual([]);
    expect(systemMessages(h.rooms, h.room.id)).toEqual([]);
    h.close();
  });

  it("handoff_to and @ on DIFFERENT targets queue both", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "工具交给 QA， prose 请 @齐活林 收尾。", [h.qa.id]);
    await h.once();
    expect(h.children(parent).map((t) => t.memberId)).toEqual([h.qa.id, h.coordinator.id]);
    expect(h.rooms.getState(h.room.id).roundCount).toBe(3);
    expect(loopNotes(h.rooms, h.room.id)).toEqual([]);
    h.close();
  });

  it("one reply naming the same agent twice in prose still dispatches once", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "@QA 先看，然后 @QA 再复核一遍。");
    await h.once();
    expect(h.children(parent)).toHaveLength(1);
    expect(h.rooms.getState(h.room.id).roundCount).toBe(2);
    expect(loopNotes(h.rooms, h.room.id)).toEqual([]);
    h.close();
  });

  it("two handoff_to calls for one target also collapse, keeping the first reason", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.sayCalls(h.arch, "两次都交给 QA。", [
      { toolCallId: "call-first", toMemberIds: [h.qa.id], reason: "第一次的理由" },
      { toolCallId: "call-second", toMemberIds: [h.qa.id], reason: "第二次的理由" },
    ]);
    await h.once();
    expect(h.children(parent), "去重按目标，不按 tool call").toHaveLength(1);
    const rows = h.store.getOutbox(parent.id);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.source_tool_call_id)).toBe("call-first");
    expect(String(rows[0]!.reason)).toBe("第一次的理由");
    expect(h.rooms.getState(h.room.id).roundCount).toBe(2);
    expect(loopNotes(h.rooms, h.room.id)).toEqual([]);
    h.close();
  });
});

describe("`@` in agent prose is parsed leniently, unlike a user message", () => {
  it("@不存在的人 → the Task still succeeds, the name is recorded in the stream, nothing dispatches", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "这块 @老王 最有经验，可以问问他。");
    expect(await h.once()).toBe(true);
    expect(h.store.getTask(parent.id)?.status, "解析不出名字不能让整轮工作作废").toBe("succeeded");
    expect(h.children(parent)).toEqual([]);
    const notes = systemMessages(h.rooms, h.room.id);
    expect(notes, "也不能静默丢弃").toHaveLength(1);
    expect(notes[0]).toContain("提及解析");
    expect(notes[0]).toContain("老王");
    // No round spent on a name that dispatched nothing.
    expect(h.rooms.getState(h.room.id).roundCount).toBe(1);
    h.close();
  });

  it("@重名 → not dispatched, Task still succeeds, ambiguity reported", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    // A second 架构师. For a USER message this is a 4xx (AC2.5); for an agent's own
    // prose it must be "do not dispatch" — never a coin flip, never a failed run.
    const twin = h.rooms.addAgent({
      roomId: h.room.id, name: "架构师", role: "架构", prompt: "clone", agentDir: "/persona/arch2",
    }, 150);
    h.say(h.arch, "这处还是让 @架构师 定吧。");
    expect(await h.once()).toBe(true);
    expect(h.store.getTask(parent.id)?.status).toBe("succeeded");
    expect(h.children(parent).map((t) => t.memberId), "重名无法确定指谁 → 不派发").toEqual([]);
    const notes = systemMessages(h.rooms, h.room.id);
    expect(notes.some((m) => m.includes("重名") && m.includes("架构师"))).toBe(true);
    expect(h.rooms.getState(h.room.id).roundCount).toBe(1);
    expect(twin.roomId).toBe(h.room.id);
    h.close();
  });

  it("unknown names are reported once and do not block the mention that did resolve", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "@老王 看过，@老王 也提过，剩下 @QA 收尾。");
    await h.once();
    expect(h.children(parent).map((t) => t.memberId)).toEqual([h.qa.id]);
    const notes = systemMessages(h.rooms, h.room.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("老王");
    h.close();
  });
});

describe("the secondary path cannot bypass the guards", () => {
  it("AC4.1 via `@`: A→B→A is still refused as LOOP, with a message and no child", async () => {
    const h = setup();
    const archTurn = h.trigger(h.arch);
    h.say(h.arch, "用例请 @QA 补。");
    expect(await h.once(), "架构师回合派发 QA").toBe(true);
    expect(h.children(archTurn)).toHaveLength(1);

    // QA's turn is DRAINED (not re-triggered by a user message): a new user message
    // would reset the chain and hide the loop.
    h.say(h.qa, "看完了，交回 @架构师。");
    expect(await h.once(), "QA 的 Task 被领取").toBe(true);

    const loops = loopNotes(h.rooms, h.room.id);
    expect(loops, "@ 路径必须与 handoff_to 受同一循环守卫约束").toHaveLength(1);
    expect(loops[0]).toContain("架构师");
    expect(h.rooms.getState(h.room.id).chain).toEqual([h.arch.id, h.qa.id]);
    expect(h.rooms.getState(h.room.id).roundCount).toBe(2);
    expect(h.store.listTasks().filter((t) => t.memberId === h.arch.id)).toHaveLength(1);
    h.close();
  });

  it("AC4.1: an agent that @-mentions ITSELF is refused as LOOP, and the run still succeeds", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "我再 @架构师 确认一遍。");
    expect(await h.once()).toBe(true);
    expect(h.store.getTask(parent.id)?.status, "自引用是循环，不是运行时失败").toBe("succeeded");
    expect(h.children(parent)).toEqual([]);
    expect(loopNotes(h.rooms, h.room.id)).toHaveLength(1);
    // The turn's chain did not grow: a refused mention is not a round.
    expect(h.rooms.getState(h.room.id).chain).toEqual([h.arch.id]);
    h.close();
  });

  it("AC5.2 via `@`: a spent round budget blocks the mention dispatch", async () => {
    const h = setup({ maxRounds: 1 });
    const parent = h.trigger(h.arch);
    // The user mention already spent the only round of this turn.
    h.say(h.arch, "用例请 @QA 补。");
    await h.once();
    expect(h.children(parent), "超限后 `@` 不能派发").toEqual([]);
    expect(h.rooms.getState(h.room.id).roundCount).toBe(1);
    expect(systemMessages(h.rooms, h.room.id).some((m) => m.includes("轮次上限"))).toBe(true);
    h.close();
  });

  it("AC5.1 via `@`: a mention landing exactly on the cap queues the coordinator's forced wrap-up", async () => {
    const h = setup({ maxRounds: 2 });
    const parent = h.trigger(h.arch);
    h.say(h.arch, "用例请 @QA 补。");
    await h.once();
    expect(h.children(parent)).toHaveLength(1);
    expect(h.rooms.getState(h.room.id).roundCount).toBe(2);
    const wrapUp = h.store.listTasks().filter((t) => (t.idempotencyKey ?? "").startsWith("wrapup:"));
    expect(wrapUp, "次路径同样触发强制收尾").toHaveLength(1);
    expect(wrapUp[0]?.memberId).toBe(h.coordinator.id);
    h.close();
  });

  it("AC3.4 via `@`: an exhausted chain budget refuses the mention, and the Task still succeeds", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    // Burn the chain budget the way a long relay would: 20 of 20 spent.
    h.store.db.prepare("UPDATE chains SET budget_used=? WHERE id=?").run(20, parent.chainId);
    h.say(h.arch, "用例请 @QA 补。");
    expect(await h.once()).toBe(true);
    expect(h.store.getTask(parent.id)?.status, "护栏拒绝不是运行时失败").toBe("succeeded");
    expect(h.children(parent), "`@` 不能绕过预算").toEqual([]);
    expect(h.rooms.getState(h.room.id).roundCount, "被拒绝的派发不计轮次").toBe(1);
    expect(systemMessages(h.rooms, h.room.id).some((m) => m.includes("护栏"))).toBe(true);
    h.close();
  });

  it("AC3.4 via `@`: with one slot left, two mentions dispatch one and report the other", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.store.db.prepare("UPDATE chains SET budget_used=? WHERE id=?").run(19, parent.chainId);
    h.say(h.arch, "@QA 和 @齐活林 都来补一下。");
    await h.once();
    expect(h.children(parent).map((t) => t.memberId)).toEqual([h.qa.id]);
    expect(h.store.getChain(parent.chainId).budgetUsed, "预算计数正确").toBe(20);
    expect(systemMessages(h.rooms, h.room.id).some((m) => m.includes("预算") && m.includes("齐活林"))).toBe(true);
    h.close();
  });

  it("AC3.4: one reply, two paths — the chain budget is shared, not counted twice", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    // One slot left. `handoff_to` takes it, so the prose mention of a DIFFERENT
    // target must be refused. Without the `planned` offset the mention path would
    // read the pre-run budget again and happily mint an over-budget child.
    h.store.db.prepare("UPDATE chains SET budget_used=? WHERE id=?").run(19, parent.chainId);
    h.say(h.arch, "工具交 QA， prose 再 @齐活林 收尾。", [h.qa.id]);
    await h.once();
    expect(h.children(parent).map((t) => t.memberId), "`@` 不能花掉第二份预算").toEqual([h.qa.id]);
    expect(h.store.getChain(parent.chainId).budgetUsed, "预算计数正确，不超发").toBe(20);
    expect(systemMessages(h.rooms, h.room.id).some((m) => m.includes("护栏") && m.includes("budget"))).toBe(true);
    h.close();
  });

  it("AC3.3: a deduped target is also charged once to the chain budget", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "@QA 也看一下。", [h.qa.id]);
    await h.once();
    expect(h.children(parent)).toHaveLength(1);
    expect(h.store.getChain(parent.chainId).budgetUsed, "visit/budget 不按路径翻倍").toBe(1);
    h.close();
  });
});

describe("replay idempotency of the synthesised source id (trap B)", () => {
  it("the same Attempt replayed twice produces ONE child, ONE outbox row, ONE round", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "用例请 @QA 补。");
    expect(await h.once()).toBe(true);
    expect(h.children(parent)).toHaveLength(1);
    const firstState = h.rooms.getState(h.room.id);
    expect(firstState.roundCount).toBe(2);

    h.requeue(parent);
    expect(await h.once(), "重放把同一个 Task 再跑一遍").toBe(true);

    // The harm first: a replay must not queue a second child for the same target.
    // With a non-deterministic synthetic id the outbox lookup misses and this
    // reads 2, so the assertion is about the queue, not about key formatting.
    expect(h.children(parent), "重放不得产生第二个子 Task").toHaveLength(1);
    expect(h.store.getOutbox().filter((r) => String(r.source_tool_call_id).startsWith(mentionSource(parent))),
      "同一源消息只留一条 outbox").toHaveLength(1);
    expect(h.rooms.getState(h.room.id).roundCount, "重放不得重复计轮").toBe(firstState.roundCount);
    expect(h.rooms.getState(h.room.id).chain).toEqual(firstState.chain);
    expect(h.rooms.listMessages(h.room.id).filter((m) => m.authorKind === "agent")).toHaveLength(1);
    h.close();
  });

  it("trap B (decisive): a replay whose turn chain was reset still makes no second child", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "用例请 @QA 补。");
    expect(await h.once()).toBe(true);
    expect(h.children(parent)).toHaveLength(1);

    // The commit landed but the Worker died before acking, so the Attempt is
    // re-claimed — and in the meantime a new user turn reset the chain (AC4.2),
    // which is what `resetState` does. Now LOOP no longer refuses QA: the
    // deterministic synthetic source id is the ONLY thing left between a replay
    // and a duplicate dispatch, so this is where a random id actually shows up.
    h.rooms.resetState(h.room.id, 250);
    h.requeue(parent);
    expect(await h.once(), "重放被领取").toBe(true);

    expect(h.children(parent), "只剩确定性合成键能挡住第二个子 Task").toHaveLength(1);
    expect(h.store.getOutbox(parent.id)).toHaveLength(1);
    // The tasks table too: the idempotency key must not have minted a twin.
    expect(h.store.listTasks().filter((t) => t.memberId === h.qa.id)).toHaveLength(1);
    h.close();
  });

  it("a second source Task mentioning the same target is its own dispatch, not a dedup collision", async () => {
    const h = setup();
    const first = h.trigger(h.arch, "第一次");
    h.say(h.arch, "@QA 补一下。");
    expect(await h.once()).toBe(true);
    expect(h.children(first)).toHaveLength(1);

    // A new user message is a new turn: it must reset the chain and be allowed to
    // mention QA again, so the synthetic key must be per source Task.
    const second = h.trigger(h.arch, "第二次");
    h.say(h.arch, "还是 @QA 补。");
    await h.once();
    expect(h.children(second), "新一轮的 @ 派发不能被上一轮吃掉").toHaveLength(1);
    expect(h.store.getOutbox().filter((r) => r.source_tool_call_id === mentionSource(second))).toHaveLength(1);
    expect(h.rooms.getState(h.room.id).chain).toEqual([h.arch.id, h.qa.id]);
    h.close();
  });

  it("a replay cannot duplicate the mention-resolution note either", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "@老王 提过这个，剩下 @QA 收尾。");
    expect(await h.once()).toBe(true);
    expect(systemMessages(h.rooms, h.room.id).filter((m) => m.includes("提及解析"))).toHaveLength(1);

    h.requeue(parent);
    expect(await h.once(), "重放被领取").toBe(true);
    // The notes ride the same `spoke` gate as the round writes: one Task speaks
    // once, and its resolution note is written once.
    expect(systemMessages(h.rooms, h.room.id).filter((m) => m.includes("提及解析")), "重放不重复系统消息")
      .toHaveLength(1);
    expect(h.children(parent)).toHaveLength(1);
    h.close();
  });

  it("without a RoomStore wired, a group Task never mentions-dispatches (unwired worker unchanged)", async () => {
    const h = setup({ withRoomStore: false });
    const parent = h.trigger(h.arch);
    h.say(h.arch, "用例请 @QA 补。");
    expect(await h.once()).toBe(true);
    expect(h.store.getTask(parent.id)?.status).toBe("succeeded");
    // The mention path needs the member roster, so it adds nothing — including no
    // half-built dispatch that would double the queue without guards.
    expect(h.children(parent)).toEqual([]);
    expect(h.rooms.getState(h.room.id).roundCount).toBe(1);
    h.close();
  });
});

// --- D2 on the SECONDARY path: `@角色` inside an agent's own reply ----------
//
// `collectMentionHandoffs` calls the very same `resolveMentions`, so role
// resolution is not a user-input-only affordance. These cases assert the
// observable consequence — a child Task for the role's owner — because "it
// resolved in the unit test" and "the worker dispatched it" are different claims.
describe("D2 via `@role`: prose dispatch and prose ambiguity", () => {
  it("agent 正文写 @交付总监 → 真的派发给 role 唯一的 齐活林", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "方案定了，收尾请 @交付总监 把关。");
    expect(await h.once()).toBe(true);
    expect(h.children(parent).map((t) => t.memberId), "角色在次路径同样生效")
      .toEqual([h.coordinator.id]);
    h.close();
  });

  it("正文里的 @架构 命中 role，而 @架构师 命中 name —— 同一人，两条地址", async () => {
    const h = setup();
    const parent = h.trigger(h.coordinator);
    h.say(h.coordinator, "@架构 先给结论，@架构师 是同一个人，不用重复叫。");
    expect(await h.once()).toBe(true);
    const children = h.children(parent);
    expect(children.map((t) => t.memberId), "同一目标被两种写法提及也只派发一次")
      .toEqual([h.arch.id]);
    h.close();
  });

  it("两个成员同为 role 交付总监 → 正文里的 @交付总监 不派发，并报重名", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.rooms.addAgent({
      roomId: h.room.id, name: "另一位", role: "交付总监", prompt: "clone", agentDir: "/persona/lead2",
    }, 150);
    h.say(h.arch, "这块交给 @交付总监 吧。");
    expect(await h.once()).toBe(true);
    expect(h.store.getTask(parent.id)?.status, "role 撞车不能让整轮作废").toBe("succeeded");
    expect(h.children(parent), "role 不唯一 → 宁可一个都不派").toEqual([]);
    const notes = systemMessages(h.rooms, h.room.id);
    expect(notes.some((m) => m.includes("重名") && m.includes("交付总监"))).toBe(true);
    h.close();
  });
});

// --- D4 on both paths: code notation is not a missing colleague -------------
describe("D4: `@ts-ignore` 之类的代码写法在两条路径上都不产生投诉", () => {
  it("user 消息里的 @ts-ignore / @types/node 不再换来 UNKNOWN_MENTION", () => {
    const h = setup();
    const posted = postRoomMessage(h.rooms, h.store, {
      roomId: h.room.id, content: "先加一行 // @ts-ignore 和 @types/node，@QA 复核。",
      tenantId: "default", projectId: "proj-1", workspacePath: "/workspace/proj-1", now: 200,
    });
    expect(posted.tasks.map((t) => t.memberId), "同句里的真成员照常派发").toEqual([h.qa.id]);
    expect(systemMessages(h.rooms, h.room.id).filter((m) => m.includes("没有这些 agent")))
      .toEqual([]);
    h.close();
  });

  it("真成员名 @不存在的同事 仍然 4xx —— 漏判无害，误判才致命", () => {
    const h = setup();
    expect(() => postRoomMessage(h.rooms, h.store, {
      roomId: h.room.id, content: "@不存在的同事 看一下",
      tenantId: "default", projectId: "proj-1", workspacePath: "/workspace/proj-1", now: 200,
    })).toThrow(RoomTriggerError);
    h.close();
  });

  it("agent 正文含 @media / @param → 不落任何「提及解析」系统消息，也不派发", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "样式里 @media 断点要改，注释里 @param 漏了一个。");
    expect(await h.once()).toBe(true);
    expect(h.children(parent)).toEqual([]);
    expect(systemMessages(h.rooms, h.room.id).filter((m) => m.includes("提及解析"))).toEqual([]);
    expect(h.rooms.getState(h.room.id).roundCount, "被忽略的代码写法不花轮次").toBe(1);
    h.close();
  });

  it("同一句正文里：@ts-ignore 静默忽略，@老王 仍然上报未派发", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "// @ts-ignore 这行留着。这块 @老王 最有经验。");
    expect(await h.once()).toBe(true);
    expect(h.children(parent)).toEqual([]);
    const notes = systemMessages(h.rooms, h.room.id).filter((m) => m.includes("提及解析"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("老王");
    expect(notes[0], "代码写法不能混进未派发名单").not.toContain("ts-ignore");
    h.close();
  });
});

// --- D5 on the PRIMARY path: the roster decides who may be dispatched -----------
//
// The primary path used to feed the model's strings straight into `evaluateHandoff`
// and `ResolvedHandoff.toMemberId`. A name instead of an id therefore did not fail —
// it dispatched: `member_id="寇豆码"`, `agent_dir=NULL`, `model=NULL`, and the child
// ran as an anonymous agent in the project workspace until it timed out on a missing
// structured result. These cases assert the observable consequence of the check: no
// Task row, and a sentence in the stream saying why.
describe("D5: handoff_to 的目标必须逐个对照花名册", () => {
  it("目标不是本群成员 → 不建子 Task、有系统消息、父 Task 仍 succeeded", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "这块交给外部的老王。", ["老王"]);
    expect(await h.once()).toBe(true);

    const notes = systemMessages(h.rooms, h.room.id).filter((m) => m.includes("交接校验"));
    expect(notes, "不能静默丢弃").toHaveLength(1);
    expect(notes[0]).toContain("老王");
    expect(notes[0]).toContain("不是本群成员");
    expect(h.children(parent), "花名册外不派发").toEqual([]);
    expect(h.store.getOutbox(parent.id), "连 outbox 都不能有").toHaveLength(0);
    expect(h.store.getTask(parent.id)?.status, "拒派不是运行时失败").toBe("succeeded");
    // 没派发出去就不该有它的回复：父的回复照常说，但老王不占轮次。
    expect(h.rooms.getState(h.room.id).roundCount).toBe(1);
    expect(h.store.listTasks().filter((t) => t.memberId === "老王")).toHaveLength(0);
    h.close();
  });

  it("写名字（寇豆码式）→ 解析成 id 后派发，并带上目标的人格目录", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "用例交出去。", ["QA"]);
    expect(await h.once()).toBe(true);

    const children = h.children(parent);
    expect(children.map((t) => t.memberId), "名字解析成人，落库的是 id").toEqual([h.qa.id]);
    expect(children[0]?.agentDir, "不再是 agent_dir=NULL").toBe("/persona/qa");
    expect(children[0]?.groupId).toBe(h.room.id);
    expect(h.rooms.getState(h.room.id).roundCount).toBe(2);
    expect(systemMessages(h.rooms, h.room.id)).toEqual([]);
    h.close();
  });

  it("写角色（交付总监式）→ 同样解析并派发", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "收尾交给总监。", ["交付总监"]);
    expect(await h.once()).toBe(true);
    expect(h.children(parent).map((t) => t.memberId)).toEqual([h.coordinator.id]);
    expect(h.children(parent)[0]?.model).toBe("anthropic/claude-opus");
    h.close();
  });

  it("写 id 也照旧能用 —— 三种写法是同一套规则，不是新造一套标识", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "按 id 交。", [h.qa.id]);
    await h.once();
    expect(h.children(parent).map((t) => t.memberId)).toEqual([h.qa.id]);
    h.close();
  });

  it("名字与角色分属两人 → 名字优先（复用 resolveMentions 的 D2 规则）", async () => {
    const h = setup();
    // 新成员的名字恰好是 QA 的角色「测试」：按角色会派给 QA，按名字应派给它。
    const named = h.rooms.addAgent({
      roomId: h.room.id, name: "测试", role: "质检", prompt: "You are named 测试.",
      agentDir: "/persona/named",
    }, 150);
    const parent = h.trigger(h.arch);
    h.say(h.arch, "这块交给 测试。", ["测试"]);
    expect(await h.once()).toBe(true);
    expect(h.children(parent).map((t) => t.memberId), "身份优先于描述")
      .toEqual([named.id]);
    h.close();
  });

  it("重名 → ambiguous → 一个都不派，且说明原因", async () => {
    const h = setup();
    h.rooms.addAgent({
      roomId: h.room.id, name: "QA", role: "测试", prompt: "clone", agentDir: "/persona/qa2",
    }, 150);
    const parent = h.trigger(h.arch);
    h.say(h.arch, "用例交给 QA。", ["QA"]);
    expect(await h.once()).toBe(true);
    expect(h.store.getTask(parent.id)?.status).toBe("succeeded");
    expect(h.children(parent), "重名绝不猜").toEqual([]);
    const notes = systemMessages(h.rooms, h.room.id).filter((m) => m.includes("交接校验"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("重名");
    expect(notes[0]).toContain("QA");
    expect(h.rooms.getState(h.room.id).roundCount).toBe(1);
    h.close();
  });

  it("一半在册一半不在 → 在的照派，不在的逐条上报（不静默、也不连坐）", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "用例给 QA，顺手也找下老王。", ["QA", "老王", "外群的人"]);
    expect(await h.once()).toBe(true);
    expect(h.children(parent).map((t) => t.memberId)).toEqual([h.qa.id]);
    const notes = systemMessages(h.rooms, h.room.id).filter((m) => m.includes("交接校验"));
    expect(notes, "一次运行只报一条，不重复刷屏").toHaveLength(1);
    expect(notes[0]).toContain("老王");
    expect(notes[0]).toContain("外群的人");
    h.close();
  });

  it("多次 handoff_to 里同一个坏名字只上报一次", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.sayCalls(h.arch, "两次都提到老王。", [
      { toolCallId: "call-1", toMemberIds: ["老王"], reason: "第一次" },
      { toolCallId: "call-2", toMemberIds: ["老王", "QA"], reason: "第二次" },
    ]);
    expect(await h.once()).toBe(true);
    expect(h.children(parent).map((t) => t.memberId)).toEqual([h.qa.id]);
    const notes = systemMessages(h.rooms, h.room.id).filter((m) => m.includes("交接校验"));
    expect(notes).toHaveLength(1);
    const note = notes[0]!;
    expect(note.split("老王").length - 1, "折叠按 token，不按调用次数").toBe(1);
    h.close();
  });

  it("护栏看到的是解析后的 id：名字与 id 混写同一人 → 仍按目标折叠一次", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.sayCalls(h.arch, "两种写法指同一个人。", [
      { toolCallId: "call-1", toMemberIds: ["QA"], reason: "按名字" },
      { toolCallId: "call-2", toMemberIds: [h.qa.id], reason: "按 id" },
    ]);
    expect(await h.once()).toBe(true);
    expect(h.children(parent)).toHaveLength(1);
    expect(h.store.getChain(parent.chainId).budgetUsed, "revisit 按 id 计，不因写法翻倍").toBe(1);
    expect(loopNotes(h.rooms, h.room.id)).toEqual([]);
    h.close();
  });

  it("【回归】非群 Task：不校验、不注入，行为逐字节不变", async () => {
    const h = setup();
    // The roster only exists for a room. A roomless Task's `memberId` is an
    // execution member, so validating it against some room would be a NEW gate on
    // the P6 spine — and `handoff_to(["b"])` must still mint a child for "b".
    const solo = h.store.createTask({
      tenantId: "t", projectId: "p", memberId: "solo", workspacePath: "/tmp", prompt: "solo work",
    }, 100);
    h.sayCalls("solo", "交给不在花名册的 b。", [{
      toolCallId: "call-1", toMemberIds: ["b"], reason: "照旧派发", workPackage: "Review the diff.",
    }]);
    expect(await h.once()).toBe(true);

    const children = h.children(solo);
    expect(children.map((t) => t.memberId)).toEqual(["b"]);
    expect(children[0]?.prompt, "非群 Task 的 prompt 仍是 work 原文").toBe("Review the diff.");
    expect(children[0]?.groupId, "没有群就不注入群").toBeUndefined();
    expect(children[0]?.agentDir).toBeUndefined();
    // No room side effects whatsoever: this path never reads a roster.
    expect(systemMessages(h.rooms, h.room.id)).toEqual([]);
    expect(h.rooms.getState(h.room.id).roundCount).toBe(0);
    h.close();
  });

  it("【回归】没接 RoomStore 的 worker：群 Task 也不校验（读不到花名册就不新增闸门）", async () => {
    const h = setup({ withRoomStore: false });
    const parent = h.trigger(h.arch);
    h.say(h.arch, "交出去。", ["QA", "老王"]);
    expect(await h.once()).toBe(true);
    // Unchanged pre-D5 shape: the tokens dispatch verbatim, and nothing is written
    // to the room by this worker (it has no handle to write through).
    expect(h.children(parent).map((t) => t.memberId)).toEqual(["QA", "老王"]);
    expect(h.rooms.listMessages(h.room.id).map((m) => m.authorKind)).toEqual(["user"]);
    h.close();
  });
});

// --- D6: the primary path must inject the room too --------------------------------
//
// D1 made the primary path reachable for the first time, and the acceptance run then
// read what a `handoff_to` child actually receives: only "请回一句话确认收到即可…",
// no role prompt, no room, no history. That is AC2.3/AC3.1 and Q30/I4 unmet, so the
// fix is not "add a second injection" but "route both paths through one builder".
describe("D6: 主路径派生的群子 Task 也走群注入", () => {
  const REPLY = "接口先定，具体用例请 @QA 补。";
  const WORK = "只测登录分支，不要跑全量回归。";

  it("主路径子 Task prompt 含群历史、父这条回复、子角色 prompt，且 workPackage 在末尾", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.sayCalls(h.arch, REPLY, [{
      toolCallId: "call-1", toMemberIds: [h.qa.id], reason: "请 QA 出用例", workPackage: WORK,
    }]);
    expect(await h.once()).toBe(true);
    const child = h.children(parent)[0]!;
    const prompt = child.prompt;
    expect(prompt).toContain("# 群聊记录");
    expect(prompt, "子 Task 用自己的角色 prompt，不是父的").toContain("You test.");
    expect(prompt).not.toContain("You design.");
    // 父这条回复尚未落流，必须作为最新历史行补进去。
    expect(prompt).toContain(`: ${REPLY}`);
    expect(prompt).toContain("# 成员");
    expect(prompt, "子 agent 也从花名册读到可交接的 id").toContain("｜id: ");
    // workPackage 原文出现在「之后」的任务说明里，且在最后。
    expect(prompt.slice(prompt.indexOf("# 你的任务"))).toContain("# 交接任务说明");
    expect(prompt.endsWith(WORK)).toBe(true);
    expect(prompt.indexOf(WORK), "任务说明在注入文本之后，不在历史里").toBeGreaterThan(
      prompt.indexOf("# 群聊记录"),
    );
    expect(prompt).toContain("架构师");
    // 派发仍然是主路径的：真实 toolCallId，不是合成 id。
    expect(String(h.store.getOutbox(parent.id)[0]!.source_tool_call_id)).toBe("call-1");
    h.close();
  });

  it("没有 workPackage 时用 reason 作任务说明，仍在末尾", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.say(h.arch, "用例交给你。", [h.qa.id], "请 QA 只补登录分支");
    expect(await h.once()).toBe(true);
    const child = h.children(parent)[0]!;
    expect(child.prompt).toContain("# 群聊记录");
    expect(child.prompt.endsWith("请 QA 只补登录分支")).toBe(true);
    h.close();
  });

  it("主/次路径对同一目标产出的 prompt 结构一致（除任务说明段）", async () => {
    // ONE fixture, so the room id, the member ids and the roster lines are the same
    // bytes on both sides — comparing two fixtures could never be byte-exact and
    // would only prove the two paths look similar. Both turns dispatch at QA.
    const h = setup();
    const handoffParent = h.trigger(h.arch, "第一轮");
    h.sayCalls(h.arch, REPLY, [{
      toolCallId: "call-1", toMemberIds: [h.qa.id], reason: "请 QA 出用例", workPackage: WORK,
    }]);
    expect(await h.once()).toBe(true);
    const handoffPrompt = h.children(handoffParent)[0]!.prompt;

    const mentionParent = h.trigger(h.arch, "第二轮");
    h.say(h.arch, REPLY);
    expect(await h.once()).toBe(true);
    const mentionChild = h.children(mentionParent)[0]!;
    expect(mentionChild.memberId, "两轮派的是同一个人").toBe(h.qa.id);
    const mentionPrompt = mentionChild.prompt;

    // Everything BEFORE the stream is the shared persona/identity/roster injection,
    // and it must be byte-identical: one builder, not two.
    const cut = (p: string): string => p.slice(0, p.indexOf("# 群聊记录"));
    expect(cut(handoffPrompt), "注入的角色段与群段是同一份实现").toBe(cut(mentionPrompt));
    expect(handoffPrompt).toContain("# 群聊记录");

    // The instruction block is the ONLY structural addition of the primary path,
    // and it comes after 「# 你的任务」 — the same tail shape the wrap-up Task uses.
    const sections = (p: string): string[] =>
      p.split("\n").filter((line) => line.startsWith("# "));
    // The primary path adds exactly ONE section, and only at the tail.
    expect(sections(handoffPrompt)).toEqual([
      ...sections(mentionPrompt),
      "# 交接任务说明（来自 架构师，平台附在群聊注入之后）",
    ]);
    // 「# 你的任务」 的两段正文一致：主路径只在其后追加，不改注入的指令。
    const taskBlock = (p: string): string =>
      p.split("\n\n").find((block) => block.startsWith("# 你的任务")) ?? "";
    expect(taskBlock(handoffPrompt)).toBe(taskBlock(mentionPrompt));
    expect(handoffPrompt.endsWith(WORK)).toBe(true);
    expect(mentionPrompt).not.toContain("交接任务说明");
    h.close();
  });

  it("重放不重复派发，也不改写子 Task 的 prompt", async () => {
    const h = setup();
    const parent = h.trigger(h.arch);
    h.sayCalls(h.arch, REPLY, [{
      toolCallId: "call-1", toMemberIds: [h.qa.id], reason: "请 QA 出用例", workPackage: WORK,
    }]);
    expect(await h.once()).toBe(true);
    const firstPrompt = h.children(parent)[0]!.prompt;
    const firstState = h.rooms.getState(h.room.id);

    h.requeue(parent);
    expect(await h.once(), "同一个 Task 再跑一遍").toBe(true);

    expect(h.children(parent), "真实 toolCallId 的 outbox 幂等挡住了第二个子 Task")
      .toHaveLength(1);
    expect(h.store.getOutbox(parent.id)).toHaveLength(1);
    expect(h.children(parent)[0]!.prompt, "重放注入同一份文本（Q39）").toBe(firstPrompt);
    expect(h.rooms.getState(h.room.id).roundCount).toBe(firstState.roundCount);
    expect(h.rooms.listMessages(h.room.id).filter((m) => m.authorKind === "agent")).toHaveLength(1);
    h.close();
  });

  it("【回归】非群 Task 的 prompt 构造未变", async () => {
    const h = setup();
    const solo = h.store.createTask({
      tenantId: "t", projectId: "p", memberId: "solo", workspacePath: "/tmp", prompt: "solo work",
    }, 100);
    h.sayCalls("solo", "交出去。", [{
      toolCallId: "call-1", toMemberIds: ["b"], reason: "r", workPackage: "只做这件事",
    }]);
    expect(await h.once()).toBe(true);
    const child = h.children(solo)[0]!;
    expect(child.prompt).toBe("只做这件事");
    expect(child.prompt).not.toContain("# 群聊记录");
    expect(child.prompt).not.toContain("# 成员");
    // 无 workPackage 时退回 reason 原文，同样不注入群。
    h.close();
  });
});

/**
 * D2 end-to-end on the package that exposed the defect. `ref/` is an untracked
 * local tree (see `template-import.test.ts`), so this skips where the zip is
 * absent instead of failing a tree that never had the reference checkout.
 */
const REAL_ZIP = join(process.cwd(), "ref", "teamagentx-templates", "全栈软件研发-2026-06-03.zip");
const realDir = mkdtempSync(join(tmpdir(), "mention-real-"));
afterAll(() => rmSync(realDir, { recursive: true, force: true }));

describe.skipIf(!existsSync(REAL_ZIP))("D2 真实包 全栈软件研发：@角色 端到端", () => {
  it("postRoomMessage(“@架构师 …”) 不抛 4xx，并为 高见远 建出 Task", async () => {
    const executions = new ExecutionStore(":memory:");
    const rooms = new RoomStore(executions.db);
    const imported = importTemplatePackage({
      zip: REAL_ZIP, store: rooms, projectId: "proj-real",
      roomsRoot: join(realDir, ".rooms"), now: 100,
    });
    const byName = new Map(imported.agents.map((a) => [a.name, a]));
    expect([...byName.keys()].sort()).toEqual(["严过关", "寇豆码", "齐活林", "许清楚", "高见远"].sort());
    expect(byName.get("高见远")?.role).toBe("架构师");

    const posted = postRoomMessage(rooms, executions, {
      roomId: imported.room.id, content: "@架构师 帮我出一个贪吃蛇的模块划分",
      tenantId: "default", projectId: "proj-real", workspacePath: "/workspace/proj-real", now: 200,
    });
    expect(posted.tasks, "不抛 4xx 就必须有 Task").toHaveLength(1);
    expect(posted.blocked ?? [], "没有守卫拦下它").toEqual([]);
    const task = executions.getTask(posted.tasks[0]!.id)!;
    expect(task.memberId, "@架构师 落到 role=架构师 的那个人").toBe(byName.get("高见远")!.id);
    expect(task.status).toBe("queued");
    expect(task.agentDir, "派发带的是高见远的人格目录").toBe(byName.get("高见远")!.agentDir);

    // The other four roles answer too, and `@工程师` is unique while a shared
    // role would not be — same package, same call, no 4xx.
    for (const [token, name] of [
      ["产品经理", "许清楚"], ["QA工程师", "严过关"], ["交付总监", "齐活林"], ["工程师", "寇豆码"],
    ] as const) {
      const again = postRoomMessage(rooms, executions, {
        roomId: imported.room.id, content: `@${token} 继续`,
        tenantId: "default", projectId: "proj-real", workspacePath: "/workspace/proj-real", now: 300,
      });
      expect(again.tasks, `@${token}`).toHaveLength(1);
      expect(byName.get(name)!.id).toBe(again.tasks[0]!.memberId);
    }
    // A name still wins over a role in the real roster.
    const named = postRoomMessage(rooms, executions, {
      roomId: imported.room.id, content: "@高见远 本人",
      tenantId: "default", projectId: "proj-real", workspacePath: "/workspace/proj-real", now: 400,
    });
    expect(named.tasks).toHaveLength(1);
    rooms.close();
    executions.close();
  });

  it("真实包正文里的 // @ts-ignore 不再触发「群里没有这些成员」", () => {
    const executions = new ExecutionStore(":memory:");
    const rooms = new RoomStore(executions.db);
    const imported = importTemplatePackage({
      zip: REAL_ZIP, store: rooms, projectId: "proj-real",
      roomsRoot: join(realDir, ".rooms2"), now: 100,
    });
    expect(() => postRoomMessage(rooms, executions, {
      roomId: imported.room.id,
      content: "@高见远 这个文件要加 // @ts-nocheck，依赖补 @types/node，@media 断点也一起看。",
      tenantId: "default", projectId: "proj-real", workspacePath: "/workspace/proj-real", now: 200,
    })).not.toThrow();
    rooms.close();
    executions.close();
  });
});
