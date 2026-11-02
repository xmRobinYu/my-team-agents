/**
 * Read-only probe for the I7 room thread projection.
 *
 * The brief says the thread-id namespace must come from the server, not from a
 * guess here, and the isolation layer must be explicit. That is what this file is:
 * one function, one URL, one contract check.
 *
 * It deliberately does NOT go through `createPiHttpClient`:
 *   - that client's `getThread` is bound into the runtime's controller registry,
 *     so probing it would attach a live thread the user has not opened and start
 *     an SSE subscription per room;
 *   - a probe must be allowed to miss. `PiClient.getThread` throws on any non-2xx,
 *     and until I7 wires `/api/pi/threads/room:<id>` every room read answers 404 —
 *     a *missing interface*, which the caller degrades from, not an error.
 *
 * So this is the same wire (`GET /api/pi/threads/:id`, `PiThreadSnapshot` JSON)
 * read with plain `fetch`, and it validates the shape itself instead of trusting
 * that a 200 means a room thread.
 */

import type { PiMessageLike } from "./project";
import { roomThreadId } from "./threadId";

export interface PiRoomSnapshot {
  threadId: string;
  title: string | null;
  status: string;
  messages: PiMessageLike[];
}

interface SnapshotShape {
  metadata?: unknown;
  messages?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Parse and validate one snapshot body. Returns null for anything that is not a
 * `PiThreadSnapshot` with a message array — including a 404 body and an old
 * server that answers `{ error: ... }` with a 200.
 */
export function parsePiRoomSnapshot(threadId: string, value: unknown): PiRoomSnapshot | null {
  if (!isRecord(value)) return null;
  const body = value as SnapshotShape;
  if (!isRecord(body.metadata) || !Array.isArray(body.messages)) return null;
  const metadata = body.metadata as Record<string, unknown>;
  if (typeof metadata.id !== "string" || typeof metadata.status !== "string") return null;
  // A snapshot served for a different thread is not evidence about this room.
  if (metadata.id !== threadId) return null;
  return {
    threadId,
    title: typeof metadata.title === "string" ? metadata.title : null,
    status: metadata.status,
    // `role` is the one field the projection reads; rows without it are not
    // transcript messages and are dropped rather than guessed at.
    messages: (body.messages as readonly unknown[]).filter(
      (item): item is PiMessageLike => isRecord(item) && typeof item.role === "string",
    ),
  };
}

/** Fetch the room's Pi thread snapshot, or null when the projection is not served. */
export async function fetchPiRoomSnapshot(roomId: string): Promise<PiRoomSnapshot | null> {
  const threadId = roomThreadId(roomId);
  try {
    const response = await fetch(`/api/pi/threads/${encodeURIComponent(threadId)}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (text === "") return null;
    return parsePiRoomSnapshot(threadId, JSON.parse(text) as unknown);
  } catch {
    // A transport failure is indistinguishable from "not served here" at this
    // seam, and both take the same path: read the authoritative room rows.
    return null;
  }
}
