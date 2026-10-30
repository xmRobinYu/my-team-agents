import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerResponse } from "node:http";
import type { CreateTaskInput, DurableWorker, ExecutionStore } from "@my-team-agents/orchestrator";
import { registerPiRoutes } from "./pi-routes.js";

export interface AppOptions {
  store: ExecutionStore;
  worker: DurableWorker;
  staticRoot?: string;
}

interface TaskBody {
  tenantId?: string;
  projectId?: string;
  memberId?: string;
  workspacePath?: string;
  prompt?: string;
  model?: string;
  idempotencyKey?: string;
}

const validTask = (body: TaskBody) =>
  [body.tenantId, body.projectId, body.memberId, body.workspacePath, body.prompt]
    .every((v) => typeof v === "string" && v.trim().length > 0);

/** Local-only P7a API. Production auth/tenant isolation is a separate P7b gate. */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { store, worker } = options;
  const clients = new Set<ServerResponse>();
  const notify = () => {
    for (const client of clients) client.write(`event: tasks\ndata: ${JSON.stringify(store.listTasks())}\n\n`);
  };
  app.addHook("onClose", async () => {
    for (const client of clients) client.end();
    clients.clear();
  });

  app.get("/api/health", async () => ({
    ok: true, mode: "development", version: "p7a",
    auth: "loopback-only", workerRecovery: true,
  }));
  app.get("/api/catalog", async () => ({
    tenants: [{ id: "default", name: "开发租户" }],
    projects: [{ id: "my-team-agents", name: "my-team-agents", workspacePath: process.cwd() }],
    members: [
      { id: "mock-agent", name: "本地验证员工", runtime: "mock", projectId: "my-team-agents" },
      { id: "pi-agent", name: "Pi 数字员工", runtime: "pi", projectId: "my-team-agents" },
    ],
    notice: "开发模式：目录为本机配置，不是组织权限模型。",
  }));
  app.get("/api/tasks", async () => store.listTasks());
  app.post<{ Body: TaskBody }>("/api/tasks", async (request, reply) => {
    if (!validTask(request.body ?? {})) {
      return reply.code(400).send({ error: "tenantId, projectId, memberId, workspacePath and prompt are required" });
    }
    const body = request.body;
    const input: CreateTaskInput = {
      tenantId: body.tenantId!,
      projectId: body.projectId!,
      memberId: body.memberId!,
      workspacePath: body.workspacePath!,
      prompt: body.prompt!,
      model: body.model,
      idempotencyKey: body.idempotencyKey,
    };
    const task = store.createTask(input);
    notify();
    return reply.code(201).send(task);
  });
  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const task = store.getTask(request.params.id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    return {
      task,
      attempts: store.getAttempts(task.id),
      events: store.getEvents(task.id),
      chain: store.getChain(task.chainId),
      chainTasks: store.getChainTasks(task.chainId),
      handoffs: store.getOutbox(task.id),
      usage: store.getUsage(task.id),
    };
  });
  app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (request, reply) => {
    if (!store.getTask(request.params.id)) return reply.code(404).send({ error: "task not found" });
    const result = worker.requestCancel(request.params.id);
    notify();
    return result;
  });
  app.post<{ Params: { id: string } }>("/api/tasks/:id/retry", async (request, reply) => {
    if (!store.retryTask(request.params.id)) {
      return reply.code(409).send({ error: "only failed, blocked or cancelled tasks can be retried" });
    }
    notify();
    return store.getTask(request.params.id);
  });
  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    "/api/tasks/:id/confirm",
    async (request, reply) => {
      const note = request.body?.note;
      if (typeof note !== "string" || !note.trim()) {
        return reply.code(400).send({ error: "confirmation note is required" });
      }
      if (!store.confirmBlocked(request.params.id, note)) {
        return reply.code(409).send({ error: "only blocked tasks can be confirmed" });
      }
      notify();
      return store.getTask(request.params.id);
    },
  );
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/api/tasks/:id/events",
    async (request, reply) => {
      const task = store.getTask(request.params.id);
      if (!task) return reply.code(404).send({ error: "task not found" });
      const after = Number(request.query.after ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) {
        return reply.code(400).send({ error: "after must be a non-negative integer" });
      }
      return store.getEvents(task.id, after);
    },
  );
  app.get("/api/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(`retry: 2000\nevent: tasks\ndata: ${JSON.stringify(store.listTasks())}\n\n`);
    clients.add(reply.raw);
    let lastUpdate = 0;
    const heartbeat = setInterval(() => {
      const latest = store.listTasks(1)[0]?.updatedAt ?? 0;
      if (latest !== lastUpdate) {
        lastUpdate = latest;
        reply.raw.write(`event: tasks\ndata: ${JSON.stringify(store.listTasks())}\n\n`);
      } else reply.raw.write(": heartbeat\n\n");
    }, 1000);
    heartbeat.unref();
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(reply.raw);
    });
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/api/tasks/:id/stream",
    async (request, reply) => {
      const task = store.getTask(request.params.id);
      if (!task) return reply.code(404).send({ error: "task not found" });
      const after = Number(request.query.after ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) {
        return reply.code(400).send({ error: "after must be a non-negative integer" });
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
        Connection: "keep-alive", "X-Accel-Buffering": "no",
      });
      let cursor = after;
      let lastStatus = "";
      const send = () => {
        for (const item of store.getEvents(task.id, cursor)) {
          cursor = item.id;
          reply.raw.write(`id: ${item.id}\nevent: run\ndata: ${JSON.stringify(item)}\n\n`);
        }
        const latest = store.getTask(task.id);
        if (latest && latest.status !== lastStatus) {
          lastStatus = latest.status;
          reply.raw.write(`event: task\ndata: ${JSON.stringify(latest)}\n\n`);
        }
      };
      send();
      const timer = setInterval(() => { send(); reply.raw.write(": heartbeat\n\n"); }, 1000);
      timer.unref();
      request.raw.on("close", () => clearInterval(timer));
    },
  );

  registerPiRoutes(app, { store, worker, notify });

  if (options.staticRoot && existsSync(options.staticRoot)) {
    await app.register(fastifyStatic, { root: resolve(options.staticRoot), prefix: "/" });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
