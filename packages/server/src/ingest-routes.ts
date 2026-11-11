/**
 * `/api/ingest` route layer — P9a's first inbound surface.
 *
 *   POST /api/ingest/events            one external event -> Tasks (AC1.1)
 *   GET  /api/ingest/events            recent events
 *   GET  /api/ingest/events/:id        event + matched rules + Tasks + usage (AC6.1)
 *   GET  /api/ingest/stats             per source/type outcome + token/cost (AC6.3)
 *   POST /api/ingest/rules             register a rule (validated: AC1.3, AC5.2)
 *   GET  /api/ingest/rules             list rules
 *   GET  /api/ingest/rules/export      rules as `rules.json` (D1/B)
 *   POST /api/ingest/rules/import      import `rules.json` (D1/B)
 *
 * Two mechanisms guard the door, and BOTH default to closed:
 *   - D6/A: the whole surface is OFF unless `MTA_INGEST_ENABLED=1`. A new inbound
 *     endpoint is the first place external bytes enter this chain, so it is opt-in,
 *     matching AIHOT's own safety-valve posture.
 *   - AC5.3: when `MTA_INGEST_TOKEN` is set, every request must carry
 *     `authorization: Bearer <token>`. A missing/incorrect token is 401. The token
 *     is read from the environment and NEVER stored on an event row or logged.
 *
 * What this is NOT: authentication. The listener is loopback-only (server.ts) and
 * a static token is a stopgap. Any public exposure still needs P7b — the PRD says
 * so, and nothing here changes that.
 *
 * Response shape: the caller is an AIHOT-style producer that only accepts HTTP 200
 * (PRD §4.1), so a delivery — new OR repeated — is 200. 4xx is reserved for a body
 * this platform cannot normalize at all (AC2.4).
 */

import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ExecutionStore, IngestService, IngestStore } from "@my-team-agents/orchestrator";

export interface IngestRouteOptions {
  executions: ExecutionStore;
  ingest: IngestStore;
  service: IngestService;
  /** Project an event is attributed to when the caller/rule does not name one. */
  defaultProjectId: string;
  defaultTenantId: string;
  /** AC5.3: static bearer token. Absent means the caller opted into anonymous. */
  token?: string;
  /** The routes are registered only when this is true (`open`, not `enabled`). */
  enabled: boolean;
}

/**
 * The largest body this surface will read. The event itself is bounded by
 * `normalizeEvent` (summary 200, detail 4000), but that truncation runs AFTER
 * Fastify has already parsed and buffered the whole payload — so without a limit
 * here, "truncate the detail" is not a bound on the bytes an unauthenticated-ish
 * caller can push through. 64 KiB is ~16x the largest legitimate event.
 */
const INGEST_BODY_LIMIT = 64 * 1024;

const unauthorized = (reply: FastifyReply) =>
  reply.code(401).send({ error: "unauthorized", hint: "设置 authorization: Bearer <MTA_INGEST_TOKEN>" });

/**
 * Constant-time bearer check.
 *
 * `a !== b` on strings returns on the first differing byte, so response timing
 * leaks the shared prefix length — enough to recover a token byte by byte over many
 * requests. `timingSafeEqual` needs equal-length buffers, so a length mismatch is
 * folded into a comparison against itself: same work, constant answer.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    try { timingSafeEqual(b, b); } catch { /* lengths already equal */ }
    return false;
  }
  return timingSafeEqual(a, b);
}

export function ingestGuard(options: Pick<IngestRouteOptions, "token">) {
  const token = options.token;
  return (request: FastifyRequest, reply: FastifyReply): boolean => {
    // No token means the operator set MTA_INGEST_ALLOW_ANON=1; `ingestConfig` is the
    // only thing allowed to decide that, and it has already refused to open the
    // surface otherwise. This function must not invent a third answer.
    if (!token) return true;
    const header = request.headers.authorization;
    if (typeof header !== "string") return (unauthorized(reply), false);
    const match = /^Bearer\s+(.+)$/.exec(header.trim());
    if (!match) return (unauthorized(reply), false);
    if (!tokenMatches(match[1]!.trim(), token)) return (unauthorized(reply), false);
    return true;
  };
}

export async function registerIngestRoutes(
  app: FastifyInstance,
  options: IngestRouteOptions,
): Promise<void> {
  const { executions, ingest, service } = options;
  if (!options.enabled) {
    // D6/A: off by default. The health payload says so, so an operator is not left
    // guessing why a correct-looking POST 404s.
    return;
  }
  const authorized = ingestGuard(options);

  // `bodyLimit` is a ROUTE option in Fastify (a plugin-registration option is
  // ignored), set only on the one route that accepts a body. This is what makes the
  // truncation in `normalizeEvent` a bound on BYTES rather than only on the stored
  // string: truncation runs after Fastify has already buffered the payload.
  await app.register(async (scope) => {
    scope.post("/api/ingest/events", { bodyLimit: INGEST_BODY_LIMIT }, async (request, reply) => {
      if (!authorized(request, reply)) return reply;
      const scopeIn = {
        tenantId: options.defaultTenantId,
        projectId: options.defaultProjectId,
      };
      const result = service.submit(request.body ?? {}, scopeIn);
      // AC2.4: 200 for a delivery (new or repeated), 400 only for a body we cannot
      // read at all. Never 409 — the producer treats it as "not delivered" and
      // retries forever.
      if (result.status === 400) {
        return reply.code(400).send({ error: result.errors?.[0]?.message ?? "invalid event", errors: result.errors });
      }
      return reply.code(200).send({
        outcome: result.outcome,
        event: result.event,
        taskIds: result.taskIds,
        ruleIds: result.ruleIds,
        ...(result.coalescedInto ? { coalescedInto: result.coalescedInto } : {}),
      });
    });

    scope.get("/api/ingest/events", async (request, reply) => {
      if (!authorized(request, reply)) return reply;
      return { events: ingest.listEvents() };
    });

    scope.get<{ Params: { id: string } }>("/api/ingest/events/:id", async (request, reply) => {
      if (!authorized(request, reply)) return reply;
      const record = ingest.getEvent(request.params.id);
      if (!record) return reply.code(404).send({ error: "event not found" });
      // AC6.1: the event, the rules that matched, the Tasks it produced and each
      // Task's usage total — the whole chain from one alert to what it cost.
      const rules = record.ruleIds
        .map((id) => ingest.getRule(id))
        .filter((rule): rule is NonNullable<typeof rule> => rule !== null);
      const tasks = record.taskIds
        .map((id) => executions.getTask(id))
        .filter((task): task is NonNullable<typeof task> => task !== null)
        .map((task) => {
          const usage = executions.getUsage(task.id);
          return {
            task,
            usage,
            totalTokens: usage.reduce((sum, u) => sum + u.totalTokens, 0),
            totalCost: usage.reduce((sum, u) => sum + u.totalCost, 0),
          };
        });
      return {
        event: record.event,
        scope: record.scope,
        outcome: record.outcome,
        rules,
        tasks,
        // AC2.3: the exact set of events folded into any of these Tasks.
        coalescedEventIds: tasks.flatMap((t) => ingest.coalescedEventIds(t.task.id)),
      };
    });

    scope.get("/api/ingest/stats", async (request, reply) => {
      if (!authorized(request, reply)) return reply;
      const bySource = ingest.eventStats();
      const usage = executions.getUsage();
      return {
        events: bySource,
        totals: {
          events: bySource.reduce((sum, s) => sum + s.total, 0),
          tasks: bySource.reduce((sum, s) => sum + (s.byOutcome["dispatched"] ?? 0), 0),
          totalTokens: usage.reduce((sum, u) => sum + u.totalTokens, 0),
          totalCost: usage.reduce((sum, u) => sum + u.totalCost, 0),
        },
      };
    });

    scope.post("/api/ingest/rules", async (request, reply) => {
      if (!authorized(request, reply)) return reply;
      const body = (request.body ?? {}) as Partial<Record<string, unknown>>;
      const result = service.registerRule({ ...body, name: body.name ?? "" }, {
        tenantId: options.defaultTenantId,
        projectId: options.defaultProjectId,
      });
      if (!result.ok) {
        // AC1.3/AC5.2: refused AT REGISTRATION. A bad rule is never stored to fail
        // silently later.
        return reply.code(400).send({ error: "rule rejected", errors: result.errors });
      }
      return reply.code(201).send({ rule: result.rule });
    });

    scope.get("/api/ingest/rules", async (request, reply) => {
      if (!authorized(request, reply)) return reply;
      return { rules: ingest.listRules() };
    });

    scope.get("/api/ingest/rules/export", async (request, reply) => {
      if (!authorized(request, reply)) return reply;
      // D1/B: the Git-auditable form. Deterministic order, no runtime ids.
      return { version: 1, rules: ingest.exportRules() };
    });

    scope.post("/api/ingest/rules/import", async (request, reply) => {
      if (!authorized(request, reply)) return reply;
      const body = (request.body ?? {}) as { rules?: unknown };
      if (!Array.isArray(body.rules)) {
        return reply.code(400).send({ error: "body must be { rules: [...] }" });
      }
      const created: unknown[] = [];
      const refused: unknown[] = [];
      for (const entry of body.rules) {
        const rule = (entry ?? {}) as Partial<Record<string, unknown>>;
        const result = service.registerRule({ ...rule, name: rule.name ?? "" }, {
          tenantId: options.defaultTenantId,
          projectId: options.defaultProjectId,
        });
        if (result.ok) created.push(result.rule);
        else refused.push({ rule: entry, errors: result.errors });
      }
      // AC4.3's sibling: an import that dropped a rule silently would be a rule that
      // exists in Git and not in the system. Refusals are returned, and the import is
      // NOT atomic on purpose — the good rules land and the bad ones are named.
      return reply.code(refused.length > 0 && created.length === 0 ? 400 : 200)
        .send({ created, refused });
    });
  });
}
