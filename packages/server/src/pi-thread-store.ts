/**
 * Server-owned Pi thread state (I7 contract completion).
 *
 * `createPiHttpClient` calls `PATCH /threads/:id` (rename), `POST
 * /threads/:id/archive|unarchive`, `DELETE /threads/:id` and `POST
 * /threads/:id/model` — endpoints the P7a projection never served, so each one
 * 404s against the old routes. `usePiRuntime`'s thread-list adapter really does
 * call them (`runtime/usePiRuntime.ts:590-598`: archive/unarchive/delete all go
 * through `client.*Thread`), so this is not hypothetical demand.
 * Those mutations need somewhere to live:
 *
 *  - `PiThreadMetadata.archived` is a **contract field**, so a thread that
 *    reports it must remember it. This table is where it is remembered, keyed by
 *    the *namespaced* thread id, so a Task thread and a room thread can both be
 *    flagged.
 *  - Deleting a thread must never destroy P6 evidence or the shared room record
 *    ("the project owns the workspace; a group chat is a view"). A delete is
 *    therefore a **tombstone plus a cancel**: the thread stops appearing and
 *    stops resolving, while the Tasks, Attempts, events and room messages it was
 *    a projection of stay exactly as they are.
 *  - A rename is a thread-local title — not a rewrite of the Task's prompt, and
 *    not a rename of the imported ChatRoom entity.
 *  - A room thread's event sequence (`seq`) needs a durable watermark. Rooms are
 *    projected, not run, so no Pi supervisor allocates that sequence for us.
 *
 * Why these tables live here rather than in `ExecutionStore`/`RoomStore`: those
 * packages are owned by other in-flight work (I5/I9), and this issue must not
 * edit them. The schema is additive — `CREATE TABLE IF NOT EXISTS` on the same
 * SQLite handle, exactly how `RoomStore` attaches to it — so a fresh or an
 * existing database both open, and nothing about P6's own tables changes.
 */

import type { DatabaseSync } from "node:sqlite";

export interface ThreadFlags {
  archived: boolean;
  deleted: boolean;
  title: string | null;
}

const EMPTY: ThreadFlags = { archived: false, deleted: false, title: null };

interface Row {
  [key: string]: string | number | null | bigint;
}

export class PiThreadStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pi_thread_flags (
        thread_id TEXT PRIMARY KEY,
        archived INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        title TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pi_room_streams (
        room_id TEXT PRIMARY KEY,
        watermark INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  private one(sql: string, ...args: Array<string | number | null>): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }

  /** Flags for one thread; unflagged threads are the default (visible, active). */
  get(threadId: string): ThreadFlags {
    const row = this.one("SELECT * FROM pi_thread_flags WHERE thread_id = ?", threadId);
    if (!row) return EMPTY;
    return {
      archived: Number(row.archived) === 1,
      deleted: Number(row.deleted) === 1,
      title: row.title === null || row.title === undefined ? null : String(row.title),
    };
  }

  /** Thread ids carrying a tombstone, so listings can hide them in one query. */
  deletedThreadIds(): string[] {
    return (this.db.prepare("SELECT thread_id FROM pi_thread_flags WHERE deleted = 1")
      .all() as Row[]).map((row) => String(row.thread_id));
  }

  private write(threadId: string, patch: Partial<ThreadFlags>, now: number): ThreadFlags {
    const next: ThreadFlags = { ...this.get(threadId), ...patch };
    this.db.prepare(`INSERT INTO pi_thread_flags(thread_id,archived,deleted,title,updated_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(thread_id) DO UPDATE SET archived=excluded.archived,
        deleted=excluded.deleted, title=excluded.title, updated_at=excluded.updated_at`)
      .run(threadId, next.archived ? 1 : 0, next.deleted ? 1 : 0, next.title, now);
    return next;
  }

  setArchived(threadId: string, archived: boolean, now = Date.now()): ThreadFlags {
    return this.write(threadId, { archived }, now);
  }

  setTitle(threadId: string, title: string, now = Date.now()): ThreadFlags {
    return this.write(threadId, { title }, now);
  }

  markDeleted(threadId: string, now = Date.now()): ThreadFlags {
    return this.write(threadId, { deleted: true }, now);
  }

  // -------------------------------------------------------------------------
  // Room thread watermarks.
  //
  // `PiClientEventEnvelope.seq` is contractually monotonic per thread, and the
  // client's reducer DROPS anything at or below its own watermark
  // (`runtime/threadState.ts:224-231`). So the number must be durable (a
  // reconnect that restarted at 1 would have its frames silently discarded) and
  // claimed atomically (two SSE subscribers on one room are two writers).
  // `MAX(stored, seen) + 1` additionally lets a client whose local watermark ran
  // ahead of ours still accept the next frame instead of freezing forever.
  // -------------------------------------------------------------------------

  /** The room's current watermark; 0 when it has never emitted an event. */
  watermark(roomId: string): number {
    const row = this.one("SELECT watermark FROM pi_room_streams WHERE room_id = ?", roomId);
    return row ? Number(row.watermark) : 0;
  }

  /** Claim the next watermark for a room, never lower than `seen + 1`. */
  claimWatermark(roomId: string, seen = 0, now = Date.now()): number {
    // Insert path claims `seen + 1`; the conflict path claims
    // `MAX(stored, seen) + 1`. Both mean "strictly above everything handed out
    // and above what the caller has seen", in one statement.
    const row = this.db.prepare(`INSERT INTO pi_room_streams(room_id,watermark,updated_at) VALUES(?,?,?)
      ON CONFLICT(room_id) DO UPDATE SET
        watermark=MAX(pi_room_streams.watermark,?)+1,
        updated_at=excluded.updated_at
      RETURNING watermark`)
      .get(roomId, seen + 1, now, seen) as { watermark: number | bigint } | undefined;
    return Number(row?.watermark ?? 0);
  }

  /**
   * Point a Task thread at a model (`POST /threads/:id/model`).
   *
   * `TaskRecord.model` is the field `durable-worker.ts` forwards to
   * `RunSpec.model`, which `PiAdapter` passes as `--model` — so writing it
   * genuinely changes what the next Attempt runs with; this is not a decorative
   * 204. A direct UPDATE is used because `ExecutionStore` exposes no setter for
   * it and this issue must not edit that package. It touches one nullable config
   * column and nothing the queue's invariants depend on (no status, no fencing
   * token), and it refuses a thread whose Task row does not exist.
   */
  setTaskModel(taskId: string, model: string, now = Date.now()): boolean {
    if (!this.one("SELECT id FROM tasks WHERE id = ?", taskId)) return false;
    const changed = this.db.prepare("UPDATE tasks SET model=?,updated_at=? WHERE id=?")
      .run(model, now, taskId);
    return Number(changed.changes) === 1;
  }
}
