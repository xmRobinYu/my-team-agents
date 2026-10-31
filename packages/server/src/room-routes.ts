/**
 * `/api/rooms` route layer — Issue I2's service seam.
 *
 *   POST /api/rooms/import         import a teamagentx template package
 *   GET  /api/rooms                list ChatRooms
 *   GET  /api/rooms/:id/agents     the room's agents, coordinator flagged
 *   GET  /api/rooms/:id/messages   the shared message stream
 *   POST /api/rooms/:id/messages   @mention trigger (I3): queue one Task per target
 *
 * Transport for the package — two shapes, both accepted:
 *   1. `{"path": "/abs/or/rel/包.zip", "projectId"?: "...", "dryRun"?: true}`
 *      with the usual JSON content type. Chosen for scripts and for the local
 *      dev posture of this API (loopback, no auth — same as /api/tasks):
 *      packages live on disk under `ref/`, and a path keeps request bodies
 *      small and failure modes obvious (missing file vs corrupt zip).
 *   2. A raw binary body (`application/octet-stream`, `application/zip`, or
 *      any `*+zip`) — what `fetch(url, { body: file })` from a browser sends.
 *      No `@fastify/multipart`: multipart adds a dependency and a second body
 *      model for a local-only API. The UI (I8) can upload the raw file, and
 *      the importer needs bytes either way.
 *
 * Failure contract: a bad package answers 4xx with `code` + `message`, and the
 * store is left untouched because the importer rolled its transaction back — a
 * failed import never becomes a partially visible room.
 *
 * Encapsulation: the extra content type parsers are registered inside a child
 * context, so `/api/pi` and `/api/tasks` keep Fastify's stock JSON handling.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  importTemplatePackage,
  planTemplateImport,
  postRoomMessage,
  RoomTriggerError,
  TemplateImportError,
  type ExecutionStore,
  type ImportResult,
  type PlannedImport,
  type RoomStore,
  type ZipSource,
} from "@my-team-agents/orchestrator";

export interface RoomRouteOptions {
  store: RoomStore;
  /**
   * I3: the mention trigger writes Tasks beside the message, so it needs the
   * ExecutionStore over the SAME database handle as `store` (one commit, or none).
   */
  executions: ExecutionStore;
  /** Root for generated persona dirs. Defaults to `<cwd>/.rooms`. */
  roomsRoot?: string;
  /** Project an imported room belongs to when the caller does not say (Q34). */
  defaultProjectId?: string;
  /** Project workspace the triggered Tasks run against. Defaults to `<cwd>`. */
  defaultWorkspacePath?: string;
  /** Task attribution tenant; the API is loopback-only, single-tenant (P7a). */
  defaultTenantId?: string;
}

interface PostMessageBody {
  content?: string;
  /** Overrides the project workspace the Tasks point at. */
  workspacePath?: string;
}

interface ImportBody {
  path?: string;
  projectId?: string;
  /** Report the plan (coordinator decision, ignored fields) without writing. */
  dryRun?: boolean;
}

/** Sample packages are 10–200 KB; the cap leaves room for skill-heavy ones. */
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;

/**
 * Raw-zip uploads. Fastify accepts a string, a string[] or a RegExp here — not
 * a predicate — so one pattern covers octet-stream plus every zip flavour
 * (`application/zip`, `x-zip-compressed`, `application/foo+zip`) and an
 * optional `; charset=` suffix.
 */
const ZIP_CONTENT_TYPE = /^application\/(?:octet-stream|[\w.+-]*zip[\w.+-]*)(?:;.*)?$/i;

const importError = (reply: FastifyReply, err: TemplateImportError) => {
  const status = err.code === "WRITE_FAILED" ? 500
    : err.code === "ZIP_UNREADABLE" ? 404
    : 400;
  return reply.code(status).send({
    error: err.message,
    code: err.code,
    file: err.file ?? null,
    hint: "导入已回滚：没有创建群，也没有留下 agentDir",
  });
};

const present = (result: ImportResult) => ({
  room: result.room,
  coordinator: result.coordinator,
  agents: result.agents,
  roomRoot: result.roomRoot,
  agentDirs: result.agentDirs,
  filesWritten: result.filesWritten,
  ignoredFields: result.ignoredFields,
  warnings: result.warnings,
});

const presentPlan = (plan: PlannedImport) => ({
  dryRun: true,
  roomInput: plan.roomInput,
  roomRoot: plan.roomRoot,
  coordinator: plan.coordinator,
  agents: plan.agents.map((agent) => ({
    name: agent.input.name,
    role: agent.role,
    agentDir: agent.agentDir,
    isCoordinator: agent.input.isCoordinator,
    skills: agent.skills,
    files: agent.files,
  })),
  ignoredFields: plan.ignoredFields,
  warnings: plan.warnings,
});

export async function registerRoomRoutes(
  app: FastifyInstance,
  options: RoomRouteOptions,
): Promise<void> {
  const { store, executions } = options;
  const roomsRoot = options.roomsRoot ?? resolve(process.cwd(), ".rooms");
  const defaultProjectId = options.defaultProjectId ?? "my-team-agents";
  // Tasks run against the project workspace; the persona dir takes over the child
  // cwd (I3), so workspacePath stays attribution + the fallback for agents without one.
  const defaultWorkspacePath = options.defaultWorkspacePath ?? process.cwd();
  const defaultTenantId = options.defaultTenantId ?? "default";

  await app.register(async (scope) => {
    // Raw zip upload: keep the bytes, do not try to parse them as JSON.
    scope.addContentTypeParser(
      ZIP_CONTENT_TYPE,
      { bodyLimit: MAX_PACKAGE_BYTES },
      (_request, payload, done) => {
        const chunks: Buffer[] = [];
        let size = 0;
        payload.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_PACKAGE_BYTES) {
            payload.destroy(new Error(`模板包超过 ${MAX_PACKAGE_BYTES} 字节上限`));
            return;
          }
          chunks.push(chunk);
        });
        payload.on("end", () => done(null, Buffer.concat(chunks)));
        payload.on("error", (err: Error) => done(err));
      },
    );

    scope.post<{ Body: ImportBody | Buffer }>(
      "/api/rooms/import",
      { bodyLimit: MAX_PACKAGE_BYTES },
      async (request, reply) => {
        const body = request.body;
        let source: ZipSource;
        let plan: { projectId?: string; dryRun?: boolean } = {};

        if (Buffer.isBuffer(body)) {
          if (body.byteLength === 0) {
            return reply.code(400).send({ error: "上传的模板包是空的", code: "PACKAGE_EMPTY" });
          }
          source = new Uint8Array(body);
        } else {
          const json = body ?? {};
          const path = typeof json.path === "string" ? json.path.trim() : "";
          if (path === "") {
            return reply.code(400).send({
              error: "需要 JSON body 的 path（模板包 zip 路径），或以 application/octet-stream 上传 zip 字节",
              code: "PACKAGE_REQUIRED",
            });
          }
          if (!path.toLowerCase().endsWith(".zip")) {
            return reply.code(400).send({ error: `模板包必须是 .zip：${path}`, code: "PACKAGE_NOT_ZIP" });
          }
          const file = resolve(path);
          if (!existsSync(file)) {
            return reply.code(404).send({ error: `找不到模板包：${file}`, code: "ZIP_UNREADABLE", file });
          }
          source = new Uint8Array(readFileSync(file));
          plan = { projectId: json.projectId, dryRun: json.dryRun };
        }

        const projectId = plan.projectId?.trim() ? plan.projectId : defaultProjectId;
        try {
          if (plan.dryRun) {
            return reply.send(presentPlan(planTemplateImport(source, { projectId, roomsRoot })));
          }
          const result = importTemplatePackage({ zip: source, store, projectId, roomsRoot });
          return reply.code(201).send(present(result));
        } catch (err) {
          if (err instanceof TemplateImportError) return importError(reply, err);
          const message = err instanceof Error ? err.message : String(err);
          request.log.error({ err }, "room import failed");
          return reply.code(500).send({ error: `导入失败：${message}`, code: "INTERNAL" });
        }
      },
    );

    scope.get("/api/rooms", async () => store.listRooms());

    scope.get<{ Params: { id: string } }>("/api/rooms/:id/agents", async (request, reply) => {
      if (!store.getRoom(request.params.id)) {
        return reply.code(404).send({ error: "room not found", code: "ROOM_NOT_FOUND" });
      }
      return store.listAgents(request.params.id);
    });

    scope.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
      "/api/rooms/:id/messages",
      async (request, reply) => {
        if (!store.getRoom(request.params.id)) {
          return reply.code(404).send({ error: "room not found", code: "ROOM_NOT_FOUND" });
        }
        const asked = Number(request.query.limit);
        const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 2000) : 500;
        return store.listMessages(request.params.id, limit);
      },
    );

    // I3: @mention trigger. `postRoomMessage` owns the validation order and the
    // all-or-nothing commit; this layer only maps codes onto statuses.
    scope.post<{ Params: { id: string }; Body: PostMessageBody | undefined }>(
      "/api/rooms/:id/messages",
      async (request, reply) => {
        const body = request.body ?? {};
        try {
          const result = postRoomMessage(store, executions, {
            roomId: request.params.id,
            content: typeof body.content === "string" ? body.content : "",
            tenantId: defaultTenantId,
            workspacePath: body.workspacePath?.trim() ? body.workspacePath : defaultWorkspacePath,
          });
          return reply.code(201).send(result);
        } catch (err) {
          if (err instanceof RoomTriggerError) {
            const status = err.code === "ROOM_NOT_FOUND" ? 404 : 400;
            return reply.code(status).send({
              error: err.detail,
              code: err.code,
              names: err.names,
              hint: "提及未生效：消息与任务都未写入（事务已回滚）",
            });
          }
          const message = err instanceof Error ? err.message : String(err);
          request.log.error({ err }, "room message post failed");
          return reply.code(500).send({ error: `触发失败：${message}`, code: "INTERNAL" });
        }
      },
    );
  });
}
