import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { ChatRoom, RoomAgent, RoomState } from "@my-team-agents/domain";
import { EMPTY_ROOM_STATE, TERMINATION_MARKER } from "@my-team-agents/domain";
import type { CanonicalEvent, RunHandle, RuntimeAdapter } from "@my-team-agents/runtime-core";
import { ExecutionStore } from "./execution-store.js";
import { RoomStore } from "./room-store.js";
import { createDurableWorker } from "./durable-worker.js";
import { applyTriggerGuards, postRoomMessage } from "./room-trigger.js";
import {
  evaluateTermination,
  evaluateTrigger,
  formatBlockReason,
  WRAP_UP_INSTRUCTION,
} from "./room-guards.js";

/**
 * I6 — flow guards: loop detection, round cap and the termination signal.
 *
 * Every test name carries the PRD acceptance criterion it proves, because the point
 * of this file is coverage of AC4.x / AC5.x / AC6.x / AC7.1 rather than of the
 * implementation's internal shape. The state itself is asserted through
 * `RoomStore.getState`, i.e. through SQLite, never through a captured object — a
 * guard that only works in memory is exactly the upstream defect Q28/Q29 refuses.
 */

const summary = (text: string) => JSON.stringify({
  outcome: "success", summary: text, artifacts: [], remainingRisks: [],
});

/**
 * A runtime that hands back a fixed reply plus whatever tool calls the case needs.
 * `handoffTo` produces the `handoff_to` event that P6 already dispatches, which is
 * the real interception point for agent→agent loops (I6 needs no I5 for that).
 */
const adapterFor = (reply: string, handoffTo: string[] = []): RuntimeAdapter => ({
  kind: "pi",
  capabilities: {
    streaming: true, steer: true, cancel: true, approval: "none", sandbox: "none",
    workspacePerRun: true, agentDirPerRun: false, usageAttribution: "message",
    costCap: false, sessionResume: false,
  },
  async start(spec): Promise<RunHandle> {
    const events: CanonicalEvent[] = [];
    if (handoffTo.length > 0) {
      events.push({
        type: "tool_execution_start", runId: spec.runId, timestamp: "",
        toolCallId: `call-${spec.runId}`, toolName: "handoff_to",
        args: { toMemberIds: handoffTo, reason: "next step", workPackage: "continue" },
      });
      events.push({
        type: "tool_execution_end", runId: spec.runId, timestamp: "",
        toolCallId: `call-${spec.runId}`, toolName: "handoff_to",
      });
    }
    events.push({ type: "message_end", runId: spec.runId, timestamp: "", text: summary(reply) });
    return {
      runId: spec.runId,
      events: (async function* () { yield* events; })(),
      settled: Promise.resolve({ runId: spec.runId, status: "completed" }),
      async cancel() {},
    };
  },
});

const tempDir = mkdtempSync(join(tmpdir(), "room-guards-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

interface Setup {
  store: ExecutionStore;
  rooms: RoomStore;
  room: ChatRoom;
  coordinator: RoomAgent;
  arch: RoomAgent;
  qa: RoomAgent;
  trigger(content: string, now?: number): ReturnType<typeof postRoomMessage>;
  /** Runs the worker with the given reply and optional handoff target ids. */
  run(reply: string, handoffTo?: string[]): Promise<boolean>;
  /** Every reply the worker produces, keyed by the member id it answered as. */
  setReplies(replies: Record<string, string>, handoffs?: Record<string, string[]>): void;
  close(): void;
}

/**
 * One room with a coordinator plus two members. `maxRounds` is injectable (AC5.4);
 * the stock value is 5 so a test that forgets it still exercises the PRD default.
 */
const setup = (options: { maxRounds?: number; coordinator?: boolean } = {}): Setup => {
  const store = new ExecutionStore(":memory:");
  const rooms = new RoomStore(store.db);
  const room = rooms.createRoom({
    projectId: "proj-1",
    name: "研发群",
    coordinatorAgentId: null,
    ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
  }, 100);
  const coordinator = rooms.addAgent({
    roomId: room.id, name: "齐活林", role: "交付总监", prompt: "You coordinate.",
    agentDir: "/persona/lead", isCoordinator: options.coordinator !== false,
  }, 100);
  const arch = rooms.addAgent({
    roomId: room.id, name: "架构师", role: "架构", prompt: "You design.", agentDir: "/persona/arch",
  }, 101);
  const qa = rooms.addAgent({
    roomId: room.id, name: "QA", role: "测试", prompt: "You test.", agentDir: "/persona/qa",
  }, 102);

  const replies: Record<string, string> = {};
  const handoffs: Record<string, string[]> = {};
  let clock = 1_000;
  const worker = createDurableWorker(store, {
    workerId: "w1",
    adapterFor: (memberId) => adapterFor(replies[memberId] ?? `${memberId} 已收到`, handoffs[memberId] ?? []),
    rooms,
    // A clock that only moves when asked keeps createdAt/seq comparisons readable.
    now: () => (clock += 1),
  });
  const trigger = (content: string, now = 200) => postRoomMessage(rooms, store, {
    roomId: room.id, content, tenantId: "default", workspacePath: "/workspace/proj-1", now,
  });
  return {
    store, rooms, room, coordinator, arch, qa, trigger,
    run: async (reply, handoffTo) => {
      replies[`\u0000default`] = reply;
      handoffs[`\u0000default`] = handoffTo ?? [];
      // Every member answers with the same reply unless the case overrides it.
      for (const agent of [coordinator, arch, qa]) {
        replies[agent.id] ??= reply;
        handoffs[agent.id] ??= handoffTo ?? [];
      }
      return worker.runOnce();
    },
    setReplies: (next, nextHandoffs = {}) => {
      for (const [id, text] of Object.entries(next)) replies[id] = text;
      for (const [id, target] of Object.entries(nextHandoffs)) handoffs[id] = target;
    },
    close: () => { rooms.close(); store.close(); },
  };
};

const systemMessages = (rooms: RoomStore, roomId: string) =>
  rooms.listMessages(roomId).filter((m) => m.authorKind === "system").map((m) => m.content);

const agentTasks = (store: ExecutionStore) =>
  store.listTasks().filter((t) => !(t.idempotencyKey ?? "").startsWith("wrapup:"));

const chatRoom = (over: Partial<ChatRoom> = {}): ChatRoom => ({
  id: "room-1", projectId: "proj-1", name: "研发群", description: "", rules: "",
  coordinatorAgentId: "a-lead", maxRounds: 5, createdAt: 100, ...over,
});

const roomAgent = (over: Partial<RoomAgent> = {}): RoomAgent => ({
  id: "a-lead", roomId: "room-1", name: "齐活林", role: "交付总监", prompt: "You coordinate.",
  agentDir: "/persona/lead", model: null, thinkingMode: null, emoji: null, color: null,
  isCoordinator: true, createdAt: 100, ...over,
});

const state = (over: Partial<RoomState> = {}): RoomState => ({ ...EMPTY_ROOM_STATE("room-1"), ...over });

describe("evaluateTrigger — pure, deterministic (I6)", () => {
  it("AC6.1: a terminated room blocks the trigger before anything else is considered", () => {
    const decision = evaluateTrigger(state({ terminated: true }), chatRoom(), "a-arch");
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("TERMINATED");
    expect(decision.reason).toContain(TERMINATION_MARKER);
    // Termination outranks a legal, sub-cap target: nothing resurrects a closed room.
    expect(decision.reachesCap).toBeUndefined();
  });

  it("AC4.1: an agent already in the chain is refused as LOOP", () => {
    const decision = evaluateTrigger(state({ roundCount: 2, chain: ["a-arch", "a-qa"] }), chatRoom(), "a-arch");
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("LOOP");
    expect(decision.reason).toContain("循环守卫");
    // The reason lands in a chat stream: it must not dump raw agent uuids there.
    expect(decision.reason).not.toContain("a-arch");
  });

  it("AC4.3: a legal chain user→A→B→coordinator is not mistaken for a loop", () => {
    const chain = ["a-arch", "a-qa"];
    expect(evaluateTrigger(state({ roundCount: 2, chain }), chatRoom(), "a-lead").allowed).toBe(true);
  });

  it("AC5.2: a spent round budget is refused as ROUND_CAP", () => {
    const decision = evaluateTrigger(
      state({ roundCount: 5, chain: ["a-arch"] }), chatRoom({ maxRounds: 5 }), "a-qa",
    );
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("ROUND_CAP");
  });

  it("AC5.4: the cap comes from the room, not from a constant", () => {
    const two = chatRoom({ maxRounds: 2 });
    // Same state, different room configuration: 2 rounds is spent for one, not the other.
    expect(evaluateTrigger(state({ roundCount: 2 }), two, "a-qa").code).toBe("ROUND_CAP");
    expect(evaluateTrigger(state({ roundCount: 2 }), chatRoom({ maxRounds: 3 }), "a-qa").allowed).toBe(true);
    // A room with a nonsensical cap stops rather than allows: the guard fails closed.
    expect(evaluateTrigger(state(), chatRoom({ maxRounds: 0 }), "a-qa").code).toBe("ROUND_CAP");
  });

  it("AC5.1: reachesCap marks exactly the trigger that exhausts the budget", () => {
    const room = chatRoom({ maxRounds: 3 });
    expect(evaluateTrigger(state({ roundCount: 1 }), room, "a-qa").reachesCap).toBe(false);
    expect(evaluateTrigger(state({ roundCount: 2 }), room, "a-qa").reachesCap).toBe(true);
    expect(evaluateTrigger(state({ roundCount: 0 }), chatRoom({ maxRounds: 1 }), "a-qa").reachesCap).toBe(true);
  });

  it("is a pure function: the same state always yields the same verdict", () => {
    const room = chatRoom();
    const frozen = state({ roundCount: 2, chain: ["a-qa"] });
    const before = JSON.stringify(frozen);
    const first = evaluateTrigger(frozen, room, "a-arch");
    const second = evaluateTrigger(frozen, room, "a-arch");
    expect(second).toEqual(first);
    expect(JSON.stringify(frozen), "the guard must not mutate its input").toBe(before);
  });
});

describe("evaluateTermination — only the coordinator ends a room (I6)", () => {
  it("AC6.1: a coordinator reply carrying the marker terminates", () => {
    expect(evaluateTermination(`结论如上。${TERMINATION_MARKER}`, roomAgent()))
      .toEqual({ terminate: true, ignoredAttempt: false });
  });

  it("AC6.2: a non-coordinator's marker is an ignored attempt, not a termination", () => {
    const qa = roomAgent({ id: "a-qa", name: "QA", isCoordinator: false });
    expect(evaluateTermination(`${TERMINATION_MARKER}`, qa))
      .toEqual({ terminate: false, ignoredAttempt: true });
  });

  it("ignores content without the marker, whatever the author", () => {
    expect(evaluateTermination("普通发言", roomAgent()))
      .toEqual({ terminate: false, ignoredAttempt: false });
    expect(evaluateTermination("[讨论结束", roomAgent({ isCoordinator: false })))
      .toEqual({ terminate: false, ignoredAttempt: false });
  });

  it("formats a block reason that names the blocker and the target", () => {
    const reason = formatBlockReason("QA", evaluateTrigger(state({ terminated: true }), chatRoom(), "a-qa"));
    expect(reason).toContain("已终止");
    expect(reason).toContain("QA");
    const capped = formatBlockReason("QA", evaluateTrigger(state({ roundCount: 5 }), chatRoom(), "a-qa"));
    expect(capped).toContain("轮次上限");
  });
});

describe("entry point A — user message resets the turn and guards every target (I6)", () => {
  it("AC4.2: a new user message clears the chain, so A can be triggered again", () => {
    const h = setup();
    h.trigger("请 @架构师 定方案");
    // Leave a previous turn's chain standing: A already spoke, then B.
    h.rooms.recordTrigger(h.room.id, h.arch.id);
    h.rooms.recordTrigger(h.room.id, h.qa.id);
    expect(h.rooms.getState(h.room.id).chain).toContain(h.arch.id);

    const again = h.trigger("请 @架构师 再看一次");
    expect(again.blocked).toEqual([]);
    expect(again.tasks).toHaveLength(1);
    // The reset happened, and only THIS turn's trigger is on the chain now.
    expect(h.rooms.getState(h.room.id).chain).toEqual([h.arch.id]);
    expect(h.rooms.getState(h.room.id).roundCount).toBe(1);
    expect(h.store.getTask(again.tasks[0]!.id)?.groupId).toBe(h.room.id);
    h.close();
  });

  it("AC4.1 (branch): a duplicated target inside one message is refused as LOOP with a system message", () => {
    const h = setup();
    // `resolveMentions` dedupes, so the duplicated target is fed straight to the
    // guard helper — the exact code `postRoomMessage` runs, without pretending a
    // mention path could produce this shape today.
    h.rooms.resetState(h.room.id);
    const result = applyTriggerGuards(h.rooms, h.room, [h.arch, h.arch], 200);
    expect(result.allowed.map((a) => a.id)).toEqual([h.arch.id]);
    expect(result.blocked).toEqual([{ memberId: h.arch.id, code: "LOOP", reason: expect.any(String) }]);
    expect(systemMessages(h.rooms, h.room.id)).toHaveLength(1);
    expect(systemMessages(h.rooms, h.room.id)[0]).toContain("循环");
    expect(h.rooms.getState(h.room.id)).toMatchObject({ roundCount: 1, chain: [h.arch.id] });
    h.close();
  });

  it("AC5.3: a new user message resets the round count", () => {
    const h = setup();
    h.rooms.recordTrigger(h.room.id, h.arch.id);
    h.rooms.recordTrigger(h.room.id, h.qa.id);
    expect(h.rooms.getState(h.room.id).roundCount).toBe(2);
    const posted = h.trigger("请 @架构师 复核");
    expect(posted.tasks).toHaveLength(1);
    // Reset first, then this turn's own trigger counted: exactly one round.
    expect(h.rooms.getState(h.room.id).roundCount).toBe(1);
    h.close();
  });

  it("AC6.3: a user message in a terminated room resets the flag and the trigger works", () => {
    const h = setup();
    h.rooms.markTerminated(h.room.id);
    expect(h.rooms.getState(h.room.id).terminated).toBe(true);
    const posted = h.trigger("我们继续，请 @架构师 定方案");
    expect(posted.blocked).toEqual([]);
    expect(posted.tasks).toHaveLength(1);
    const after = h.rooms.getState(h.room.id);
    expect(after.terminated).toBe(false);
    expect(after.roundCount).toBe(1);
    h.close();
  });

  it("AC5.4: mentions that consume a maxRounds=2 room's budget queue the forced wrap-up", () => {
    const h = setup({ maxRounds: 2 });
    // Two targets = the whole budget of this turn: the second lands ON the cap.
    const posted = h.trigger("请 @架构师 和 @QA 一起看");
    expect(posted.tasks).toHaveLength(2);
    expect(posted.blocked).toEqual([]);
    expect(h.rooms.getState(h.room.id).roundCount).toBe(2);

    const wrapUps = h.store.listTasks().filter((t) => (t.idempotencyKey ?? "").startsWith("wrapup:"));
    expect(wrapUps, "AC5.1: the cap schedules exactly one forced wrap-up").toHaveLength(1);
    expect(wrapUps[0]?.memberId).toBe(h.coordinator.id);
    expect(wrapUps[0]?.prompt).toContain(WRAP_UP_INSTRUCTION);
    expect(wrapUps[0]?.prompt).toContain(TERMINATION_MARKER);
    // The wrap-up is not charged to the budget it exists to escape.
    expect(h.rooms.getState(h.room.id).roundCount).toBe(2);
    h.close();
  });

  it("AC5.2: once the budget is spent, a mention creates no Task and is reported as blocked", () => {
    const h = setup({ maxRounds: 1 });
    h.trigger("请 @架构师 定方案");
    expect(h.rooms.getState(h.room.id).roundCount).toBe(1);

    // A second agent in the SAME turn would need a new user message to reset — but
    // the worker path is what normally continues a turn, so simulate it there by
    // consuming the budget, then re-run the guard for another target.
    const blocked = applyTriggerGuards(h.rooms, h.room, [h.qa], 300);
    expect(blocked.allowed).toEqual([]);
    expect(blocked.blocked[0]?.code).toBe("ROUND_CAP");
    expect(agentTasks(h.store)).toHaveLength(1);
    // The refusal is visible in the stream and the state did not move.
    expect(systemMessages(h.rooms, h.room.id).some((m) => m.includes("轮次上限"))).toBe(true);
    expect(h.rooms.getState(h.room.id).roundCount).toBe(1);
    h.close();
  });
});

describe("entry point B — agent handoff guards in the worker (I6)", () => {
  it("AC4.1: A→B→A blocks the second A, leaves a system message, and creates no Task", async () => {
    const h = setup();
    h.trigger("请 @架构师 开始");
    h.setReplies({ [h.arch.id]: "我交给 QA" }, { [h.arch.id]: [h.qa.id] });
    expect(await h.run("我交给 QA")).toBe(true);
    h.setReplies({ [h.qa.id]: "我交回架构师" }, { [h.qa.id]: [h.arch.id] });
    expect(await h.run("我交回架构师")).toBe(true);

    const chain = h.rooms.getState(h.room.id).chain;
    // The architect appears exactly once: the A→B→A request was refused.
    expect(chain).toEqual([h.arch.id, h.qa.id]);
    expect(h.rooms.getState(h.room.id).roundCount).toBe(2);
    const blocked = systemMessages(h.rooms, h.room.id).filter((m) => m.includes("循环"));
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toContain("架构师");
    // No child Task was queued for the refused handoff.
    expect(h.store.listTasks().filter((t) => t.memberId === h.arch.id)).toHaveLength(1);
    h.close();
  });

  it("AC5.1: the reply that lands on the cap queues the coordinator's forced wrap-up", async () => {
    const h = setup({ maxRounds: 1 });
    h.trigger("请 @架构师 开始");
    h.setReplies({ [h.arch.id]: "我交给 QA" }, { [h.arch.id]: [h.qa.id] });
    await h.run("我交给 QA");

    const wrapUps = h.store.listTasks().filter((t) => (t.idempotencyKey ?? "").startsWith("wrapup:"));
    expect(wrapUps).toHaveLength(1);
    expect(wrapUps[0]?.memberId).toBe(h.coordinator.id);
    // The instruction must be explicit enough that a model cannot read it as chatter.
    expect(wrapUps[0]?.prompt).toContain("强制收尾指令");
    expect(wrapUps[0]?.prompt).toContain(TERMINATION_MARKER);
    expect(wrapUps[0]?.prompt).toContain("不要");
    expect(wrapUps[0]?.groupId).toBe(h.room.id);
    // Not counted: the budget stays at the cap, so the wrap-up itself can still run.
    expect(h.rooms.getState(h.room.id).roundCount).toBe(1);
    h.close();
  });

  it("AC5.2: past the cap, a handoff creates no Task and is reported in the stream", async () => {
    const h = setup({ maxRounds: 1 });
    h.trigger("请 @架构师 开始");
    // The user message already spent the only round of the turn.
    h.rooms.recordTrigger(h.room.id, h.qa.id);
    h.setReplies({ [h.arch.id]: "我交给 QA" }, { [h.arch.id]: [h.qa.id] });
    await h.run("我交给 QA");

    // Architect keeps only its mention task; no child was dispatched.
    expect(agentTasks(h.store).filter((t) => t.memberId === h.qa.id)).toHaveLength(0);
    expect(systemMessages(h.rooms, h.room.id).some((m) => m.includes("轮次上限"))).toBe(true);
    h.close();
  });

  it("AC5.4: maxRounds=2 is enforced from the room row, not from the default 5", async () => {
    const h = setup({ maxRounds: 2 });
    h.trigger("请 @架构师 开始");
    // 2 rounds allowed; the user turn already used 1, so one handoff reaches the cap
    // and the next is refused — with the default of 5 both would have passed.
    h.setReplies({ [h.arch.id]: "交给 QA" }, { [h.arch.id]: [h.qa.id] });
    await h.run("交给 QA");
    expect(h.rooms.getState(h.room.id).roundCount).toBe(2);
    expect(h.store.listTasks().filter((t) => (t.idempotencyKey ?? "").startsWith("wrapup:"))).toHaveLength(1);

    h.setReplies({ [h.qa.id]: "再交给协调者" }, { [h.qa.id]: [h.coordinator.id] });
    await h.run("再交给协调者");
    expect(h.rooms.getState(h.room.id).roundCount).toBe(2);
    expect(systemMessages(h.rooms, h.room.id).some((m) => m.includes("轮次上限"))).toBe(true);
    h.close();
  });

  it("AC5.1 fallback: without a coordinator the cap is announced instead of forced", async () => {
    const h = setup({ maxRounds: 1, coordinator: false });
    // `addAgent` sets coordinator_agent_id when isCoordinator, so a room built with
    // `coordinator: false` has none — the branch that must not invent one.
    expect(h.rooms.getRoom(h.room.id)?.coordinatorAgentId).toBeNull();
    h.trigger("请 @架构师 开始");
    h.setReplies({ [h.arch.id]: "交给 QA" }, { [h.arch.id]: [h.qa.id] });
    await h.run("交给 QA");

    expect(h.store.listTasks().filter((t) => (t.idempotencyKey ?? "").startsWith("wrapup:"))).toHaveLength(0);
    const notes = systemMessages(h.rooms, h.room.id).filter((m) => m.includes("未指定协调者"));
    expect(notes).toHaveLength(1);
    h.close();
  });

  it("AC6.1: the coordinator's marker terminates the room and blocks later triggers", async () => {
    const h = setup();
    h.trigger("请 @架构师 定方案");
    h.setReplies(
      { [h.arch.id]: "方案在此", [h.coordinator.id]: `就到这里。${TERMINATION_MARKER}` },
      { [h.arch.id]: [h.coordinator.id] },
    );
    await h.run("方案在此");
    // The coordinator's own Task is the one that carries the marker.
    expect(await h.run("就到这里")).toBe(true);
    expect(h.rooms.getState(h.room.id).terminated).toBe(true);

    // A later handoff in the same turn is refused by TERMINATED, not merely by LOOP.
    h.rooms.recordTrigger(h.room.id, "agent-x");
    const decision = evaluateTrigger(h.rooms.getState(h.room.id), h.room, h.qa.id);
    expect(decision.code).toBe("TERMINATED");
    expect(h.store.listTasks().filter((t) => t.memberId === h.qa.id)).toHaveLength(0);
    // The termination itself is announced in the stream, not only written to a column.
    expect(systemMessages(h.rooms, h.room.id).some((m) => m.includes("宣布讨论结束"))).toBe(true);
    h.close();
  });

  it("AC6.2: a non-coordinator's marker is ignored, warned about, and the room keeps running", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = setup();
    h.trigger("请 @架构师 定方案");
    h.setReplies({ [h.arch.id]: `我认为可以结束。${TERMINATION_MARKER}` });
    await h.run(`我认为可以结束。${TERMINATION_MARKER}`);

    expect(h.rooms.getState(h.room.id).terminated).toBe(false);
    expect(warn.mock.calls.some((call) => String(call[0]).includes("非协调者"))).toBe(true);
    const note = systemMessages(h.rooms, h.room.id).filter((m) => m.includes("被忽略"));
    expect(note).toHaveLength(1);
    expect(note[0]).toContain("架构师");
    warn.mockRestore();
    h.close();
  });

  it("AC7.2 + I6: a crash replay re-claims the Task without counting its round twice", async () => {
    const h = setup();
    const posted = h.trigger("请 @架构师 定方案");
    const taskId = posted.tasks[0]!.id;
    h.setReplies({ [h.arch.id]: "交给 QA", [h.qa.id]: "QA 收到" }, { [h.arch.id]: [h.qa.id] });
    expect(await h.run("交给 QA")).toBe(true);
    const firstState = h.rooms.getState(h.room.id);
    expect(firstState).toMatchObject({ roundCount: 2, chain: [h.arch.id, h.qa.id] });
    const child = h.store.listTasks().find((t) => t.parentTaskId === taskId);
    expect(child?.memberId).toBe(h.qa.id);

    // Crash replay: re-queue the SAME Task, exactly as `room-reply.test.ts` does.
    // The child exists and the round was recorded, so the replay must add neither.
    h.store.db.prepare(
      "UPDATE tasks SET status='queued', batch_attempts=0, available_at=200, active_attempt_id=NULL WHERE id=?",
    ).run(taskId);
    expect(await h.run("交给 QA")).toBe(true);

    const replayed = h.rooms.getState(h.room.id);
    expect(replayed.roundCount, "rounds are not double-counted").toBe(firstState.roundCount);
    expect(replayed.chain, "the chain is not extended by a replay").toEqual(firstState.chain);
    // No duplicate system message either, and the handoff child is still there once.
    expect(systemMessages(h.rooms, h.room.id).filter((m) => m.includes("循环"))).toEqual([]);
    expect(h.store.listTasks().filter((t) => t.parentTaskId === taskId)).toHaveLength(1);
    expect(h.rooms.listMessages(h.room.id).filter((m) => m.authorKind === "agent")).toHaveLength(1);
    h.close();
  });

  it("AC4.3: a legal chain user→A→B→coordinator is never mistaken for a loop", async () => {
    const h = setup();
    h.trigger("请 @架构师 定方案");
    h.setReplies(
      { [h.arch.id]: "交给 QA", [h.qa.id]: "交给协调者", [h.coordinator.id]: "汇总完毕" },
      { [h.arch.id]: [h.qa.id], [h.qa.id]: [h.coordinator.id] },
    );
    await h.run("交给 QA");
    expect(await h.run("交给协调者")).toBe(true);
    expect(await h.run("汇总完毕")).toBe(true);
    expect(await h.run("不该再有任务")).toBe(false);

    // Three agent triggers, each distinct: the chain is exactly the path taken and
    // the guard never fired on a legal link.
    expect(h.rooms.getState(h.room.id).chain).toEqual([h.arch.id, h.qa.id, h.coordinator.id]);
    expect(h.rooms.getState(h.room.id).roundCount).toBe(3);
    expect(systemMessages(h.rooms, h.room.id).filter((m) => m.includes("循环"))).toEqual([]);
    expect(h.store.listTasks().filter((t) => t.status === "succeeded")).toHaveLength(3);
    h.close();
  });

  it("AC5.1 + AC6.1: the forced wrap-up runs, its marker ends the room, and no later handoff dispatches", async () => {
    // maxRounds=2: the mention spends one round and the architect's handoff lands
    // exactly on the second, so entry point B queues the wrap-up mid-chain.
    const h = setup({ maxRounds: 2 });
    const posted = h.trigger("请 @架构师 定方案");
    expect(posted.tasks).toHaveLength(1);
    h.setReplies(
      { [h.arch.id]: "交给 QA", [h.qa.id]: "QA 说还要看", [h.coordinator.id]: `结论已定。${TERMINATION_MARKER}` },
      { [h.arch.id]: [h.qa.id] },
    );

    expect(await h.run("交给 QA")).toBe(true);
    const wrapUp = h.store.listTasks().find((t) => (t.idempotencyKey ?? "").startsWith("wrapup:"));
    expect(wrapUp?.memberId).toBe(h.coordinator.id);
    expect(wrapUp?.prompt).toContain(WRAP_UP_INSTRUCTION);

    await h.run("QA 说还要看");
    expect(await h.run("结论已定")).toBe(true);
    expect(await h.run("不该再有任务")).toBe(false);

    expect(h.rooms.getState(h.room.id).terminated).toBe(true);
    // The wrap-up was not charged to the budget: mention + handoff are the two rounds.
    expect(h.rooms.getState(h.room.id)).toMatchObject({ roundCount: 2, chain: [h.arch.id, h.qa.id] });
    expect(h.store.getTask(wrapUp!.id)?.status).toBe("succeeded");
    h.close();
  });

  it("does not break the pure P6 path: no groupId, or no RoomStore wired", async () => {
    // (a) a Task without a room never touches room state.
    const plain = new ExecutionStore(":memory:");
    const rooms = new RoomStore(plain.db);
    const room = rooms.createRoom({ projectId: "p", name: "群" }, 100);
    plain.createTask(
      { tenantId: "t", projectId: "p", memberId: "solo", workspacePath: "/tmp", prompt: "solo work" }, 100,
    );
    const solo = createDurableWorker(plain, {
      adapterFor: () => adapterFor("done", []), rooms, now: () => 200,
    });
    expect(await solo.runOnce()).toBe(true);
    expect(await solo.runOnce()).toBe(false);
    expect(rooms.listMessages(room.id)).toEqual([]);
    expect(rooms.getState(room.id)).toMatchObject({ roundCount: 0, chain: [], terminated: false });
    plain.close();

    // (b) the same group Task with no RoomStore wired behaves exactly as before.
    const detachedStore = new ExecutionStore(":memory:");
    const detachedRooms = new RoomStore(detachedStore.db);
    const detachedRoom = detachedRooms.createRoom({ projectId: "p", name: "群" }, 100);
    const detachedAgent = detachedRooms.addAgent({
      roomId: detachedRoom.id, name: "QA", prompt: "You test.", agentDir: "/persona/qa",
    }, 100);
    postRoomMessage(detachedRooms, detachedStore, {
      roomId: detachedRoom.id, content: "请 @QA 看", tenantId: "t", workspacePath: "/tmp", now: 100,
    });
    const detached = createDurableWorker(detachedStore, { adapterFor: () => adapterFor("无房间可写") });
    expect(await detached.runOnce()).toBe(true);
    // The mention task succeeded; nothing beyond the user message was written.
    expect(detachedRooms.listMessages(detachedRoom.id).map((m) => m.authorKind)).toEqual(["user"]);
    expect(detachedStore.listTasks()[0]?.status).toBe("succeeded");
    // The user-trigger path still owns the guard (it always gets the RoomStore), but
    // the unwired WORKER added nothing to the stream: no reply, no guard note.
    expect(detachedRooms.getState(detachedRoom.id).roundCount).toBe(1);
    expect(systemMessages(detachedRooms, detachedRoom.id)).toEqual([]);
    expect(detachedAgent.roomId).toBe(detachedRoom.id);
    detachedStore.close();
  });
});

describe("flow state is durable, not in-memory (AC6.4/AC7.1)", () => {
  it("AC7.1: round count, chain and terminated are readable back from SQLite", () => {
    const h = setup();
    h.trigger("请 @架构师 定方案");
    h.rooms.recordTrigger(h.room.id, h.qa.id);
    h.rooms.markTerminated(h.room.id);
    const read = h.rooms.getState(h.room.id);
    expect(read).toMatchObject({ roundCount: 2, chain: [h.arch.id, h.qa.id], terminated: true });
    // Straight from the table, not from a cached object.
    const row = h.store.db.prepare("SELECT round_count,chain,terminated FROM room_state WHERE room_id=?")
      .get(h.room.id) as { round_count: number; chain: string; terminated: number };
    expect(Number(row.round_count)).toBe(2);
    expect(JSON.parse(row.chain)).toEqual([h.arch.id, h.qa.id]);
    expect(Number(row.terminated)).toBe(1);
    h.close();
  });

  it("AC6.4: terminated survives closing and reopening the database file", async () => {
    const file = join(tempDir, "persist.sqlite");
    // The API process and the Worker process normally open the SAME file; here the
    // first instance plays "before the restart" and the second "after".
    const first = new RoomStore(file);
    const room = first.createRoom({ projectId: "p", name: "群", maxRounds: 3 }, 100);
    first.recordTrigger(room.id, "agent-a", 110);
    first.markTerminated(room.id, 120);
    first.close();

    const second = new RoomStore(file);
    const reopened = second.getState(room.id);
    expect(reopened.terminated).toBe(true);
    expect(reopened.roundCount).toBe(1);
    expect(reopened.chain).toEqual(["agent-a"]);
    // And the reopened state still blocks: durability that nothing reads is a souvenir.
    const decision = evaluateTrigger(reopened, second.getRoom(room.id)!, "agent-b");
    expect(decision.code).toBe("TERMINATED");
    second.close();

  });

  it("AC6.4 (end to end): after a restart the reopened room still blocks a handoff", async () => {
    const file = join(tempDir, "restart-exec.sqlite");
    const before = new ExecutionStore(file);
    const beforeRooms = new RoomStore(before.db);
    const room = beforeRooms.createRoom({ projectId: "p", name: "群", maxRounds: 5 }, 100);
    const arch = beforeRooms.addAgent({
      roomId: room.id, name: "架构师", prompt: "You design.", agentDir: "/persona/arch",
    }, 100);
    const qa = beforeRooms.addAgent({
      roomId: room.id, name: "QA", prompt: "You test.", agentDir: "/persona/qa",
    }, 101);
    // The turn is closed by the coordinator, and a handoff Task is already queued.
    beforeRooms.markTerminated(room.id, 120);
    before.createTask({
      tenantId: "t", projectId: "p", memberId: arch.id, workspacePath: "/tmp",
      prompt: "handoff to QA", groupId: room.id, agentDir: arch.agentDir,
    }, 130);
    before.close();

    // "Restart": brand new handles over the same file, exactly how server.ts and
    // worker.ts open the database in separate processes.
    const after = new ExecutionStore(file);
    const afterRooms = new RoomStore(after.db);
    const worker = createDurableWorker(after, {
      adapterFor: () => adapterFor("我交给 QA", [qa.id]), rooms: afterRooms, now: () => 200,
    });
    expect(await worker.runOnce()).toBe(true);

    // The architect ran (its Task existed before the restart and was re-claimed),
    // but the handoff it asked for produced no child: the reopened flag blocked it.
    expect(after.listTasks().filter((t) => t.memberId === qa.id)).toHaveLength(0);
    // Nothing was recorded: the refused handoff is neither a round nor a chain link,
    // and the persisted state is untouched apart from its `terminated` flag.
    expect(afterRooms.getState(room.id)).toMatchObject({ chain: [], terminated: true });
    const notes = afterRooms.listMessages(room.id).filter((m) => m.authorKind === "system");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.content).toContain("已终止");
    after.close();
  });

  it("room state written inside the Task transaction is rolled back with it", () => {
    // The guard writes rounds/messages from inside a transaction the ExecutionStore
    // opened. That nesting must keep the outer unit of work: without it, a failure
    // after the write would leave a counted round with no Task behind it.
    const h = setup();
    const before = h.rooms.getState(h.room.id);
    expect(() => h.store.transaction(() => {
      h.rooms.recordTrigger(h.room.id, h.arch.id);
      h.rooms.appendMessage({ roomId: h.room.id, authorKind: "system", content: "不该留下" }, 210);
      throw new Error("simulated failure after the guard wrote");
    })).toThrow("simulated failure");
    const after = h.rooms.getState(h.room.id);
    expect(after).toEqual(before);
    expect(h.rooms.listMessages(h.room.id)).toEqual([]);
    h.close();
  });
});
