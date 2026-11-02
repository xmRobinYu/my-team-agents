/**
 * ChatRoom threads served through `/api/pi` (I7 — the server-side contract the
 * three-column UI, I8, builds on).
 *
 * A room is addressable through the *same* `PiClient` routes as a Task thread:
 * `pi-routes.ts` decides which projection owns an id (`pi-thread-id.ts`) and
 * delegates here. Everything room-side answers the one question the Task
 * projection already answers for a single Task — "what does this thread look
 * like to react-pi right now, according to the durable store?" — from room state
 * instead of Task state.
 *
 * Boundaries this file must respect:
 *  - **Sending a message is a group trigger, not a Task retry.** It goes through
 *    `postRoomMessage`, so `@mention` resolution, the flow guards and the
 *    all-or-nothing commit stay in exactly one place (I3/I4/I6). The status
 *    mapping is the existing `POST /api/rooms/:id/messages` contract verbatim: a
 *    malformed request 4xx's with nothing written; a guard block answers 2xx with
 *    `blocked`, because the user's message and the guard's system message really
 *    did land.
 *  - **Cancel is a per-chain decision.** `cancel()` stops only the in-flight
 *    chain; `remove()` sweeps every non-terminal chain, which is a different
 *    choice made deliberately (both explain why).
 *  - **The projection does not write the stream.** This class calls
 *    `RoomStore.appendMessage` nowhere; the only message it can cause is a user
 *    turn through `postRoomMessage`. Agent replies and guard notices appear here
 *    because the worker committed them (Q39/Q40), not because this layer
 *    synthesised them.
 *  - Every frame it emits is checked by the real client (`client/validation.ts`)
 *    and **silently dropped** if a field is malformed — so the shapes come from
 *    `pi-room-thread.ts`, and every one of them is asserted in a test.
 */

import type { PiClientEvent, PiThreadMetadata, PiThreadSnapshot } from "@assistant-ui/react-pi";
import {
  postRoomMessage,
  RoomTriggerError,
  type ExecutionStore,
  type RoomStore,
  type TaskRecord,
} from "@my-team-agents/orchestrator";
import {
  roomActiveTask,
  roomThreadStatus,
  roomToMessages,
  roomToSnapshot,
  roomToThreadMetadata,
  type RoomAgentView,
  type RoomMessageView,
  type RoomThreadInput,
  type RoomView,
} from "./pi-room-thread.js";
import { parseRoomThreadId, roomThreadId } from "./pi-thread-id.js";
import type { PiThreadStore } from "./pi-thread-store.js";

/** Upper bound on the room Task scan (local-first, single project). */
const ROOM_TASK_SCAN = 2000;

/** Terminal Task statuses — the same set the single-Task SSE uses. */
const TASK_TERMINAL: ReadonlySet<TaskRecord["status"]> = new Set([
  "succeeded", "failed", "cancelled", "blocked",
]);

export interface RoomThreadContext {
  rooms: RoomStore;
  store: ExecutionStore;
  threads: PiThreadStore;
  notify: () => void;
  /** Attribution/defaults for Tasks created through this projection. */
  defaults: { tenantId: string; projectId: string; workspacePath: string };
  /** Wall clock, injectable so tests can pin timestamps. */
  now?: () => number;
}

export interface ThreadResult {
  status: number;
  body?: unknown;
}

/** One room, fully read: the projection's entire input. */
export interface RoomThreadRecord {
  roomId: string;
  /** Canonical namespaced thread id (`room:<roomId>`). */
  threadId: string;
  room: RoomView;
  agents: RoomAgentView[];
  /** Stream order = `seq` order, never timestamp order. */
  messages: RoomMessageView[];
  tasks: TaskRecord[];
  archived: boolean;
  title: string | null;
  workspacePath: string;
  stateUpdatedAt: number;
}

const bySeq = (a: { seq: number }, b: { seq: number }): number => a.seq - b.seq;

export class RoomThreadSurface {
  private readonly ctx: RoomThreadContext;

  constructor(ctx: RoomThreadContext) {
    this.ctx = ctx;
  }

  private now(): number {
    return this.ctx.now?.() ?? Date.now();
  }

  /** Allocate the next event sequence number for one room thread. */
  private next(roomId: string): number {
    return this.ctx.threads.claimWatermark(roomId);
  }

  /**
   * The room's own Tasks, oldest first.
   *
   * "the room's Tasks" = every Task with `groupId = roomId`, which covers both
   * the mention-triggered ones and the handoff / agent-`@name` children the
   * worker queues (I5): those inherit `groupId` too, so they belong to the round
   * in flight even though no user named them.
   */
  private tasksOf(roomId: string): TaskRecord[] {
    return this.ctx.store.listTasks(ROOM_TASK_SCAN)
      .filter((task) => task.groupId === roomId)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }

  /**
   * Resolve a **namespaced** thread id (`room:<id>`) to its room.
   *
   * The prefix is the only accepted form, and that is deliberate: `pi-routes.ts`
   * dispatches on `threadKind(id)`, so a raw room id would be dispatched as a
   * Task thread and 404 there. Accepting it here would make the same string mean
   * two different things depending on which layer looked at it — exactly the
   * "hope they never collide" namespace this module exists to avoid. Callers that
   * hold a raw room id (the room REST routes) prefix it via `roomThreadId`.
   */
  record(threadId: string, options: { includeDeleted?: boolean } = {}): RoomThreadRecord | null {
    const roomId = parseRoomThreadId(threadId);
    if (roomId === null) return null;
    const room = this.ctx.rooms.getRoom(roomId);
    if (!room) return null;
    const id = roomThreadId(roomId);
    const flags = this.ctx.threads.get(id);
    if (flags.deleted && !options.includeDeleted) return null;
    const tasks = this.tasksOf(roomId);
    // The room's workspace is the project workspace its Tasks run against; an
    // agent's own `agentDir` is per-Task cwd (Q38), not a thread property.
    return {
      roomId,
      threadId: id,
      room,
      agents: this.ctx.rooms.listAgents(roomId),
      messages: [...this.ctx.rooms.listMessages(roomId)].sort(bySeq),
      tasks,
      archived: flags.archived,
      title: flags.title,
      workspacePath: tasks[0]?.workspacePath ?? this.ctx.defaults.workspacePath,
      stateUpdatedAt: this.ctx.rooms.getState(roomId).updatedAt,
    };
  }

  /** Does this thread id resolve to a live room? Lets the endpoints that only
   * need a 404 decision skip building the whole projection. */
  threadExists(threadId: string): boolean {
    return this.record(threadId) !== null;
  }

  private input(record: RoomThreadRecord): RoomThreadInput {
    return {
      threadId: record.threadId,
      room: record.room,
      agents: record.agents,
      messages: record.messages,
      tasks: record.tasks,
      archived: record.archived,
      title: record.title,
      workspacePath: record.workspacePath,
      stateUpdatedAt: record.stateUpdatedAt,
      // READ only: a plain GET must not advance the sequence it reports, or every
      // poll would push the client's watermark forward without emitting frames.
      seq: this.ctx.threads.watermark(record.roomId),
    };
  }

  metadata(record: RoomThreadRecord): PiThreadMetadata {
    return roomToThreadMetadata(this.input(record));
  }

  snapshot(record: RoomThreadRecord): PiThreadSnapshot {
    return roomToSnapshot(this.input(record));
  }

  /** Snapshot by thread id, or null when the thread does not resolve. */
  snapshotFor(threadId: string): PiThreadSnapshot | null {
    const record = this.record(threadId);
    return record ? this.snapshot(record) : null;
  }

  /** Every room as thread metadata, in room-creation order. */
  list(includeArchived: boolean): PiThreadMetadata[] {
    return this.ctx.rooms.listRooms()
      .map((room) => this.record(roomThreadId(room.id)))
      .filter((record): record is RoomThreadRecord => record !== null)
      .filter((record) => includeArchived || !record.archived)
      .map((record) => this.metadata(record));
  }

  // -------------------------------------------------------------------------
  // mutations
  // -------------------------------------------------------------------------

  /**
   * `POST /api/pi/threads` with `kind: "room"`.
   *
   * react-pi always creates a thread (the composer's "new thread") and sends the
   * first message separately, so a room-shaped create is exactly that: an empty
   * thread bound to a brand-new ChatRoom, parked until someone speaks. Rooms that
   * come from a team template package are created by `POST /api/rooms/import`;
   * this path only ever mints a new room, given a thread id is not a way to pick
   * an existing one.
   */
  create(input: {
    title?: string;
    initialMessage?: { content?: string };
    projectId?: string;
  }): ThreadResult {
    const content = input.initialMessage?.content?.trim() ?? "";
    if (content !== "" && !/@\S/.test(content)) {
      // Refuse BEFORE creating the room. `postRoomMessage` would reject this
      // message itself (a 4xx `NO_MENTION`, and it stores nothing — it is the
      // trigger, not an idle-chat sink), so letting it through would not leave a
      // message unanswered: it would leave a freshly created room with no message
      // and no agents-in-waiting, i.e. an orphan from a failed request. Checked
      // first so a refused create writes nothing at all.
      return {
        status: 400,
        body: {
          error: "创建群时首条消息必须 @ 至少一个成员，否则不会触发任何 agent",
          code: "NO_MENTION",
        },
      };
    }
    const name = input.title?.trim() || "新群聊";
    const room = this.ctx.rooms.createRoom(
      { projectId: input.projectId ?? this.ctx.defaults.projectId, name },
      this.now(),
    );
    if (input.title?.trim()) {
      this.ctx.threads.setTitle(roomThreadId(room.id), input.title.trim(), this.now());
    }
    if (content !== "") {
      const sent = this.appendMessage(roomThreadId(room.id), content);
      if (sent.status >= 400) return sent;
    }
    const record = this.record(roomThreadId(room.id));
    if (!record) return { status: 500, body: { error: "room created but not readable" } };
    return { status: 201, body: this.snapshot(record) };
  }

  /**
   * `POST /api/pi/threads/:roomId/messages` — send into the shared stream.
   *
   * `postRoomMessage` owns validation order and the transaction; this maps its
   * two outcome classes onto statuses, identically to
   * `POST /api/rooms/:id/messages`:
   *  - `RoomTriggerError` (no room / empty / no `@` / unknown `@` / duplicate
   *    name) → 4xx carrying `code` + `names`, with nothing written;
   *  - a guard block (terminated / loop / round cap) → 2xx carrying `blocked`,
   *    because the user message AND the system message explaining the refusal are
   *    already committed. A 4xx there would claim nothing happened when the
   *    stream demonstrably has two new messages in it.
   */
  appendMessage(threadId: string, content: string, workspacePath?: string): ThreadResult {
    const record = this.record(threadId);
    if (!record) return { status: 404, body: { error: "thread not found" } };
    try {
      const result = postRoomMessage(this.ctx.rooms, this.ctx.store, {
        roomId: record.roomId,
        content,
        tenantId: this.ctx.defaults.tenantId,
        workspacePath: workspacePath?.trim() ? workspacePath : this.ctx.defaults.workspacePath,
      });
      this.ctx.notify();
      return {
        status: 201,
        body: {
          message: result.message,
          tasks: result.tasks,
          blocked: result.blocked,
          // The thread's own view, so a client can adopt the committed message and
          // the new `running` status in one round trip.
          snapshot: this.snapshotFor(record.threadId),
        },
      };
    } catch (err) {
      if (err instanceof RoomTriggerError) {
        return {
          status: err.code === "ROOM_NOT_FOUND" ? 404 : 400,
          body: {
            error: err.detail,
            code: err.code,
            names: err.names,
            hint: "提及未生效：消息与任务都未写入（事务已回滚）",
          },
        };
      }
      throw err;
    }
  }

  /**
   * `POST /api/pi/threads/:roomId/cancel`.
   *
   * A room holds MANY chains: one per user trigger, extended by each agent→agent
   * handoff (children inherit `chainId`), while `groupId = roomId` is what
   * serialises them. Cancel therefore means: **stop the chain whose Task is in
   * flight now** — the turn the user is watching. It deliberately does not
   * cancel every chain the room has.
   *
   * Why not room-wide, stated against what `requestCancelChain` actually does
   * (`execution-store.ts:637-647`: it writes `cancel_requested=1` on the chain and
   * sets every Task in it that is not already `succeeded`/`failed`/`cancelled` to
   * `cancelling`/`cancelled`) — measured, not assumed:
   *  1. **It would kill work that never started.** A queued Task from another turn
   *     is not terminal, so a room-wide cancel flips it to `cancelled`: the user
   *     asked to stop THIS round and loses the rounds still waiting their turn
   *     (same-room serialisation means those Tasks are normal, expected backlog).
   *  2. **That loss is unsalvageable.** `cancel_requested` is never cleared, and
   *     `retryTask` refuses any Task whose chain has it (`execution-store.ts:656`),
   *     so a wrongly cancelled queued Task cannot be re-queued by hand either.
   *  Already-finished Tasks are NOT affected (they are in the `WHERE` exclusion),
   *  which is exactly why the harm above is about queued/running work, not history.
   *
   * With nothing in flight there is nothing to cancel: a room is a projection,
   * not a run. This answers 200 with `cancelled: false` rather than a 4xx,
   * because `PiClient.cancelRun` only promises not to throw, and failing an idle
   * room would make the UI's stop button look broken.
   */
  cancel(threadId: string): ThreadResult {
    const record = this.record(threadId);
    if (!record) return { status: 404, body: { error: "thread not found" } };
    const active = roomThreadStatus(record.tasks) === "running" ? roomActiveTask(record.tasks) : undefined;
    if (!active) return { status: 200, body: { cancelled: false, chains: [], affected: 0 } };
    const affected = this.ctx.store.requestCancelChain(active.chainId, this.now());
    this.ctx.notify();
    return {
      status: 200,
      body: {
        cancelled: true,
        chainId: active.chainId,
        chains: [active.chainId],
        taskId: active.id,
        affected,
        snapshot: this.snapshotFor(record.threadId),
      },
    };
  }

  /** `PATCH /api/pi/threads/:roomId` — a thread-local title, never a room rename. */
  rename(threadId: string, title: string): ThreadResult {
    if (!title.trim()) return { status: 400, body: { error: "title is required" } };
    const record = this.record(threadId);
    if (!record) return { status: 404, body: { error: "thread not found" } };
    this.ctx.threads.setTitle(record.threadId, title.trim(), this.now());
    return { status: 204 };
  }

  setArchived(threadId: string, archived: boolean): ThreadResult {
    const record = this.record(threadId);
    if (!record) return { status: 404, body: { error: "thread not found" } };
    this.ctx.threads.setArchived(record.threadId, archived, this.now());
    return { status: 204 };
  }

  /**
   * `DELETE /api/pi/threads/:roomId` — tombstone + cancel, and no row deleted.
   *
   * The stream is the record of what the team discussed and what it cost
   * (attribution keys, usage, P6 evidence), and "a group chat is a view; the
   * project owns the workspace" (AGENTS.md). So deleting the *thread* removes the
   * projection only: it stops appearing in `listThreads` and 404s on read, while
   * every Task, Attempt, event and room message stays.
   *
   * The difference from `cancel()` is deliberate and is the expensive half of it:
   * delete cancels **every** non-terminal chain of the room, because a thread the
   * user removed must not keep spending tokens behind it. Per
   * `execution-store.ts:637-647` that also turns the room's still-queued Tasks into
   * `cancelled` with `cancel_requested=1`, and `retryTask` refuses such Tasks
   * forever (`execution-store.ts:656`) — so deletion abandons the backlog on
   * purpose, which is why only the stop button may cancel a single chain and only
   * an explicit DELETE cancels all of them. Finished Tasks are untouched either
   * way (the store's `WHERE` excludes `succeeded`/`failed`/`cancelled`).
   *
   * Idempotent: an already-deleted or never-existing thread still answers 204,
   * which is exactly the contract's "resolves once the thread no longer exists,
   * also when it was already gone".
   */
  remove(threadId: string): ThreadResult {
    const record = this.record(threadId, { includeDeleted: true });
    if (!record) return { status: 204 };
    for (const task of record.tasks) {
      if (!TASK_TERMINAL.has(task.status)) this.ctx.store.requestCancelChain(task.chainId, this.now());
    }
    if (!this.ctx.threads.get(record.threadId).deleted) {
      this.ctx.threads.markDeleted(record.threadId, this.now());
    }
    this.ctx.notify();
    return { status: 204 };
  }

  // -------------------------------------------------------------------------
  // SSE frame builders (the stream loop lives in pi-routes.ts)
  // -------------------------------------------------------------------------

  /**
   * Project newly committed stream messages into `message_start`/`message_end`
   * frames.
   *
   * A room message IS final text — the worker writes an agent's reply in the same
   * transaction that settles its Task (Q39) — so there is no partial state to
   * stream and no draft to invent. Each message becomes a start/end pair, the
   * shape the reducer appends exactly once. `PiCustomMessage` is a legal
   * `message_*` payload: the contract types those frames as `PiAgentMessage`, and
   * the SSE validator accepts `custom` given `customType` + user content +
   * `display` + `timestamp` (`client/eventSource.ts:133-135`,
   * `client/validation.ts:125-131`) — which is precisely what
   * `roomMessageToPiMessage` emits.
   */
  messageFrames(record: RoomThreadRecord, seen: Set<string>): PiClientEvent[] {
    const frames: PiClientEvent[] = [];
    for (const message of [...record.messages].sort(bySeq)) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      const [projected] = roomToMessages([message], record.agents);
      if (!projected) continue;
      // One watermark PER FRAME, not per message: the reducer ignores anything at
      // or below its own last seq, so a `message_end` sharing a seq with its
      // `message_start` would be silently dropped and the message would stay
      // "streaming" in the client forever.
      frames.push({ threadId: record.threadId, seq: this.next(record.roomId), type: "message_start", message: projected });
      frames.push({ threadId: record.threadId, seq: this.next(record.roomId), type: "message_end", message: projected });
    }
    return frames;
  }

  /**
   * The run-state transition frames. A room thread has no attempt-level
   * streaming, so the only transitions worth reporting are "a round is in
   * flight" and "the round finished".
   *
   * The second MUST emit `agent_end` + `agent_settled`: react-pi only leaves
   * `runStatus: "running"` on `agent_end` or on a snapshot whose metadata is not
   * running (`runtime/threadState.ts:257-268`, `:118-135`). A client that saw
   * `agent_start` and never `agent_end` keeps its composer disabled forever — the
   * same hazard the Task projection already solved for a terminal Task, solved
   * here the same way, once per transition instead of per event row.
   */
  transitionFrames(record: RoomThreadRecord, wasRunning: boolean): {
    frames: PiClientEvent[];
    running: boolean;
  } {
    const running = roomThreadStatus(record.tasks) === "running";
    if (running === wasRunning) return { frames: [], running };
    const base = { threadId: record.threadId };
    if (running) {
      return { frames: [{ ...base, seq: this.next(record.roomId), type: "agent_start" }], running: true };
    }
    return {
      frames: [
        { ...base, seq: this.next(record.roomId), type: "agent_end", willRetry: false },
        { ...base, seq: this.next(record.roomId), type: "agent_settled" },
      ],
      running: false,
    };
  }

  /** Snapshot frame at a freshly claimed watermark (the stream's own seq). */
  snapshotFrame(record: RoomThreadRecord): PiClientEvent {
    const seq = this.next(record.roomId);
    return {
      threadId: record.threadId,
      seq,
      type: "snapshot",
      snapshot: roomToSnapshot({ ...this.input(record), seq }),
    };
  }
}
