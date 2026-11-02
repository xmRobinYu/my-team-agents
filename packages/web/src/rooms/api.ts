/**
 * `/api/rooms` + room-thread client for the group workbench (I8, on I7's final
 * contract).
 *
 * Reads stay on `/api/rooms*` — the room ENTITY surface (`GET /api/rooms`,
 * `GET /api/rooms/:id/agents`, `GET /api/rooms/:id/messages`): the roster is what
 * column 1 and the member panel need, including for a room that has never
 * produced a Task.
 *
 * Writes go through the room's Pi thread (`POST /api/pi/threads/room:<id>/messages`),
 * which is the I7 surface for `postRoomMessage` (Q29: one room = one thread). The
 * room REST route stays the fallback for a server whose `/api/pi` room branch is
 * not wired: both answer the same contract because the Pi surface delegates to
 * the same function, so choosing between them is a transport choice, not a second
 * semantic model.
 *
 * What a send can answer (verbatim server contract, unchanged here):
 *  - 4xx + `code` (`NO_MENTION` / `UNKNOWN_MENTION` / `AMBIGUOUS_MENTION` /
 *    `ROOM_NOT_FOUND` / `CONTENT_REQUIRED`) + `names` — nothing was written, the
 *    transaction rolled back. The composer validates first, so this is the
 *    "server still wins" path, and the draft is kept.
 *  - 201 + `blocked[]` — a flow guard refused the *dispatch*. Not an error: the
 *    user message and the system message explaining it are already committed
 *    (Q40). The body also carries `snapshot`, which the caller adopts at once.
 */

import type { ChatRoom, RoomAgent, RoomMessage, RoomPostMessageResult } from "./types";
import { roomThreadId } from "./threadId";

/** A non-2xx answer from either room surface, with the server's refusal body. */
export class RoomApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown> | null;

  constructor(message: string, status: number, body: Record<string, unknown> | null) {
    super(message);
    this.name = "RoomApiError";
    this.status = status;
    this.body = body;
  }

  /** The refusal code, when the answer is one the composer can act on. */
  get code(): string | null {
    return typeof this.body?.code === "string" ? this.body.code : null;
  }

  /** The offending `@names` the server reported. */
  get names(): string[] {
    const names = this.body?.names;
    return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
  }

  /** The server's own hint line, shown verbatim when present. */
  get hint(): string | null {
    return typeof this.body?.hint === "string" ? this.body.hint : null;
  }
}

/** `POST /api/pi/threads/room:<id>/messages` → the trigger result + the thread view. */
export interface RoomSendResult extends RoomPostMessageResult {
  /** The room thread right after the commit (I7). Adopted when present. */
  snapshot?: unknown;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    let body: Record<string, unknown> | null = null;
    try {
      body = text === "" ? null : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      body = null;
    }
    const rawMessage = body?.error ?? body?.message;
    const message =
      typeof rawMessage === "string" && rawMessage !== "" ? rawMessage : `${response.status} ${response.statusText}`;
    throw new RoomApiError(message, response.status, body);
  }
  if (text === "") return undefined as T;
  return JSON.parse(text) as T;
}

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/** GET /api/rooms — the room entity list. */
export async function fetchRooms(): Promise<ChatRoom[]> {
  return asArray<ChatRoom>(await requestJson<unknown>("/api/rooms"));
}

/** GET /api/rooms/:id/agents — the members driving AC9.3 and AC9.4. */
export async function fetchRoomAgents(roomId: string): Promise<RoomAgent[]> {
  return asArray<RoomAgent>(await requestJson<unknown>(`/api/rooms/${encodeURIComponent(roomId)}/agents`));
}

/** GET /api/rooms/:id/messages?limit=N — the shared stream, ordered by `seq`. */
export async function fetchRoomMessages(roomId: string, limit = 500): Promise<RoomMessage[]> {
  return asArray<RoomMessage>(
    await requestJson<unknown>(`/api/rooms/${encodeURIComponent(roomId)}/messages?limit=${limit}`),
  );
}

/** `POST /api/rooms/:id/messages` — the trigger on the room REST surface. */
export async function postRoomMessage(roomId: string, content: string): Promise<RoomSendResult> {
  return requestJson<RoomSendResult>(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

/**
 * Send a group turn. Primary: the room's Pi thread route, in the PiClient wire
 * shape (`{ input: { content } }`).
 *
 * The `/api/rooms` fallback is used ONLY when `/api/pi` answers 404 *without* a
 * `code` — that is the shape of "this server does not serve room threads". A 404
 * that carries `code: "ROOM_NOT_FOUND"`, and every other refusal, is a real
 * answer about this message and is never retried somewhere else.
 */
export async function postRoomTurn(roomId: string, content: string): Promise<RoomSendResult> {
  const threadId = roomThreadId(roomId);
  try {
    return await requestJson<RoomSendResult>(`/api/pi/threads/${encodeURIComponent(threadId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: { content } }),
    });
  } catch (error: unknown) {
    if (error instanceof RoomApiError && error.status === 404 && error.code === null) {
      return postRoomMessage(roomId, content);
    }
    throw error;
  }
}
