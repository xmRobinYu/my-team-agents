/**
 * `@mention` trigger for a ChatRoom (I3): one user message -> one Task per target.
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
 * I3 is trigger-only: a message with no mention is refused rather than stored as
 * idle chat, because a stored message nobody answers is the same silent failure
 * the 4xx exists to avoid. Shared history injection is I4, flow guards are I6.
 */

import type { RoomAgent, RoomMessage } from "@my-team-agents/domain";
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
 * Role prompt first, then the user message. Full room history is deliberately NOT
 * included — that is I4's decision (format + truncation), and inventing a partial
 * version now would be the thing I4 has to undo.
 */
export function buildMentionPrompt(agent: RoomAgent, content: string): string {
  const header = agent.role.trim()
    ? `# 角色：${agent.name}（${agent.role.trim()}）`
    : `# 角色：${agent.name}`;
  return `${agent.prompt.trim()}\n\n${header}\n\n# 用户消息\n${content}`;
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
    const created = targets.map((agent) => executions.createTask({
      tenantId: input.tenantId,
      projectId: input.projectId ?? room.projectId,
      memberId: agent.id,
      workspacePath: input.workspacePath,
      // Reaches Pi as the child cwd: persona resources are discovered from cwd.
      agentDir: agent.agentDir,
      prompt: buildMentionPrompt(agent, content),
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
