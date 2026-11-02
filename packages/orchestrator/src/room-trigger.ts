/**
 * `@mention` trigger for a ChatRoom (I3): one user message -> one Task per target,
 * and (I4) the whole shared stream injected into each Task's prompt.
 *
 * Three things happen in this order:
 *  1. ambiguous / unknown / absent mentions are refused with a code the API can
 *     show (AC2.5: a bad `@` is an answer, never a silent no-op);
 *  2. the message and every Task commit under ONE transaction, so a failure in
 *     the middle cannot leave a message whose agents were never triggered — nor a
 *     Task with no message behind it;
 *  3. `groupId = roomId` is stamped, which is what makes the queue serialise the
 *     room (`ExecutionStore.claimNext`, AC3).
 *
 * A message with no mention is refused rather than stored as idle chat, because a
 * stored message nobody answers is the same silent failure the 4xx exists to
 * avoid.
 *
 * I5 and the asymmetry it deliberately does NOT copy: an agent's own reply is
 * parsed for `@name` too (Q34's secondary path, in `durable-worker.ts`), but with
 * the opposite failure policy. Here an unknown/ambiguous `@` is the USER's mistake
 * and must be answered immediately with 4xx — nothing is written. On the agent
 * path it is the model's prose glitch, and failing the Task would void a run that
 * already produced a valid structured result, while dropping it in silence is the
 * invisible no-op we refuse for users. So that path records the unresolved names
 * as a system message and lets the run succeed. Two policies, one deliberate: see
 * the note on `collectMentionHandoffs`.
 *
 * I6 adds a step between (1) and (2): inside the transaction the turn's flow state
 * is reset and every target passes the flow guards, so "the message landed" and
 * "this trigger was allowed / refused" commit together. See `applyTriggerGuards`
 * and `queueWrapUpTask` below — the same two rules the worker applies to handoffs.
 */

import type { ChatRoom, RoomAgent, RoomMessage } from "@my-team-agents/domain";
import { ExecutionStore } from "./execution-store.js";
import { resolveMentions } from "./mention.js";
import { evaluateTrigger, formatBlockReason, WRAP_UP_INSTRUCTION, type GuardBlockCode } from "./room-guards.js";
import { RoomStore } from "./room-store.js";

/** Rejected for a reason the caller can surface verbatim. */
export type RoomTriggerErrorCode =
  | "ROOM_NOT_FOUND"
  | "CONTENT_REQUIRED"
  | "NO_MENTION"
  | "AMBIGUOUS_MENTION"
  | "UNKNOWN_MENTION";

export class RoomTriggerError extends Error {
  readonly code: RoomTriggerErrorCode;
  /** The offending `@names`, so the response can list them. */
  readonly names: string[];
  /** The message without the `[CODE] ` prefix — what an API response should show. */
  readonly detail: string;

  constructor(code: RoomTriggerErrorCode, message: string, names: string[] = []) {
    super(`[${code}] ${message}`);
    this.name = "RoomTriggerError";
    this.code = code;
    this.names = names;
    this.detail = message;
  }
}

export interface PostRoomMessageInput {
  roomId: string;
  content: string;
  tenantId: string;
  /** Project workspace the Tasks point at; agentDir overrides the child cwd (PiAdapter). */
  workspacePath: string;
  /** Task attribution project; defaults to the room's own. */
  projectId?: string;
  now?: number;
}

export interface PostedRoomMessage {
  message: RoomMessage;
  /** Created Tasks in mention order; `memberId` is the RoomAgent id. */
  tasks: Array<{ id: string; memberId: string }>;
  /**
   * I6: targets a flow guard refused. Not an error — the user message and the
   * system message explaining the refusal are already committed — so the API
   * answers 2xx with this list instead of a 4xx.
   */
  blocked: Array<{ memberId: string; code: GuardBlockCode; reason: string }>;
}

/**
 * How many of the newest room messages get injected into one prompt (I4).
 * Exported so the caller truncates with the same number it reports, and so a
 * test can prove the cut is never silent.
 */
export const ROOM_HISTORY_LIMIT = 500;

/** `- <name>（<role>）`, plus `（协调者）`; empty role is omitted entirely. */
const memberLine = (member: RoomAgent): string => {
  const named = member.role.trim() ? `${member.name}（${member.role.trim()}）` : member.name;
  return member.isCoordinator ? `${named}（协调者）` : named;
};

/**
 * D5-b: how a member may be addressed by `handoff_to`. This roster block is the
 * ONLY place in the injected prompt where a model can read any identifier at all,
 * so every form `resolveRosterTokens` accepts is spelled out here — and the line
 * keeps `memberLine`'s text byte-for-byte, only appending after it, because the
 * existing assertions (and Q39's "replay the same bytes verbatim") are pinned on
 * `- <name>（<role>）（协调者）`.
 */
const HANDOFF_ROSTER_HINT =
  "可交接的成员：toMemberIds 写下面的名字、角色或 id 均可，需逐个精确匹配；重名不猜。";

const rosterLine = (member: RoomAgent): string => `- ${memberLine(member)}｜id: ${member.id}`;

/**
 * Who produced one history line. A deleted agent still has its message: the id
 * is better evidence than nothing, and dropping history would silently change
 * what the agent sees (Q30).
 */
const authorLabel = (message: RoomMessage, names: Map<string, string>): string => {
  if (message.authorKind === "user") return "用户";
  if (message.authorKind === "system") return "系统";
  const agentId = message.authorAgentId;
  if (!agentId) return "未知成员";
  return names.get(agentId) ?? agentId;
};

/**
 * The prompt for one group-chat trigger (I4, Q30): role prompt, room identity,
 * member roster and the shared history — including what the OTHER agents said.
 * That is what makes this a group chat rather than parallel private chats.
 *
 * Sections are emitted in a fixed order, and history lines are sorted by `seq`,
 * so the text is stable enough to assert on and to replay identically after a
 * crash (Q31: replay re-injects the same history; it does not resume a session).
 *
 * `omitted` is how many older messages the caller had to drop at the limit; any
 * history longer than `ROOM_HISTORY_LIMIT` is trimmed here too. Either way the
 * trimming is announced inside 「# 群聊记录」 — a silent cut would let the agent
 * believe it saw the whole conversation.
 *
 * D5-b: every roster line also carries the member's id after `｜id: `, and the
 * block opens with one line saying what `handoff_to` accepts. A model can only
 * dispatch to a colleague it can name, and until this the injected prompt held
 * zero identifiers — so the primary path was unusable without the model going
 * and reading import files. The original `memberLine` text and the section order
 * are unchanged: the id rides at the END of the line, so 「# 成员」 stays
 * replay-identical for everything before `｜id: ` (Q39).
 */
export function buildRoomPrompt(
  room: ChatRoom,
  agent: RoomAgent,
  members: RoomAgent[],
  history: RoomMessage[],
  omitted = 0,
): string {
  const names = new Map(members.map((member) => [member.id, member.name]));
  const ordered = [...history].sort((a, b) => a.seq - b.seq);
  const shown = ordered.length > ROOM_HISTORY_LIMIT
    ? ordered.slice(ordered.length - ROOM_HISTORY_LIMIT)
    : ordered;
  const hidden = Math.max(0, omitted) + (ordered.length - shown.length);

  const blocks: string[] = [agent.prompt.trim(), `# 角色：${memberLine(agent)}`, `# 群：${room.name}`];
  if (room.rules.trim()) blocks.push(`# 群规则\n${room.rules.trim()}`);
  blocks.push(`# 成员\n${members.length > 0
    ? `${HANDOFF_ROSTER_HINT}\n${members.map(rosterLine).join("\n")}`
    : "（暂无成员）"}`);
  const lines: string[] = ["# 群聊记录"];
  if (hidden > 0) lines.push(`（已省略较早的 ${hidden} 条消息）`);
  lines.push(shown.length > 0
    ? shown.map((m) => `[${m.seq}] ${authorLabel(m, names)}: ${m.content}`).join("\n")
    : "（暂无消息）");
  blocks.push(lines.join("\n"));

  blocks.push(`# 你的任务
请针对上面「群聊记录」里最新的一条消息发言：
- 不要重复其他成员已经说过的内容；
- 不要复述整段群聊记录；
- 按要求输出结构化结果，其中 summary 会被原样发回群里。`);
  return blocks.join("\n\n");
}

/** A group child Task may be appended with the dispatcher's own words (D6). */
export interface DispatchSource {
  /** The Task whose reply is dispatching: identifies the newest history line. */
  taskId: string;
  /** Member id of the dispatcher, used for the line's author and the heading. */
  speakerId: string;
  /** What the dispatcher said — the reply that will land in the stream. */
  text: string;
  now: number;
}

/**
 * One read of the room, shared by every child Task THIS run dispatches (D6).
 *
 * Held in a caller-owned box so both dispatch paths render from the SAME bytes:
 * reading per target would let a user message posted mid-run give the `handoff_to`
 * children a different history than the `@name` children of the very same reply,
 * and two children of one batch would then disagree about what the room said.
 */
export interface DispatchSnapshot {
  room: ChatRoom;
  members: RoomAgent[];
  /** The stream as stored, with the dispatching reply appended as the newest line. */
  history: RoomMessage[];
  /** How many older messages the limit dropped (announced, never silent — Q39). */
  omitted: number;
  /** The dispatching member's name, for the heading of the appended instruction. */
  speakerName: string;
}

/**
 * Read the room once for a run that is about to dispatch children.
 *
 * The dispatching reply is NOT in `room_messages` yet — it commits in the same
 * transaction as these child rows, after them — so it is appended here under a
 * synthetic id. The child therefore reads exactly what the room is about to read;
 * a target triggered by a message it cannot see would be answering a question
 * nobody asked.
 * Two shapes of the same fact must yield the same bytes: on the first pass the reply
 * is not stored yet, so it is appended as the newest line under a synthetic id; on a
 * crash replay (`appendAgentReply` committed, the Worker died before acking) it IS
 * stored, and then the stored row is kept in place instead of a second copy being
 * appended. Either way the child reads the reply exactly once, at the same seq —
 * every history line is labelled `[seq]`, so a duplicated sentence or a shifted seq
 * would rewrite the whole stream, and Q39 asks for the same injection to be
 * re-playable, not merely for the same rows to exist.
 */
export function snapshotDispatch(
  rooms: RoomStore,
  room: ChatRoom,
  source: DispatchSource,
): DispatchSnapshot {
  const members = rooms.listAgents(room.id);
  const window = rooms.listMessages(room.id, ROOM_HISTORY_LIMIT);
  // `omitted` is measured against the window AS STORED — the same measure
  // `postRoomMessage` uses — so the truncation announcement never moves.
  const omitted = Math.max(0, rooms.countMessages(room.id) - window.length);
  const alreadySpoken = window.some((message) => message.taskId === source.taskId);
  const history: RoomMessage[] = alreadySpoken
    ? window
    : [...window, {
        id: `synthetic-${source.taskId}`,
        roomId: room.id,
        // Nothing is dropped on this branch, so the newest stored seq + 1 is exactly
        // the seq `appendAgentReply` will give the row when it lands.
        seq: (window.at(-1)?.seq ?? 0) + 1,
        authorKind: "agent",
        authorAgentId: source.speakerId,
        content: source.text,
        taskId: source.taskId,
        createdAt: source.now,
      }];
  return {
    room,
    members,
    omitted,
    speakerName: members.find((member) => member.id === source.speakerId)?.name ?? source.speakerId,
    history,
  };
}

/**
 * The prompt for a Task dispatched BY an agent, on either path (D6): the exact same
 * injection a user trigger gets (persona + room identity + shared stream — AC2.3),
 * plus — when the dispatcher wrote one — its own instruction for the target.
 *
 * ONE implementation for both paths (Q34). The `@name` path passes no `work`; the
 * `handoff_to` path passes `workPackage`/`reason`. That is the ONLY difference
 * between the two children, so what a triggered colleague sees can be changed in
 * exactly one place. Before this, only the secondary path injected the room at all:
 * a `handoff_to` child arrived with bare prose — no role prompt, no room, no
 * history — which is what a real acceptance run measured ("请回一句话确认收到即可…")
 * and Q30/I4 forbid.
 *
 * `work` is appended AFTER 「# 你的任务」, last, the way `queueWrapUpTask` appends
 * the platform directive: it must read as the dispatcher's instruction to this
 * agent, never as another member's opinion inside the stream.
 */
export function buildDispatchPrompt(
  snapshot: DispatchSnapshot,
  agent: RoomAgent,
  work?: string,
): string {
  const base = buildRoomPrompt(
    snapshot.room, agent, snapshot.members, snapshot.history, snapshot.omitted,
  );
  const instruction = work?.trim();
  if (!instruction) return base;
  return `${base}

# 交接任务说明（来自 ${snapshot.speakerName}，平台附在群聊注入之后）
${instruction}`;
}

/** The seq of the newest user message in a window, 0 if there is none. */
const lastUserSeq = (history: RoomMessage[]): number => {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]!.authorKind === "user") return history[i]!.seq;
  }
  return 0;
};

/**
 * Queue the coordinator's forced wrap-up Task (AC5.1), or say in the stream why it
 * cannot be queued. Shared by both guard entry points — a user message that mentions
 * enough agents can consume the whole round budget just as a chain of handoffs can,
 * and AC5.1 does not distinguish the two, so only one implementation may exist.
 *
 * Must be called inside the caller's transaction: the wrap-up and the round that
 * reached the cap commit together or not at all.
 *
 * The Task is created directly, never through `evaluateTrigger`: it is not counted as
 * a round, because charging the coordinator for the budget it needs to close the
 * discussion would spend the last round of the budget on the escape hatch itself.
 *
 * Idempotent per (room, user turn), so a replayed Attempt cannot queue a second
 * one — and a later turn that also hits the cap (round counts always reset to the
 * same numbers) still gets its own.
 */
export function queueWrapUpTask(
  rooms: RoomStore,
  executions: ExecutionStore,
  options: {
    room: ChatRoom;
    /** Round count the cap was hit at — only used for the system message. */
    rounds: number;
    /** Attribution copied from the Task/message that reached the cap. */
    tenantId: string;
    projectId: string;
    workspacePath: string;
    now: number;
  },
): string | null {
  const { room, now } = options;
  if (rooms.getState(room.id).terminated) return null;
  const capLine = `【流程守卫·轮次上限】本轮已达上限（${options.rounds}/${room.maxRounds}）`;
  const coordinator = room.coordinatorAgentId ? rooms.getAgent(room.coordinatorAgentId) : null;
  if (!coordinator) {
    // Nothing to push: report that in the stream instead of pretending a forced
    // ending was scheduled. The cap itself still blocks every later trigger.
    rooms.appendMessage({
      roomId: room.id,
      authorKind: "system",
      content: room.coordinatorAgentId
        ? `${capLine}，但找不到协调者 ${room.coordinatorAgentId}，无法强制收尾；后续 agent 触发将被阻断。`
        : `${capLine}，且本群未指定协调者，无法强制收尾；后续 agent 触发将被阻断，用户发送新消息可重新开始。`,
    }, now);
    return null;
  }
  const members = rooms.listAgents(room.id);
  const history = rooms.listMessages(room.id, ROOM_HISTORY_LIMIT);
  // The turn this belongs to: the newest user message in the window. A replay
  // inside the same turn reuses the key (one wrap-up), a later turn that also
  // hits the cap gets a fresh one instead of being deduped onto the first.
  const turnKey = lastUserSeq(history);
  const omitted = Math.max(0, rooms.countMessages(room.id) - history.length);
  const task = executions.createTask({
    tenantId: options.tenantId,
    projectId: options.projectId,
    memberId: coordinator.id,
    workspacePath: options.workspacePath,
    ...(coordinator.agentDir ? { agentDir: coordinator.agentDir } : {}),
    // The coordinator still sees the whole discussion (I4); the platform's directive
    // is appended last so it cannot be mistaken for another member's opinion.
    prompt: `${buildRoomPrompt(room, coordinator, members, history, omitted)}\n\n${WRAP_UP_INSTRUCTION}`,
    // Still the room's serialisation key: the wrap-up queues behind the room's
    // running Task, never beside it.
    groupId: room.id,
    model: coordinator.model ?? undefined,
    idempotencyKey: `wrapup:${room.id}:turn${turnKey}`,
  }, now);
  rooms.appendMessage({
    roomId: room.id,
    authorKind: "system",
    content: `${capLine}，平台已向协调者 ${coordinator.name} 下发强制收尾指令（不计入轮次）。`,
  }, now);
  return task.id;
}

/**
 * I6 entry point A's write half: run every target through `evaluateTrigger`, count a
 * round for each that passes, and leave a system message for each that does not.
 *
 * Extracted rather than inlined for one reason: the refusal path is otherwise
 * unreachable through `postRoomMessage` in production (`resolveMentions` dedupes
 * targets, and the chain was just reset), so an inlined branch would be untested
 * code pretending to be a guard. Here a test can drive it with a duplicated target
 * or a pre-populated chain and assert the real behaviour (AC4.1).
 *
 * Either way the batch must arrive ALREADY deduplicated by target: a repeated
 * target reaching `evaluateTrigger` would be refused as LOOP, which reports a
 * dedup as a cycle — `resolveMentions` folds it here (Q35), and the worker path
 * folds both dispatch paths with `dedupeByOrigin` before judging.
 *
 * Must be called inside the caller's transaction: the system message and the round
 * count have to commit together, or a crash leaves one without the other.
 */
export function applyTriggerGuards(
  rooms: RoomStore,
  room: ChatRoom,
  targets: readonly RoomAgent[],
  now: number,
): {
  allowed: RoomAgent[];
  blocked: PostedRoomMessage["blocked"];
  reachesCap: boolean;
} {
  const allowed: RoomAgent[] = [];
  const blocked: PostedRoomMessage["blocked"] = [];
  let reachesCap = false;
  for (const agent of targets) {
    // Re-read per target: an earlier allowed target already advanced the chain and
    // the round count, so a message that names the same agent twice is refused the
    // second time (LOOP) instead of being dispatched twice.
    const decision = evaluateTrigger(rooms.getState(room.id), room, agent.id);
    if (!decision.allowed) {
      const reason = formatBlockReason(agent.name, decision);
      rooms.appendMessage({ roomId: room.id, authorKind: "system", content: reason }, now);
      blocked.push({ memberId: agent.id, code: decision.code!, reason });
      continue;
    }
    rooms.recordTrigger(room.id, agent.id, now);
    allowed.push(agent);
    if (decision.reachesCap) reachesCap = true;
  }
  return { allowed, blocked, reachesCap };
}

/**
 * Append one user message to a room and queue a Task per mentioned agent.
 *
 * `rooms` and `executions` must share one `DatabaseSync` handle — how the server
 * wires them, and what lets a single `BEGIN IMMEDIATE` cover both tables.
 *
 * I6 changes what a successful POST can contain: the user message opens a NEW
 * user turn, so flow state is reset first (AC4.2 chain, AC5.3 rounds, AC6.3
 * terminated), then every target passes `evaluateTrigger` before it gets a Task,
 * and an allowed target is recorded as one round.
 *
 * Two failure classes stay distinct, and the route layer maps them differently:
 *  - `RoomTriggerError` = the request itself is wrong (no such room, no valid
 *    `@`), so nothing is written and the answer is 4xx;
 *  - a guard block = a well-formed request the platform refused to act on. The
 *    message and an explanatory system message ARE committed and the answer is
 *    2xx with `blocked` populated. Rolling back a guard block would delete the
 *    user's own words, which is the opposite of "the stream is the record".
 */
export function postRoomMessage(
  rooms: RoomStore,
  executions: ExecutionStore,
  input: PostRoomMessageInput,
): PostedRoomMessage {
  if (rooms.db !== executions.db) {
    throw new Error("postRoomMessage needs RoomStore and ExecutionStore over one database handle");
  }
  const content = input.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new RoomTriggerError("CONTENT_REQUIRED", "消息内容不能为空");
  }
  const room = rooms.getRoom(input.roomId);
  if (!room) throw new RoomTriggerError("ROOM_NOT_FOUND", `找不到群：${input.roomId}`);

  const agents = rooms.listAgents(room.id);
  const { targets, unknown, ambiguous } = resolveMentions(content, agents);

  // Ambiguity first: duplicate room names are an import hazard we report rather
  // than resolve by coin flip — and the same is true of a `role` two members
  // share, which `resolveMentions` folds into this one list (D2). `unknown` is
  // only ever a name nobody declares: code notation like `@ts-ignore` is dropped
  // in the resolver, so a human pasting a directive never gets this 4xx (D4).
  if (ambiguous.length > 0) {
    throw new RoomTriggerError(
      "AMBIGUOUS_MENTION",
      `群内有重名 agent，无法确定 @${ambiguous.join(" / ")} 指谁；请先给成员改出唯一名字`,
      ambiguous,
    );
  }
  if (targets.length === 0) {
    if (unknown.length > 0) {
      throw new RoomTriggerError(
        "UNKNOWN_MENTION",
        `群里没有这些 agent：@${unknown.join(" / ")}；用 GET /api/rooms/${room.id}/agents 查看可用名字`,
        unknown,
      );
    }
    throw new RoomTriggerError("NO_MENTION", "消息里没有 @ 提及；I3 只做提及触发，不落纯聊天");
  }

  const now = input.now ?? Date.now();
  return executions.transaction(() => {
    const message = rooms.appendMessage({ roomId: room.id, authorKind: "user", content }, now);
    // I6 entry point A: a user message is the start of a new turn, so the chain,
    // the round counter and `terminated` are cleared BEFORE any guard looks at
    // them. Resetting after the Tasks were created would let the previous turn's
    // chain block this turn's targets (AC4.2/AC5.3/AC6.3 all read as one rule).
    rooms.resetState(room.id, now);
    // I4: read the stream AFTER the append, so the current user message is the last
    // history line. Adding a separate "用户消息" section on top of that would show
    // the same message twice.
    const history = rooms.listMessages(room.id, ROOM_HISTORY_LIMIT);
    // `countMessages` is what makes the cut visible: the window can only report
    // what it kept, never what it dropped.
    const omitted = Math.max(0, rooms.countMessages(room.id) - history.length);

    // I6 entry point A. `resolveMentions` already deduped these targets, so in
    // production the guards pass; the call is not a formality though — it is what
    // makes "no trigger without a recorded round" a single rule for both entry
    // points, and what `room-guards.test.ts` drives directly to prove the blocked
    // branch writes a system message and creates no Task.
    const { allowed, blocked, reachesCap } = applyTriggerGuards(rooms, room, targets, now);

    const created = allowed.map((agent) => executions.createTask({
      tenantId: input.tenantId,
      projectId: input.projectId ?? room.projectId,
      memberId: agent.id,
      workspacePath: input.workspacePath,
      // Reaches Pi as the child cwd: persona resources are discovered from cwd.
      agentDir: agent.agentDir,
      // Q30: the same shared history for every target, each one wrapped in its
      // OWN role prompt — group chat, not parallel private chats.
      prompt: buildRoomPrompt(room, agent, agents, history, omitted),
      // The serialisation key: every later task in this room queues behind this one.
      groupId: room.id,
      model: agent.model ?? undefined,
      // Keyed by (message, agent): one message can never queue the same persona
      // twice. A repeated POST is a NEW message with new Tasks — there is no client
      // idempotency key on this endpoint yet (that is the P7b auth/guards issue).
      idempotencyKey: `mention:${message.id}:${agent.id}`,
    }, now));
    // AC5.1/AC5.4: this turn's mentions consumed the budget, so the forced ending is
    // scheduled now, in the same commit. No extra round is charged for it.
    if (reachesCap) {
      queueWrapUpTask(rooms, executions, {
        room,
        rounds: rooms.getState(room.id).roundCount,
        tenantId: input.tenantId,
        projectId: input.projectId ?? room.projectId,
        workspacePath: input.workspacePath,
        now,
      });
    }
    return {
      message,
      tasks: created.map((task) => ({ id: task.id, memberId: task.memberId })),
      blocked,
    };
  });
}
