import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerResponse } from "node:http";
import { createIngestService, IngestStore, listAgentSkills, RoomStore, type CreateTaskInput, type DurableWorker, type ExecutionStore } from "@my-team-agents/orchestrator";
import { ingestConfig, MIN_TOKEN_LENGTH } from "./config.js";
import { isolationStatus } from "./runtime.js";
import { registerIngestRoutes } from "./ingest-routes.js";
import { registerPiRoutes } from "./pi-routes.js";
import { registerRoomRoutes } from "./room-routes.js";
import { registerSkillRoutes } from "./skill-routes.js";

export interface AppOptions {
  store: ExecutionStore;
  worker: DurableWorker;
  staticRoot?: string;
  /** Defaults to a RoomStore over the ExecutionStore handle: rooms and tasks commit under one database. */
  rooms?: RoomStore;
  roomsRoot?: string;
  defaultProjectId?: string;
  /** Project workspace for I3 mention-triggered Tasks. Defaults to `<cwd>` (same as /api/pi). */
  defaultWorkspacePath?: string;
  /** Task attribution tenant for triggered Tasks. Defaults to "default". */
  defaultTenantId?: string;
  /**
   * P9a: the inbound-event store. Defaults to one over `store.db`, so events and
   * Tasks commit together. Injected when a caller (a test, or a worker process)
   * already holds an instance.
   */
  ingest?: IngestStore;
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
  const rooms = options.rooms ?? new RoomStore(store.db);
  // P9a: same database handle as the Tasks it creates, so an event + its Tasks +
  // its outcome commit in one transaction (the rule `postRoomMessage` follows).
  const ingest = options.ingest ?? new IngestStore(store.db);
  const clients = new Set<ServerResponse>();
  const notify = () => {
    for (const client of clients) client.write(`event: tasks\ndata: ${JSON.stringify(store.listTasks())}\n\n`);
  };
  app.addHook("onClose", async () => {
    for (const client of clients) client.end();
    clients.clear();
  });

  const ingestCfg = ingestConfig();

  // An anonymous inbound surface is a deliberate choice, so it is never quiet.
  // stderr, not the structured logger: this is a startup fact, not request noise.
  if (ingestCfg.open && ingestCfg.token === undefined) {
    process.stderr.write(
      "[mta] WARNING: /api/ingest is OPEN WITHOUT A TOKEN (MTA_INGEST_ALLOW_ANON=1).\n"
      + "[mta]          Loopback only. Never expose this listener — set MTA_INGEST_TOKEN.\n");
  }
  if (ingestCfg.enabled && !ingestCfg.open) {
    process.stderr.write(
      `[mta] /api/ingest stays CLOSED: ${ingestCfg.reason ?? "unknown"}`
      + ` (MTA_INGEST_TOKEN must be >= ${MIN_TOKEN_LENGTH} chars).\n`);
  }

  // Read once, so health and the route registration cannot disagree. `enabled` is
  // the operator's intent; `open` is what actually happened, and `reason` is the
  // difference. Reporting only `enabled` was the old bug: a bare
  // `MTA_INGEST_ENABLED=1` produced an OPEN endpoint while health said nothing
  // about a missing token.

  app.get("/api/health", async () => ({
    ok: true, mode: "development", version: "p9a",
    auth: "loopback-only", workerRecovery: true,
    ingest: {
      enabled: ingestCfg.enabled,
      open: ingestCfg.open,
      tokenRequired: ingestCfg.token !== undefined,
      anonymousAllowed: ingestCfg.open && ingestCfg.token === undefined,
      reason: ingestCfg.reason ?? null,
    },
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

  // I7: `/api/pi` now projects two kinds of thread — a Task (P7a) and a
  // ChatRoom (Q29) — so it reads the room store over the same database handle
  // `buildApp` already shares with the room routes.
  registerPiRoutes(app, {
    store, worker, notify, rooms,
    defaultWorkspacePath: options.defaultWorkspacePath,
  });

  // I2: rooms are additive. Registered after /api/pi so its encapsulated body
  // parsers cannot change how /api/tasks and /api/pi see request bodies.
  await registerRoomRoutes(app, {
    store: rooms,
    // Same handle by construction (`rooms` defaults to `new RoomStore(store.db)`),
    // so the mention trigger's message + Tasks commit together.
    executions: store,
    roomsRoot: options.roomsRoot,
    defaultProjectId: options.defaultProjectId,
    defaultWorkspacePath: options.defaultWorkspacePath,
    defaultTenantId: options.defaultTenantId,
  });

  // I9: agent skill management rides the same RoomStore seam as /api/rooms, in
  // its own encapsulated scope so it cannot alter any existing body handling.
  await registerSkillRoutes(app, { store: rooms });

  // P9a: the inbound-event surface. Its own encapsulated scope, so its body
  // handling cannot change what /api/tasks and /api/pi see. Inert unless
  // MTA_INGEST_ENABLED=1 (D6/A), and bearer-guarded when MTA_INGEST_TOKEN is set.
  // `memberExists` reads the room roster: a rule must name a real persona, which is
  // AC1.3's registration-time check (not a runtime silent degrade).
  const { open, token } = ingestCfg;
  const ingestService = createIngestService({
    executions: store,
    ingest,
    memberExists: (memberId) => rooms.getAgent(memberId) !== null,
  // P9b: the persona behind a rule target. `listAgentSkills` reports only skills Pi
  // would actually load, so a rule cannot name one that exists on disk but is
  // unreadable — the exact I9 defect where an imported skill was invisible to Pi.
  persona: (memberId) => {
    const agent = rooms.getAgent(memberId);
    if (!agent) return null;
    return {
      ...(agent.agentDir ? { agentDir: agent.agentDir } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.agentDir
        ? { loadableSkills: listAgentSkills(agent.agentDir).skills.filter((sk) => sk.loadable).map((sk) => sk.slug) }
        : {}),
    };
  },
  // P9e: AIHOT names no source on the wire, so the deployment names it once here.
  ...(ingestCfg.defaultSource ? { defaultSource: ingestCfg.defaultSource } : {}),
  // P9d: same measured gate as the worker, so a rule accepted by the API is one the
  // worker will actually be able to run.
  writableTools: isolationStatus,
  });
  await registerIngestRoutes(app, {
    executions: store,
    ingest,
    service: ingestService,
    defaultProjectId: options.defaultProjectId ?? "my-team-agents",
    defaultTenantId: options.defaultTenantId ?? "default",
    // `open`, not `enabled`: enabled-without-a-token is closed, and registering the
    // routes anyway is exactly the hole this closes.
    enabled: open,
    ...(token ? { token } : {}),
  });

  if (options.staticRoot && existsSync(options.staticRoot)) {
    await app.register(fastifyStatic, { root: resolve(options.staticRoot), prefix: "/" });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
