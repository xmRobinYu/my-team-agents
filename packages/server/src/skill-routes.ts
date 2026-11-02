/**
 * `/api/rooms/:id/agents/:agentId/skills` — Issue I9's skill surface (AC8.1/AC8.3).
 *
 *   GET    .../skills            list this agent's skills, loadability included
 *   POST   .../skills            install one skill (uploaded text files, JSON body)
 *   DELETE .../skills/:slug      remove one skill
 *
 * Style follows `room-routes.ts`: same encapsulated child scope, same
 * `{ error, code, detail, hint }` failure shape, 404 only for a genuinely missing
 * entity and 4xx for a refused request. Everything filesystem-facing is delegated
 * to `@my-team-agents/orchestrator`'s skill module, which is where the slug
 * whitelist and the path-traversal gate live — this layer only maps errors onto
 * statuses, so the two cannot disagree about what is legal.
 *
 * Decisions that are visible to callers:
 *  - `GET` on an agent with no `skills/` directory answers 200 with an empty list:
 *    having no skills is the normal state, not a missing resource. Only an unknown
 *    agent id (or one belonging to another room) is a 404.
 *  - `DELETE` of a skill that is not installed answers 404 rather than an
 *    idempotent 204 — uninstall is destructive, and success for a typo'd slug
 *    would claim a skill is gone while it is still installed and still injected.
 *  - A skill that cannot load (no `SKILL.md`, or no frontmatter `description`,
 *    which Pi skips) is still listed, with `loadable: false` and the reason.
 *  - `POST` answers 201 for a new skill and 200 when `overwrite: true` replaced an
 *    existing one, and never overwrites without that flag.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import {
  assertSkillSlug,
  installSkill,
  listAgentSkills,
  SkillError,
  uninstallSkill,
  type RoomStore,
} from "@my-team-agents/orchestrator";

/**
 * `server` does not declare `@my-team-agents/domain` as a dependency (it reaches
 * rooms through `RoomStore`), so the agent shape is read off the store's own
 * return type instead of adding a workspace dependency for a type import — the
 * same convention as `pi-room-thread.ts`.
 */
type RoomAgent = NonNullable<ReturnType<RoomStore["getAgent"]>>;

export interface SkillRouteOptions {
  store: RoomStore;
}

interface InstallFileBody {
  path?: unknown;
  content?: unknown;
}

interface InstallBody {
  slug?: unknown;
  files?: unknown;
  overwrite?: unknown;
}

/**
 * Skill payloads are text. The per-file and file-count caps keep one request
 * bounded; the route's `bodyLimit` matches the template importer's 16 MiB so a
 * real bundle fits either way (the PPT package ships 57 skill files).
 */
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 64;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

const skillError = (reply: FastifyReply, err: SkillError) => {
  const status = err.code === "SKILL_NOT_FOUND" ? 404
    : err.code === "SKILL_EXISTS" ? 409
    : err.code === "AGENT_DIR_MISSING" ? 409
    : err.code === "WRITE_FAILED" ? 500
    : 400;
  return reply.code(status).send({
    error: err.message,
    code: err.code,
    detail: err.detail ?? null,
    hint: status === 400
      ? "请求被拒绝：slug 必须匹配 ^[a-z0-9][a-z0-9-]{0,63}$，且路径不得越出该 agent 的 skills 目录"
      : null,
  });
};

/**
 * The agent must exist and belong to this room, or its dir is not this room's to
 * manage. A discriminated union so a handler cannot keep going after a refusal
 * has already been written to the reply.
 */
type AgentLookup = { ok: true; agent: RoomAgent } | { ok: false; reply: FastifyReply };

const resolveAgent = (
  store: RoomStore,
  roomId: string,
  agentId: string,
  reply: FastifyReply,
): AgentLookup => {
  if (!store.getRoom(roomId)) {
    return { ok: false, reply: reply.code(404).send({ error: "room not found", code: "ROOM_NOT_FOUND" }) };
  }
  const agent = store.getAgent(agentId);
  if (!agent || agent.roomId !== roomId) {
    return {
      ok: false,
      reply: reply.code(404).send({ error: "agent not found in this room", code: "AGENT_NOT_FOUND" }),
    };
  }
  if (agent.agentDir.trim() === "") {
    return {
      ok: false,
      reply: reply.code(409).send({
        error: `agent「${agent.name}」没有 agentDir，技能无处落地`,
        code: "AGENT_DIR_MISSING",
        detail: null,
      }),
    };
  }
  return { ok: true, agent };
};

export async function registerSkillRoutes(
  app: FastifyInstance,
  options: SkillRouteOptions,
): Promise<void> {
  const { store } = options;

  await app.register(async (scope) => {
    // AC8.1 — the listing. Read-only; it never creates the skills root.
    scope.get<{ Params: { id: string; agentId: string } }>(
      "/api/rooms/:id/agents/:agentId/skills",
      async (request, reply) => {
        const found = resolveAgent(store, request.params.id, request.params.agentId, reply);
        if (!found.ok) return found.reply;
        const listing = listAgentSkills(found.agent.agentDir);
        return {
          agentId: found.agent.id,
          agentName: found.agent.name,
          // Exactly what the run gets: the loadable dirs. `PiAdapter` derives the
          // same list from the same persona dir when it builds `--skill` args, so
          // this field is what an operator can compare a live command line against.
          injectedPaths: listing.skills.filter((s) => s.loadable).map((s) => s.path),
          ...listing,
        };
      },
    );

    // AC8.3 — install. `skillDirOf()` inside `installSkill()` is the traversal gate.
    scope.post<{ Params: { id: string; agentId: string }; Body: InstallBody | undefined }>(
      "/api/rooms/:id/agents/:agentId/skills",
      { bodyLimit: MAX_BODY_BYTES },
      async (request, reply) => {
        const found = resolveAgent(store, request.params.id, request.params.agentId, reply);
        if (!found.ok) return found.reply;

        const body = request.body ?? {};
        let slug: string;
        try {
          slug = assertSkillSlug(body.slug);
        } catch (err) {
          if (err instanceof SkillError) return skillError(reply, err);
          throw err;
        }
        if (!Array.isArray(body.files) || body.files.length === 0) {
          return reply.code(400).send({
            error: "需要 files：[{ path, content }]，至少包含 SKILL.md",
            code: "SKILL_FILE_INVALID",
            detail: null,
          });
        }
        if (body.files.length > MAX_FILES) {
          return reply.code(400).send({
            error: `一个技能最多 ${MAX_FILES} 个文件`,
            code: "SKILL_FILE_INVALID",
            detail: String(body.files.length),
          });
        }
        const files: Array<{ path: string; content: string }> = [];
        for (const raw of body.files as InstallFileBody[]) {
          if (typeof raw?.path !== "string" || typeof raw?.content !== "string") {
            return reply.code(400).send({
              error: "files 的每一项都必须是 { path: string, content: string }（仅支持文本文件）",
              code: "SKILL_FILE_INVALID",
              detail: null,
            });
          }
          if (Buffer.byteLength(raw.content, "utf8") > MAX_FILE_BYTES) {
            return reply.code(400).send({
              error: `技能文件超过 ${MAX_FILE_BYTES} 字节上限：${raw.path}`,
              code: "SKILL_FILE_INVALID",
              detail: raw.path,
            });
          }
          files.push({ path: raw.path, content: raw.content });
        }

        try {
          const installed = installSkill({
            agentDir: found.agent.agentDir,
            slug,
            files,
            overwrite: body.overwrite === true,
          });
          return reply.code(installed.replaced ? 200 : 201).send({
            ...installed,
            // The same verdict the GET would give, so a caller learns immediately
            // when what it installed cannot load.
            listing: listAgentSkills(found.agent.agentDir).skills.find((s) => s.slug === slug) ?? null,
          });
        } catch (err) {
          if (err instanceof SkillError) return skillError(reply, err);
          const message = err instanceof Error ? err.message : String(err);
          request.log.error({ err }, "skill install failed");
          return reply.code(500).send({ error: `安装失败：${message}`, code: "INTERNAL" });
        }
      },
    );

    // AC8.3 — uninstall. The slug arrives as a path parameter, so it is validated
    // by the whitelist before `skillDirOf()` resolves it into a filesystem path.
    scope.delete<{ Params: { id: string; agentId: string; slug: string } }>(
      "/api/rooms/:id/agents/:agentId/skills/:slug",
      async (request, reply) => {
        const found = resolveAgent(store, request.params.id, request.params.agentId, reply);
        if (!found.ok) return found.reply;
        try {
          const removed = uninstallSkill({
            agentDir: found.agent.agentDir,
            slug: request.params.slug,
          });
          return reply.send({ removed: removed.removed, slug: request.params.slug });
        } catch (err) {
          if (err instanceof SkillError) return skillError(reply, err);
          const message = err instanceof Error ? err.message : String(err);
          request.log.error({ err }, "skill uninstall failed");
          return reply.code(500).send({ error: `卸载失败：${message}`, code: "INTERNAL" });
        }
      },
    );
  });
}
