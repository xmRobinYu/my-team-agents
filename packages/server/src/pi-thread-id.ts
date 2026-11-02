/**
 * Thread id namespace (I7 problem A).
 *
 * `/api/pi` projects TWO different things into Pi threads:
 *  - one single-agent **Task** per thread (P7a, unchanged),
 *  - one **ChatRoom** per thread (I7, Q29: "group == one thread").
 *
 * Both must be addressable through the *same* `PiClient` routes
 * (`GET/POST /threads/:id...`), so the id itself carries the namespace:
 *
 *   task thread id  ->  the raw Task id, exactly as P7a always emitted it
 *   room thread id  ->  `room:<roomId>`
 *
 * Why this cannot collide rather than "happens not to collide":
 *  - A Task id is only ever produced by `ExecutionStore.insertTask`
 *    (`task-<uuid>`); the public `createTask` takes no id, so no caller can
 *    name a Task `room:...`.
 *  - A Room id is only ever produced by `RoomStore.createRoom` (`room-<uuid>`).
 *  - The separator `:` is outside both id alphabets, so the prefix cannot be
 *    forged from either side, and `parseRoomThreadId` is total: every id is
 *    exactly one kind, decided by the string itself — not by a database probe.
 *  - `PiThreadMetadata` has NO `kind` field in the react-pi contract
 *    (`isThreadMetadata` in `client/validation.ts` only accepts the known
 *    optional fields), so a metadata flag would be an out-of-contract field the
 *    UI cannot rely on. The namespace therefore lives in the id, and every
 *    route resolves it with `threadKind()`.
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
