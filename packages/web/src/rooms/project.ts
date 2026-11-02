/**
 * Room feed projection (I8 / AC9.2).
 *
 * Two sources, one model. The workbench shows the same authored turns whether the
 * stream arrives through:
 *
 *  A. the PiClient thread I7 projects for a ChatRoom (`/api/pi/threads/room:<id>`)
 *     — raw `PiAgentMessage[]` with `role: "custom"` rows, read cold by the
 *     projection probe or handed straight back by a room send's `snapshot`
 *     (`projectPiRoomMessages` / `turnsFromPiSnapshot`);
 *  B. the authoritative room rows (`GET /api/rooms/:id/messages`) — plain
 *     `{ authorKind, authorAgentId, content, seq }`, the fallback for a server
 *     that does not serve room threads (`turnsFromRoomMessages`).
 *
 * A is what ships (I7 landed); B is the degradation path. `loadRoomFeed` in
 * `rooms/hooks.ts` is the seam, so the components never learn which one they are
 * drawing. Both are *display* projections: the server stays the owner of the
 * transcript, and the order is always `seq` — never timestamps, never insertion
 * order.
 *
 * `projectPiRoomMessages` re-derives react-pi's own custom-projection rules
 * (`messageProjection.ts:383-399`) on purpose: `display: false` is hidden, the
 * text is kept as parts. It is not a copy of the transcript — it is the same
 * mapping applied where the runtime's `role` rewrite has already destroyed the
 * author field, which is why identity is read only through `PI_CUSTOM_MESSAGE_PART`
 * / `parseRoomAuthor` from `./author` (one source of truth for that constant).
 */

import {
  authorFromRoomMessage,
  parseRoomAuthor,
  PI_CUSTOM_MESSAGE_PART,
  type MessagePartLike,
  type RoomAuthor,
} from "./author";
import type { RoomAgent, RoomMessage } from "./types";

/** Minimal structural mirror of `PiAgentMessage` (no react-pi import at runtime). */
export interface PiMessageLike {
  role: string;
  content?: unknown;
  timestamp?: number;
  customType?: string;
  display?: boolean;
  details?: unknown;
}

/** A turn in the shared stream, with its author resolved. */
export interface RoomTurn {
  /** Stable key: the room message id when known, else a positional fallback. */
  key: string;
  seq: number | null;
  createdAt: number | null;
  author: RoomAuthor;
  parts: readonly MessagePartLike[];
  /** The task that produced this turn, when it came from an execution. */
  taskId: string | null;
  /** Provenance, shown by the chat header: what this view was drawn from. */
  source: "pi-thread" | "rooms-api";
}

const textParts = (content: unknown): MessagePartLike[] => {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const parts: MessagePartLike[] = [];
  for (const item of content as readonly Record<string, unknown>[]) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push({ type: "text", text: item.text });
    } else if (item.type === "image") {
      // Images pass through as parts; the text projection must not claim an
      // image is a sentence.
      parts.push({ type: "image" });
    }
  }
  return parts;
};

const unknownAuthor = (name: string): RoomAuthor => ({
  authorKind: "unknown",
  degraded: true,
  messageId: null,
  seq: null,
  agentId: null,
  name,
  role: "",
  emoji: null,
  color: null,
  isCoordinator: false,
  taskId: null,
  customType: null,
});

/**
 * Details that were unreadable on their own, retried against the room's member
 * list: an `agentId` alone identifies a persona, and inventing nobody is worse
 * than recovering somebody.
 */
function recoverAuthor(author: RoomAuthor, details: unknown, agents: readonly RoomAgent[]): RoomAuthor {
  if (author.authorKind !== "unknown" && author.authorKind !== "agent") return author;
  if (author.name !== "未知成员" && !author.degraded) return author;
  const record = details && typeof details === "object" ? (details as Record<string, unknown>) : {};
  const agentId = typeof record.agentId === "string" ? record.agentId : null;
  const match = agentId ? agents.find((agent) => agent.id === agentId) : undefined;
  if (!match) return author;
  return {
    ...author,
    authorKind: "agent",
    degraded: false,
    agentId: match.id,
    name: match.name,
    role: match.role,
    emoji: match.emoji,
    color: match.color,
    isCoordinator: match.isCoordinator,
  };
}

const bySeq = (a: RoomTurn, b: RoomTurn): number => {
  const left = a.seq ?? Number.MAX_SAFE_INTEGER;
  const right = b.seq ?? Number.MAX_SAFE_INTEGER;
  return left !== right ? left - right : a.key.localeCompare(b.key);
};

/**
 * Raw Pi transcript → authored turns (path A). `display: false` participates in
 * LLM context and is hidden from the UI — the same rule react-pi applies, so the
 * two paths cannot disagree.
 */
export function projectPiRoomMessages(
  messages: readonly PiMessageLike[],
  agents: readonly RoomAgent[] = [],
): RoomTurn[] {
  const turns: RoomTurn[] = [];
  messages.forEach((message, index) => {
    const createdAt = typeof message.timestamp === "number" ? message.timestamp : null;
    if (message.role === "custom") {
      if (message.display === false) return;
      const author = recoverAuthor(
        parseRoomAuthor({
          type: "data",
          name: PI_CUSTOM_MESSAGE_PART,
          data: { customType: message.customType ?? null, details: message.details ?? null },
        }),
        message.details,
        agents,
      );
      turns.push({
        key: author.messageId ?? `pi-${index}`,
        seq: author.seq,
        createdAt,
        author,
        parts: textParts(message.content),
        taskId: author.taskId,
        source: "pi-thread",
      });
      return;
    }
    if (message.role === "user") {
      // The composer's own words stay attributed to the user (I7 keeps this row
      // native so react-pi's optimistic echo can reconcile against it).
      turns.push({
        key: `pi-user-${index}`,
        seq: index,
        createdAt,
        author: authorFromRoomMessage(
          {
            id: `pi-user-${index}`,
            roomId: "",
            seq: index,
            authorKind: "user",
            authorAgentId: null,
            content: "",
            taskId: null,
            createdAt: message.timestamp ?? 0,
          },
          agents,
        ),
        parts: textParts(message.content),
        taskId: null,
        source: "pi-thread",
      });
      return;
    }
    // A native assistant/toolResult row: in a room thread it carries no author,
    // so it is drawn as unattributed — never as some specific member speaking.
    turns.push({
      key: `pi-${message.role}-${index}`,
      seq: index,
      createdAt,
      author: unknownAuthor(message.role === "assistant" ? "执行体（未署名）" : `未知消息（${message.role}）`),
      parts: textParts(message.content),
      taskId: null,
      source: "pi-thread",
    });
  });
  return turns.sort(bySeq);
}

/** Rows from `GET /api/rooms/:id/messages` → authored turns (path B, authoritative). */
export function turnsFromRoomMessages(
  messages: readonly RoomMessage[],
  agents: readonly RoomAgent[],
): RoomTurn[] {
  return messages
    .map((message) => {
      const author = authorFromRoomMessage(message, agents);
      return {
        key: message.id,
        seq: message.seq,
        createdAt: message.createdAt,
        author,
        parts: [{ type: "text", text: message.content }] as MessagePartLike[],
        taskId: message.taskId,
        source: "rooms-api" as const,
      };
    })
    .sort(bySeq);
}

/**
 * Turns straight from a Pi snapshot body — the `snapshot` a room send returns
 * (I7), so the UI adopts the committed message and the new `running` status in
 * one round trip instead of waiting for the next stream frame. Returns null for
 * anything that is not a snapshot with a message array: shape before trust, the
 * same rule the cold-read probe uses.
 */
export function turnsFromPiSnapshot(
  snapshot: unknown,
  agents: readonly RoomAgent[] = [],
): RoomTurn[] | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const messages = (snapshot as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;
  return projectPiRoomMessages(messages as PiMessageLike[], agents);
}
