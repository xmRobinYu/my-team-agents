/**
 * Thread-id namespace adapter (I8 ↔ I7 seam).
 *
 * I7 (`packages/server/src/pi-thread-id.ts`) decided that both projections share
 * `/api/pi/threads/:id`, with the namespace carried by the id itself:
 *
 *   single-agent Task thread  ->  the raw Task id (`task-<uuid>`)
 *   ChatRoom thread           ->  `room:<roomId>`
 *
 * `PiThreadMetadata` has no `kind` field in the react-pi contract, so the prefix
 * is the only signal that survives to the browser, and the UI must read it the
 * same way. This file is the browser twin of that module: the duplication is the
 * isolation layer the I8 brief asks for — the conversation list, the feed probe
 * and the evidence panel all ask *this* module what a thread id means, so wiring
 * I7 up later is a change here (or nothing at all), not a hunt through the UI.
 *
 * If I7 ever changes the prefix, `ROOM_THREAD_PREFIX` is the single line to fix,
 * and the fallback behaviour below keeps the workbench usable in the meantime:
 * an unknown id is treated as a single-agent thread, which is what P7a always did.
 */

export const ROOM_THREAD_PREFIX = "room:";

export type PiThreadKind = "task" | "room";

/** The thread id a ChatRoom is projected under. */
export const roomThreadId = (roomId: string): string => `${ROOM_THREAD_PREFIX}${roomId}`;

/** The room id behind a thread id, or null when the id is not in the room namespace. */
export const parseRoomThreadId = (threadId: string): string | null =>
  threadId.startsWith(ROOM_THREAD_PREFIX) && threadId.length > ROOM_THREAD_PREFIX.length
    ? threadId.slice(ROOM_THREAD_PREFIX.length)
    : null;

/** Which projection owns this thread id. */
export const threadKind = (threadId: string): PiThreadKind =>
    parseRoomThreadId(threadId) === null ? "task" : "room";
