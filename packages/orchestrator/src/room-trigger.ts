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
 * avoid. Flow guards are I6.
 */

import type { ChatRoom, RoomAgent, RoomMessage } from "@my-team-agents/domain";
import { ExecutionStore } from "./execution-store.js";
import { resolveMentions } from "./mention.js";
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
  blocks.push(`# 成员\n${members.length > 0 ? members.map((m) => `- ${memberLine(m)}`).join("\n") : "（暂无成员）"}`);

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

/**
 * Append one user message to a room and queue a Task per mentioned agent.
 *
 * `rooms` and `executions` must share one `DatabaseSync` handle — how the server
 * wires them, and what lets a single `BEGIN IMMEDIATE` cover both tables.
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
  // than resolve by coin flip.
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
    // I4: read the stream AFTER the append, so the current user message is the last
    // history line. Adding a separate "用户消息" section on top of that would show
    // the same message twice.
    const history = rooms.listMessages(room.id, ROOM_HISTORY_LIMIT);
    // `countMessages` is what makes the cut visible: the window can only report
    // what it kept, never what it dropped.
    const omitted = Math.max(0, rooms.countMessages(room.id) - history.length);
    const created = targets.map((agent) => executions.createTask({
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
    return { message, tasks: created.map((task) => ({ id: task.id, memberId: task.memberId })) };
  });
}
