/**
 * `/api/pi` route layer — serves the `PiClient` contract over the durable store
 * so `@assistant-ui/react-pi` can drive the UI.
 *
 * Two projections share these routes (I7):
 *  - **Task == Thread** (P7a): one single-agent Task per thread, id = Task id.
 *  - **ChatRoom == Thread** (Q29): one room per thread, id = `room:<roomId>`.
 * Which one answers is decided by the id's prefix (`pi-thread-id.ts`) — the
 * namespace is in the id itself, not in an out-of-contract metadata key. Every
 * Task-side branch below is the original P7a behaviour, byte for byte; the room
 * branches are additive. See `pi-room-routes.ts` / `pi-room-thread.ts`.
 *
 * Wire contract expected by `createPiHttpClient` (the whole list, verified
 * against `@assistant-ui/react-pi/src/client/httpClient.ts:12-27` — every route
 * it calls is served here now, so the UI stops 404ing on rename/delete/model):
 *   GET    /threads                 → PiThreadMetadata[]
 *   POST   /threads                 → PiThreadSnapshot
 *   GET    /threads/:id             → PiThreadSnapshot
 *   PATCH  /threads/:id             → 204   (body { title })
 *   DELETE /threads/:id             → 204   (also when already gone)
 *   POST   /threads/:id/messages    → Task: 204 (first message only) | 4xx
 *                                   Room: 201 (+blocked) | 4xx  (see below)
 *   POST   /threads/:id/cancel      → 204
 *   POST   /threads/:id/queue/clear → { steering, followUp }
 *   GET    /models                  → PiModelInfo[]
 *   POST   /threads/:id/model       → 204   (body { provider, modelId })
 *   POST   /threads/:id/thinking    → 204   (body { level })
 *   POST   /threads/:id/archive     → 204
 *   POST   /threads/:id/unarchive   → 204
 *   POST   /threads/:id/host-ui     → 204   (body { response })
 *   GET    /threads/:id/events      → SSE of PiClientEvent
 *
 * These routes are a *projection* over the same ExecutionStore/RoomStore the
 * /api/tasks and /api/rooms routes use, so the durable queue, leases, retries and
 * recovery stay authoritative (P6). The UI never drives Pi directly.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerResponse } from "node:http";
import type { DurableWorker, ExecutionStore, RoomStore, TaskRecord } from "@my-team-agents/orchestrator";
import { taskToSnapshot, taskToThreadMetadata, toPiClientEvent } from "./pi-thread.js";
import { parseRoomThreadId, threadKind } from "./pi-thread-id.js";
import { PiThreadStore } from "./pi-thread-store.js";
import { RoomThreadSurface } from "./pi-room-routes.js";
import { mergeModels, piAgentDir, readModelCatalog } from "./pi-models.js";
import { roomThreadStatus } from "./pi-room-thread.js";
import { join } from "node:path";

interface PiRouteOptions {
  store: ExecutionStore;
  worker: DurableWorker;
  notify: () => void;
  /** Room store over the SAME database handle as `store` (the server's wiring). */
  rooms: RoomStore;
  /** Thread-local flags (archived / deleted / title) and room seq watermarks. */
  threads?: PiThreadStore;
  /** Test override for the model catalog path; defaults to Pi's own. */
  modelsPath?: string;
  /** Project workspace the room/Task threads report. Defaults to `<cwd>`. */
  defaultWorkspacePath?: string;
}

interface PiCreateBody {
  workspacePath?: string;
  title?: string;
  initialMessage?: { content?: string };
  /** I7: "room" creates a ChatRoom thread; absent keeps the P7a Task path. */
  kind?: string;
  projectId?: string;
}

/** Task attribution for threads created through this projection: the same
 * loopback, single-tenant defaults P7a used (P7b replaces them with auth). */
const DEFAULTS = {
  tenantId: "default",
  projectId: "my-team-agents",
  memberId: "pi-agent",
  workspacePath: process.cwd(),
};

const catalogPath = (options: { modelsPath?: string; env?: NodeJS.ProcessEnv }): string =>
  options.modelsPath ?? join(piAgentDir(options.env ?? process.env), "models.json");

export function registerPiRoutes(app: FastifyInstance, options: PiRouteOptions): void {
  const { store, worker, notify } = options;
  const threads = options.threads ?? new PiThreadStore(store.db);
  const rooms = new RoomThreadSurface({
    rooms: options.rooms,
    store,
    threads,
    notify,
    defaults: {
      tenantId: DEFAULTS.tenantId,
      projectId: DEFAULTS.projectId,
      // The SAME configured workspace the room routes hand to triggered Tasks: a
      // thread's `workspacePath` must be the workspace its Tasks actually use.
      workspacePath: options.defaultWorkspacePath ?? DEFAULTS.workspacePath,
    },
  });
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "thread not found" });

  /**
   * Every live `/api/pi` SSE response.
   *
   * Fastify's `close()` waits for in-flight requests, and a hijacked event stream
   * is by definition in flight forever, so without this the server cannot shut
   * down while a UI tab is open (`just check` would hang on a test that closes the
   * app with a subscriber attached, and SIGTERM would hang in production). The
   * `onClose` hook below ends them instead.
   */
  const streams = new Set<ServerResponse>();
  app.addHook("onClose", async () => {
    for (const stream of streams) stream.end();
    streams.clear();
  });

  /** A Task thread's metadata, with its persisted flags applied.
   *
   * `messageCount` stays what P7a sent (0 on the list route: counting messages
   * per thread would rebuild every transcript on every poll). Only the new
   * persisted flags — `archived` and a thread-local `title` — can differ. */
  const threadFlags = (threadId: string) => {
    const flags = threads.get(threadId);
    return { archived: flags.archived, title: flags.title };
  };
  const taskSnapshot = (task: TaskRecord) =>
    taskToSnapshot(task, store.getEvents(task.id), threadFlags(task.id));
  const taskMetadata = (task: TaskRecord) =>
    taskToThreadMetadata(task, 0, threadFlags(task.id));

  const deletedIds = () => new Set(threads.deletedThreadIds());

  /** Track a hijacked stream for shutdown, and stop polling when it dies. */
  const openStream = (stream: ServerResponse, request: FastifyRequest) => {
    streams.add(stream);
    request.raw.on("close", () => {
      streams.delete(stream);
      if (!stream.destroyed && !stream.writableEnded) stream.end();
    });
    stream.on("close", () => streams.delete(stream));
  };

  app.get<{ Querystring: { workspacePath?: string; includeArchived?: string } }>(
    "/api/pi/threads",
    async (request) => {
      const includeArchived = request.query.includeArchived === "true";
      const gone = deletedIds();
      const wanted = request.query.workspacePath;
      // Rooms first: the shared stream is the primary column of the group UI,
      // and `listRooms()` is creation-ordered while `listTasks()` is recency-
      // ordered, so concatenating keeps each kind's own meaningful order rather
      // than inventing a cross-kind one.
      const roomThreads = rooms.list(includeArchived);
      const taskThreads = store.listTasks()
        .filter((task) => !gone.has(task.id))
        .map(taskMetadata);
      const all = [...roomThreads, ...(includeArchived ? taskThreads : taskThreads.filter((m) => !m.archived))];
      return wanted === undefined ? all : all.filter((meta) => meta.workspacePath === wanted);
    },
  );

  app.post<{ Body: PiCreateBody }>(
    "/api/pi/threads",
    async (request, reply) => {
      const body = request.body ?? {};
      // I7: `kind: "room"` creates a ChatRoom thread. Without it — the only thing
      // react-pi ever sends today — this is exactly the P7a placeholder-Task path.
      if (body.kind === "room") {
        const created = rooms.create({
          title: body.title,
          initialMessage: body.initialMessage,
          projectId: body.projectId,
        });
        if (created.status >= 400) return reply.code(created.status).send(created.body);
        return reply.code(201).send(created.body);
      }
      // react-pi creates an EMPTY thread first (initialize), then sends the
      // first message via POST /messages. A placeholder prompt keeps the Task
      // row valid until the first real message replaces it.
      const prompt = body.initialMessage?.content?.trim() || body.title?.trim() || "新会话";
      const task = store.createTask({
        tenantId: DEFAULTS.tenantId,
        projectId: DEFAULTS.projectId,
        memberId: DEFAULTS.memberId,
        workspacePath: body.workspacePath ?? DEFAULTS.workspacePath,
        prompt,
        idempotencyKey: `pi-thread-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        // Placeholder threads must not be claimed by the worker before their
        // first real message arrives; park them far in the future.
        availableAt: body.initialMessage?.content?.trim() ? undefined : Number.MAX_SAFE_INTEGER,
      });
      notify();
      return reply.code(201).send(taskToSnapshot(task, store.getEvents(task.id)));
    },
  );

  app.get<{ Params: { id: string } }>("/api/pi/threads/:id", async (request, reply) => {
    if (threadKind(request.params.id) === "room") {
      const snapshot = rooms.snapshotFor(request.params.id);
      return snapshot ?? notFound(reply);
    }
    const task = store.getTask(request.params.id);
    // A tombstoned thread is gone: 404, while its Task row stays for /api/tasks.
    if (!task || threads.get(task.id).deleted) return notFound(reply);
    return taskSnapshot(task);
  });

  // Sending a message.
  //
  // Room thread: the message is a GROUP TRIGGER — `postRoomMessage`, never a Task
  // retry. Multi-turn works there because the room owns an ordered message stream.
  //
  // Task thread: only the FIRST message is accepted. react-pi creates an empty
  // placeholder thread and then posts the real prompt, which `activatePlaceholder`
  // writes into `tasks.prompt` (204). That is the whole supported contract.
  //
  // **Recorded limitation, not an omission:** a single-agent thread does not do
  // follow-ups. A Task is one prompt (the projection rebuilds the transcript from
  // `task.prompt` + that run's canonical events), so a follow-up has nowhere to
  // live. The previous code called `retryTask` here and DISCARDED `content`, which
  // looked like support and was silently lossy: react-pi resolves any 2xx and keeps
  // its optimistic user message (`ThreadController.ts:368-391`), but
  // `reconcileOptimisticUserMessages` confirms it by matching the same text against
  // a `role:"user"` transcript entry — a transcript rebuilt from the OLD prompt can
  // never contain it, so the user's words appeared and then vanished on the next
  // snapshot while the worker re-ran the original prompt. Refusing with 4xx makes
  // the client throw instead, so the UI shows a failure rather than eating input.
  // Multi-turn conversation is the ROOM thread's job (Q29: group == one thread);
  // giving a single Task an ordered turn list would need a new projection, and
  // aggregating by `chainId` is wrong because handoff children carry prompts the
  // user never wrote. Re-running a Task stays where it honestly belongs:
  // `POST /api/tasks/:id/retry`.
  app.post<{ Params: { id: string }; Body: { input?: { content?: string }; workspacePath?: string } }>(
    "/api/pi/threads/:id/messages",
    async (request, reply) => {
      const content = request.body?.input?.content?.trim() ?? "";
      if (threadKind(request.params.id) === "room") {
        const sent = rooms.appendMessage(request.params.id, content, request.body?.workspacePath);
        if (sent.status >= 400) return reply.code(sent.status).send(sent.body);
        return reply.code(201).send(sent.body);
      }
      const task = store.getTask(request.params.id);
      if (!task) return notFound(reply);
      if (content === "") {
        return reply.code(400).send({ error: "消息内容不能为空", code: "CONTENT_REQUIRED" });
      }
      // First real message on a placeholder thread: the one supported case.
      if (store.activatePlaceholder(task.id, content)) {
        notify();
        return reply.code(204).send();
      }
      return reply.code(409).send({
        error: "单 agent 会话不支持追问：这条消息不会被保存，也不会重跑原任务。请新建会话，或在群聊里 @ 成员继续。",
        code: "FOLLOW_UP_NOT_SUPPORTED",
        threadId: task.id,
        taskStatus: task.status,
        hint: "追问/多轮由群线程承担（POST /api/pi/threads/room:<id>/messages）；重跑单个任务用 POST /api/tasks/:id/retry",
      });
    },
  );

  app.post<{ Params: { id: string } }>("/api/pi/threads/:id/cancel", async (request, reply) => {
    if (threadKind(request.params.id) === "room") {
      const cancelled = rooms.cancel(request.params.id);
      if (cancelled.status >= 400) return reply.code(cancelled.status).send(cancelled.body);
      // The contract expects 204; the extra fields ride on the body, which a
      // 204 must not carry, so answer 200 with them (see `RoomThreadSurface.cancel`).
      return reply.code(cancelled.status).send(cancelled.body);
    }
    if (!store.getTask(request.params.id)) return notFound(reply);
    worker.requestCancel(request.params.id);
    notify();
    return reply.code(204).send();
  });

  /**
   * `PATCH /api/pi/threads/:id` — rename.
   *
   * The title is stored per thread (see `PiThreadStore`) rather than rewritten
   * into the Task prompt or the imported ChatRoom name: a thread label is a UI
   * concern, and P6/Q28 own the two entities behind it.
   */
  app.patch<{ Params: { id: string }; Body: { title?: string } }>(
    "/api/pi/threads/:id",
    async (request, reply) => {
      const title = request.body?.title ?? "";
      if (threadKind(request.params.id) === "room") {
        const renamed = rooms.rename(request.params.id, title);
        if (renamed.status >= 400) return reply.code(renamed.status).send(renamed.body);
        return reply.code(204).send();
      }
      if (!store.getTask(request.params.id)) return notFound(reply);
      if (!title.trim()) return reply.code(400).send({ error: "title is required" });
      threads.setTitle(request.params.id, title.trim());
      return reply.code(204).send();
    },
  );

  /**
   * `DELETE /api/pi/threads/:id` — tombstone, plus a cancel for in-flight work.
   *
   * Deleting never destroys P6 evidence or the room's message stream: the thread
   * stops resolving and stops appearing in `listThreads`, while its Tasks,
   * Attempts, events and messages remain queryable through `/api/tasks` and
   * `/api/rooms`. That is the safe reading of P6 authority ("the project owns the
   * workspace; a group chat is a view") and it is why no `ExecutionStore` row
   * disappears here.
   *
   * Idempotent by contract: a thread that is already gone — deleted or never
   * existing — also answers 204.
   */
  app.delete<{ Params: { id: string } }>("/api/pi/threads/:id", async (request, reply) => {
    const threadId = request.params.id;
    if (threadKind(threadId) === "room") {
      const removed = rooms.remove(threadId);
      return reply.code(removed.status).send(removed.body);
    }
    const task = store.getTask(threadId);
    if (!task) return reply.code(204).send();
    // Stop in-flight work before hiding the thread, so no Attempt keeps running
    // for a thread nobody can see.
    if (!["succeeded", "failed", "cancelled", "blocked"].includes(task.status)) worker.requestCancel(threadId);
    threads.markDeleted(threadId);
    notify();
    return reply.code(204).send();
  });

  /**
   * `POST /api/pi/threads/:id/queue/clear`.
   *
   * `{ steering: [], followUp: [] }` is the truthful answer: P6 has no Pi
   * steer/follow-up queue (a Task is claimed from the durable queue, and there is
   * no in-run message queue to drain), so there is nothing to return to the
   * composer. Nothing is fabricated and nothing is hidden — an empty pair is what
   * `createSharedStreamCache` and `ThreadController.clearQueue` expect.
   */
  app.post<{ Params: { id: string } }>("/api/pi/threads/:id/queue/clear", async (request, reply) => {
    if (threadKind(request.params.id) === "room") {
      return rooms.threadExists(request.params.id)
        ? reply.send({ steering: [], followUp: [] })
        : notFound(reply);
    }
    if (!store.getTask(request.params.id)) return notFound(reply);
    return reply.send({ steering: [], followUp: [] });
  });

  /**
   * `GET /api/pi/models` — the catalog for the model picker.
   *
   * Source: Pi's own `<agent-dir>/models.json` (the same file react-pi's node
   * supervisor reads), plus any `provider/model` our own Task records reference.
   * A missing/unreadable file yields `[]`, which the client accepts; see
   * `pi-models.ts` for why guessing a provider would be worse than an empty list.
   */
  app.get<{ Querystring: { workspacePath?: string } }>("/api/pi/models", async () => {
    const path = catalogPath(options);
    const catalog = readModelCatalog(path);
    const observed = [
      ...store.listTasks().map((task) => task.model),
      ...options.rooms.listRooms().flatMap((room) => options.rooms.listAgents(room.id).map((agent) => agent.model)),
    ];
    return mergeModels(catalog, observed);
  });

  /**
   * `POST /api/pi/threads/:id/model`.
   *
   * Task thread: writes `tasks.model`, which `durable-worker` forwards to
   * `RunSpec.model` → Pi's `--model`. So it really does change the next Attempt —
   * this is not a decorative 204.
   *
   * Room thread: refused. A room has no thread-level model; each member runs as
   * its own persona with its own `RoomAgent.model` (Q29/Q38), so writing one
   * model onto the room would either silently override every persona or claim an
   * effect the runtime cannot have. A 4xx says so; a 204 would be theatre.
   */
  app.post<{ Params: { id: string }; Body: { provider?: string; modelId?: string } }>(
    "/api/pi/threads/:id/model",
    async (request, reply) => {
      const provider = request.body?.provider?.trim() ?? "";
      const modelId = request.body?.modelId?.trim() ?? "";
      if (!provider || !modelId) {
        return reply.code(400).send({ error: "provider and modelId are required", code: "MODEL_REQUIRED" });
      }
      if (threadKind(request.params.id) === "room") {
        return reply.code(400).send({
          error: "群没有线程级模型：每个成员的模型来自它自己的角色（RoomAgent.model），请在成员面板修改",
          code: "ROOM_MODEL_IS_PER_AGENT",
          roomId: parseRoomThreadId(request.params.id),
        });
      }
      if (!threads.setTaskModel(request.params.id, `${provider}/${modelId}`)) return notFound(reply);
      notify();
      return reply.code(204).send();
    },
  );

  /**
   * `POST /api/pi/threads/:id/thinking` — an accepted no-op, deliberately.
   *
   * Pi does take `--thinking` (`RunSpec.thinking`), but nothing between the API
   * and the runtime can carry a thread-level level today: `tasks` has no column
   * for it, `durable-worker` does not populate `spec.thinking`, and
   * `RoomAgent.thinkingMode` is per persona (owned by I5). Persisting a value
   * here that nothing reads — or echoing it back in `metadata.config` so the UI
   * shows a level that was never applied — would be a fake gate. The honest shape
   * is: succeed as a no-op, never claim it in metadata, and leave the wiring to
   * the issue that can carry it to `RunSpec`.
   */
  app.post<{ Params: { id: string }; Body: { level?: string } }>(
    "/api/pi/threads/:id/thinking",
    async (request, reply) => {
      const level = request.body?.level?.trim() ?? "";
      if (!level) return reply.code(400).send({ error: "level is required", code: "THINKING_LEVEL_REQUIRED" });
      const exists = threadKind(request.params.id) === "room"
        ? rooms.threadExists(request.params.id)
        : store.getTask(request.params.id) !== null;
      if (!exists) return notFound(reply);
      return reply.code(204).send();
    },
  );

  /** `POST /:id/archive` | `/:id/unarchive` — persisted, because `archived` is a
   * contract field the UI reads. Archived threads leave `listThreads` unless the
   * caller asks for them, and still resolve by id. */
  for (const [route, archived] of [["archive", true], ["unarchive", false]] as const) {
    app.post<{ Params: { id: string } }>(`/api/pi/threads/:id/${route}`, async (request, reply) => {
      const threadId = request.params.id;
      if (threadKind(threadId) === "room") {
        const set = rooms.setArchived(threadId, archived);
        if (set.status >= 400) return reply.code(set.status).send(set.body);
        return reply.code(204).send();
      }
      if (!store.getTask(threadId)) return notFound(reply);
      threads.setArchived(threadId, archived);
      return reply.code(204).send();
    });
  }

  /**
   * `POST /api/pi/threads/:id/host-ui` — the approval surface.
   *
   * We run Pi headless through our own adapter and never forward Pi's
   * `extension_ui_request` frames (see `pi-thread.ts`, which drops them with the
   * rest of the frames the transcript contract cannot carry), so there is
   * NEVER a pending request to answer. 204 with no state change: the client's
   * `respondToHostUiRequest` resolves, and the reducer's `extension_ui_resolved`
   * is a no-op for an empty list. High-risk tool outcomes are handled where they
   * are actually detected — `blocked` + `POST /api/tasks/:id/confirm` (P6).
   */
  app.post<{ Params: { id: string }; Body: { response?: unknown } }>(
    "/api/pi/threads/:id/host-ui",
    async (request, reply) => {
      const threadId = request.params.id;
      const exists = threadKind(threadId) === "room"
        ? rooms.threadExists(threadId)
        : store.getTask(threadId) !== null;
      if (!exists) return notFound(reply);
      if (request.body?.response === undefined) {
        return reply.code(400).send({ error: "response is required", code: "HOST_UI_RESPONSE_REQUIRED" });
      }
      // No pending request can exist, so the answer is dropped and the thread's
      // host-UI list stays empty. 204 with NO body: Fastify rejects a payload on
      // a 204, and the reason belongs in this comment rather than on the wire.
      return reply.code(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // SSE
  // -------------------------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { snapshot?: string; after?: string } }>(
    "/api/pi/threads/:id/events",
    async (request, reply) => {
      if (threadKind(request.params.id) === "room") {
        streamRoom(request, reply, rooms, openStream);
        return;
      }
      const task = store.getTask(request.params.id);
      if (!task) return notFound(reply);
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      openStream(reply.raw, request);

      const sendEvent = (event: unknown) => {
        // `close`/shutdown can end the response between two polls; writing to an
        // ended stream throws and would take the interval's caller down with it.
        if (reply.raw.writableEnded || reply.raw.destroyed) return;
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      // Snapshot-first by default so a fresh subscriber has full state.
      if (request.query.snapshot !== "false") {
        sendEvent({ threadId: task.id, seq: 0, type: "snapshot", snapshot: taskToSnapshot(task, store.getEvents(task.id)) });
      }

      let cursor = Number(request.query.after ?? 0);
      let lastStatus = task.status;
      let settledEmitted = false;
      const TERMINAL = new Set(["succeeded", "failed", "cancelled", "blocked"]);
      const tick = () => {
        const rows = store.getEvents(task.id, cursor);
        for (const row of rows) {
          cursor = row.id;
          const event = toPiClientEvent(task.id, row, store.getEvents(task.id));
          if (event) {
            sendEvent(event);
            if (event.type === "agent_settled") settledEmitted = true;
          }
        }
        // Terminal tasks must leave the UI's running state even when the runtime
        // never emitted agent_end (e.g. the mock adapter): emit it once, then a
        // fresh snapshot so status/usage stay authoritative.
        const latest = store.getTask(task.id);
        if (latest && latest.status !== lastStatus) {
          lastStatus = latest.status;
          if (TERMINAL.has(latest.status) && !settledEmitted) {
            settledEmitted = true;
            sendEvent({ threadId: task.id, seq: ++cursor, type: "agent_end", willRetry: false });
            sendEvent({ threadId: task.id, seq: ++cursor, type: "agent_settled" });
          }
          sendEvent({ threadId: task.id, seq: ++cursor, type: "snapshot", snapshot: taskToSnapshot(latest, store.getEvents(task.id)) });
        }
      };
      tick();
      const timer = setInterval(() => {
        tick();
        if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
      }, 1000);
      timer.unref();
      request.raw.on("close", () => clearInterval(timer));
    },
  );
}

/**
 * The room's SSE stream.
 *
 * Framing follows the single-Task stream above, because that code already proved
 * away the two failure modes that matter: snapshot-first, and a terminal state
 * that closes the run so the UI never sits in `running` forever.
 *
 * What differs is what "state" means. A room has no attempt-level event table to
 * tail, and relaying one would put an agent's *draft* text in the chat under its
 * name — the committed `result.summary` is what it actually said (Q39). So this
 * polls the two things that are real for a room:
 *  1. newly committed stream messages (tracked by message id, so ordering and
 *     dedup never depend on clocks), and
 *  2. the round's run state (`running` ⇄ settled), derived from the room's Tasks.
 *
 * Every frame claims the room's durable watermark, so seq is monotonic per
 * thread across reconnects and across concurrent subscribers — the client's
 * reducer silently drops anything at or below its own watermark, and a seq that
 * restarted at 1 after a reconnect would freeze the transcript.
 */
function streamRoom(
  request: FastifyRequest<{ Params: { id: string }; Querystring: { snapshot?: string } }>,
  reply: FastifyReply,
  rooms: RoomThreadSurface,
  openStream: (stream: ServerResponse, request: FastifyRequest) => void,
): void {
  const threadId = request.params.id;
  let record = rooms.record(threadId);
  if (!record) {
    reply.code(404).send({ error: "thread not found" });
    return;
  }
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  openStream(reply.raw, request);
  const sendEvent = (event: unknown) => {
    if (reply.raw.writableEnded || reply.raw.destroyed) return;
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Messages already delivered to THIS connection: seeded from the snapshot we
  // are about to send (or from the transcript the caller says it already has,
  // with `snapshot=false`), so a subscriber never sees one message twice.
  const seen = new Set<string>(record.messages.map((message) => message.id));
  if (request.query.snapshot !== "false") sendEvent(rooms.snapshotFrame(record));
  // Derived through the same function the snapshots use: `running` here, in the
  // metadata there and in the UI must never disagree because two copies drifted.
  let running = roomThreadStatus(record.tasks) === "running";

  // Declared before `tick` because the first tick can end the stream: a `const`
  // below would be a temporal-dead-zone ReferenceError instead of a close.
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (timer) clearInterval(timer);
    reply.raw.end();
  };

  const tick = () => {
    const latest = rooms.record(threadId);
    // The thread can be deleted (or its room removed) while we watch it. Say so
    // and stop, rather than holding a stream over a thread that no longer
    // resolves. `terminal: true` is what makes the client stop reconnecting.
    if (!latest) {
      sendEvent({ threadId, seq: 0, type: "error", error: "thread no longer exists", terminal: true });
      stop();
      return;
    }
    for (const frame of rooms.messageFrames(latest, seen)) sendEvent(frame);
    const transition = rooms.transitionFrames(latest, running);
    running = transition.running;
    for (const frame of transition.frames) sendEvent(frame);
    // The settle snapshot carries the final transcript (an agent's reply lands in
    // the same commit as its Task's success, Q39) and the authoritative
    // `status`, mirroring the Task stream's terminal snapshot.
    if (!transition.running && transition.frames.length > 0) sendEvent(rooms.snapshotFrame(latest));
  };
  tick();
  if (!reply.raw.writableEnded) {
    timer = setInterval(() => {
      tick();
      if (!reply.raw.writableEnded) reply.raw.write(": heartbeat\n\n");
    }, 1000);
    timer.unref();
    request.raw.on("close", () => { if (timer) clearInterval(timer); });
  }
}
