/**
 * Browser-side mirrors of the ChatRoom entities (`packages/domain/src/chat-room.ts`).
 *
 * Deliberately re-declared instead of imported: the web bundle must not pull
 * Node-only packages (`node:sqlite` sits behind the orchestrator's barrel), and
 * `api/types.ts` already established the same rule for Task rows.
 * Seam: a shared DTO package would replace both files at once.
 *
 * Field names are copied verbatim from `RoomStore`'s row mappers and from the
 * I7 room projection (`packages/server/src/pi-room-thread.ts`): a rename on the
 * server is a rename here, and nothing else.
 */

export type AuthorKind = "user" | "agent" | "system";

export interface ChatRoom {
  id: string;
  projectId: string;
  name: string;
  description: string;
  rules: string;
  coordinatorAgentId: string | null;
  maxRounds: number;
  createdAt: number;
}

export interface RoomAgent {
  id: string;
  roomId: string;
  name: string;
  role: string;
  prompt: string;
  agentDir: string;
  model: string | null;
  thinkingMode: string | null;
  emoji: string | null;
  color: string | null;
  isCoordinator: boolean;
  createdAt: number;
}

export interface RoomMessage {
  id: string;
  roomId: string;
  /** Monotonic per room — the display order (never timestamps). */
  seq: number;
  authorKind: AuthorKind;
  authorAgentId: string | null;
  content: string;
  taskId: string | null;
  createdAt: number;
}

/** `POST /api/rooms/:id/messages` → 201 body. */
export interface RoomPostMessageResult {
  message: RoomMessage;
  /** Created Tasks in mention order; `memberId` is the RoomAgent id. */
  tasks: Array<{ id: string; memberId: string }>;
  /**
   * Targets a flow guard refused. NOT an error: the user message and the
   * explanatory system message are already committed (Q40), so they arrive
   * through the normal stream.
   */
  blocked: Array<{ memberId: string; code: string; reason: string }>;
}
