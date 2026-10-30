/**
 * `/api/pi` route layer — serves the `PiClient` contract over the durable Task
 * store so `@assistant-ui/react-pi` can drive the UI.
 *
 * Wire contract expected by `createPiHttpClient`:
 *   GET    /threads                 → PiThreadMetadata[]
 *   POST   /threads                 → PiThreadSnapshot
 *   GET    /threads/:id             → PiThreadSnapshot
 *   POST   /threads/:id/messages    → 204   (retry the task with new content)
 *   POST   /threads/:id/cancel      → 204
 *   GET    /threads/:id/events      → SSE of PiClientEvent
 *
 * Task==Thread. These routes are a *projection* over the same ExecutionStore
 * the /api/tasks routes use, so the durable queue, leases and recovery stay
 * authoritative. The UI never drives Pi directly.
 */

import type { FastifyInstance } from "fastify";
import type { DurableWorker, ExecutionStore } from "@my-team-agents/orchestrator";
import { taskToSnapshot, taskToThreadMetadata, toPiClientEvent } from "./pi-thread.js";

interface PiRouteOptions {
  store: ExecutionStore;
  worker: DurableWorker;
  notify: () => void;
}

const DEFAULTS = {
  tenantId: "default",
  projectId: "my-team-agents",
  memberId: "pi-agent",
  workspacePath: process.cwd(),
};

export function registerPiRoutes(app: FastifyInstance, options: PiRouteOptions): void {
  const { store, worker, notify } = options;
  const notFound = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(404).send({ error: "thread not found" });

  app.get("/api/pi/threads", async () =>
    store.listTasks().map((task) => taskToThreadMetadata(task)));

  app.post<{ Body: { workspacePath?: string; title?: string; initialMessage?: { content: string } } }>(
    "/api/pi/threads",
    async (request, reply) => {
      const body = request.body ?? {};
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
    const task = store.getTask(request.params.id);
    if (!task) return notFound(reply);
    return taskToSnapshot(task, store.getEvents(task.id));
  });

  // Sending a message: a placeholder thread (created empty by react-pi's
  // initialize) is activated with its first real prompt; an already-run thread
  // maps to a durable retry (new Attempt, same conversation).
  app.post<{ Params: { id: string }; Body: { input?: { content?: string } } }>(
    "/api/pi/threads/:id/messages",
    async (request, reply) => {
      const task = store.getTask(request.params.id);
      if (!task) return notFound(reply);
      const content = request.body?.input?.content?.trim() ?? "";
      if (store.activatePlaceholder(task.id, content)) {
        notify();
        return reply.code(204).send();
      }
      if (!store.retryTask(task.id)) {
        return reply.code(409).send({ error: "only finished threads accept a follow-up" });
      }
      notify();
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>("/api/pi/threads/:id/cancel", async (request, reply) => {
    if (!store.getTask(request.params.id)) return notFound(reply);
    worker.requestCancel(request.params.id);
    notify();
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string }; Querystring: { snapshot?: string; after?: string } }>(
    "/api/pi/threads/:id/events",
    async (request, reply) => {
      const task = store.getTask(request.params.id);
      if (!task) return notFound(reply);
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const sendEvent = (event: unknown) => {
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
        reply.raw.write(": heartbeat\n\n");
      }, 1000);
      timer.unref();
      request.raw.on("close", () => clearInterval(timer));
    },
  );
}
