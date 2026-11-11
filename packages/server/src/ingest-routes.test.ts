/**
 * P9a acceptance — the HTTP surface: AC2.4 (200, never 409), AC5.3 (token),
 * D6/A (off unless enabled), AC1.3/AC5.2 refusal codes, and the D1/B round-trip.
 *
 * A real Fastify instance via `app.inject`, so the status codes and body parsing
 * are the shipped ones — AC2.4 is precisely a status-code contract, and asserting it
 * against a hand-built handler would prove nothing.
 *
 * `MTA_INGEST_ENABLED`/`MTA_INGEST_TOKEN` are read inside `buildApp` (via
 * `ingestConfig`), so each test sets the environment, builds, and restores it. That
 * is the same order the real `server.ts` sees.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ExecutionStore, RoomStore } from "@my-team-agents/orchestrator";
import { buildApp } from "./app.js";

const worker = {
  async runOnce() { return false; },
  recoverExpired() { return 0; },
  requestCancel(taskId: string) { return { affected: 0, attemptId: taskId }; },
};

const tempDir = mkdtempSync(join(tmpdir(), "ingest-routes-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

interface Harness {
  app: Awaited<ReturnType<typeof buildApp>>;
  store: ExecutionStore;
  rooms: RoomStore;
  close: () => Promise<void>;
}

let seq = 0;
async function build(env: { enabled?: boolean; token?: string; seedRoom?: boolean }): Promise<Harness> {
  const base = join(tempDir, `case-${seq++}`);
  mkdirSync(base, { recursive: true });
  const savedEnabled = process.env.MTA_INGEST_ENABLED;
  const savedToken = process.env.MTA_INGEST_TOKEN;
  if (env.enabled) process.env.MTA_INGEST_ENABLED = "1";
  else delete process.env.MTA_INGEST_ENABLED;
  if (env.token) process.env.MTA_INGEST_TOKEN = env.token;
  else delete process.env.MTA_INGEST_TOKEN;

  const store = new ExecutionStore(join(base, "exec.sqlite"));
  const rooms = new RoomStore(store.db);
  // AC1.3 needs a member that EXISTS. `memberExists` reads this room's roster, so the
  // room must be seeded before a rule can name one of its agents.
  if (env.seedRoom !== false) {
    // Create then add: `createRoomWithAgents` forwards `roomId` from the input, so
    // the room has to exist first (that is what the importer does at commit time).
    const room = rooms.createRoom({ projectId: "my-team-agents", name: "运维群" });
    rooms.addAgent({
      roomId: room.id, name: "值班", role: "值班", prompt: "看告警。",
      agentDir: join(base, "persona"),
    });
  }
  const app = await buildApp({
    store, worker, rooms,
    roomsRoot: join(base, ".rooms"),
    defaultProjectId: "my-team-agents",
  });
  const close = async () => {
    await app.close(); rooms.close(); store.close();
    if (savedEnabled === undefined) delete process.env.MTA_INGEST_ENABLED; else process.env.MTA_INGEST_ENABLED = savedEnabled;
    if (savedToken === undefined) delete process.env.MTA_INGEST_TOKEN; else process.env.MTA_INGEST_TOKEN = savedToken;
  };
  return { app, store, rooms, close };
}

const event = (over: Record<string, unknown> = {}) => ({ id: "e1", source: "s", type: "t", summary: "x", ...over });

const post = (h: Harness, payload: unknown, token?: string, url = "/api/ingest/events") =>
  h.app.inject({
    method: "POST", url,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    payload: payload as never,
  });

describe("P9a HTTP surface", () => {
  it("D6/A: OFF by default — a correct POST 404s and /api/health says why", async () => {
    const h = await build({});
    try {
      const health = (await h.app.inject({ method: "GET", url: "/api/health" })).json();
      expect(health.ingest).toEqual({ enabled: false, tokenRequired: false });
      expect((await post(h, event())).statusCode).toBe(404);
    } finally { await h.close(); }
  });

  it("AC5.3: with a token configured, no/incorrect token is 401; the right one is accepted", async () => {
    const h = await build({ enabled: true, token: "s3cret" });
    try {
      expect((await post(h, event())).statusCode).toBe(401);
      expect((await post(h, event(), "nope")).statusCode).toBe(401);
      const ok = await post(h, event(), "s3cret");
      expect(ok.statusCode).toBe(200);
      // No rule matches, but the event got in (G5).
      expect(ok.json().outcome).toBe("unmatched");
    } finally { await h.close(); }
  });

  it("AC2.4: a repeated delivery is 200 (never 409) and returns the original taskIds", async () => {
    const h = await build({ enabled: true });
    try {
      const agentId = h.rooms.listAgents(h.rooms.listRooms()[0]!.id)[0]!.id;
      const rule = await post(h, {
        name: "告警", ask: "看告警", lane: "alerts", when: { sources: ["s"] },
        to: { memberId: agentId, workspacePath: "/tmp/ws" },
      }, undefined, "/api/ingest/rules");
      expect(rule.statusCode).toBe(201);

      const first = await post(h, event());
      const second = await post(h, event());
      expect(first.json().outcome).toBe("dispatched");
      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
      expect(second.json().outcome).toBe("delivered");
      expect(second.json().taskIds).toEqual(first.json().taskIds);
    } finally { await h.close(); }
  });

  it("AC1.3: a rule naming an unknown member is refused 400 with UNKNOWN_MEMBER", async () => {
    const h = await build({ enabled: true });
    try {
      const res = await post(h, {
        name: "bad", ask: "x", lane: "L1", when: { sources: ["s"] },
        to: { memberId: "寇豆码", workspacePath: "/tmp/ws" },
      }, undefined, "/api/ingest/rules");
      expect(res.statusCode).toBe(400);
      expect(res.json().errors.map((e: { code: string }) => e.code)).toContain("UNKNOWN_MEMBER");
      // Nothing stored.
      const list = await h.app.inject({ method: "GET", url: "/api/ingest/rules" });
      expect(list.json().rules).toHaveLength(0);
    } finally { await h.close(); }
  });

  it("AC5.2: a rule naming a writable tool is refused on BOTH gates at once", async () => {
    const h = await build({ enabled: true });
    try {
      const agentId = h.rooms.listAgents(h.rooms.listRooms()[0]!.id)[0]!.id;
      const res = await post(h, {
        name: "bad", ask: "x", lane: "L1", when: { sources: ["s"] },
        to: { memberId: agentId, workspacePath: "/tmp/ws", tools: ["read", "bash"] },
      }, undefined, "/api/ingest/rules");
      expect(res.statusCode).toBe(400);
      // The member resolves here, so the ONLY refusal is the writable tool.
      expect(res.json().errors.map((e: { code: string }) => e.code)).toEqual(["WRITABLE_TOOLS_REFUSED"]);
    } finally { await h.close(); }
  });

  it("AC6.1: GET /events/:id resolves the event to its rule, its Tasks and their usage", async () => {
    const h = await build({ enabled: true });
    try {
      const agentId = h.rooms.listAgents(h.rooms.listRooms()[0]!.id)[0]!.id;
      await post(h, {
        name: "r", ask: "x", lane: "L1", when: { sources: ["s"] },
        to: { memberId: agentId, workspacePath: "/tmp/ws" },
      }, undefined, "/api/ingest/rules");
      await post(h, event({ link: "https://example.com/i/1" }));

      const detail = await h.app.inject({ method: "GET", url: "/api/ingest/events/e1" });
      expect(detail.statusCode).toBe(200);
      const body = detail.json();
      expect(body.event.link).toBe("https://example.com/i/1");
      expect(body.rules).toHaveLength(1);
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0]).toMatchObject({ totalTokens: 0, totalCost: 0 });

      const stats = (await h.app.inject({ method: "GET", url: "/api/ingest/stats" })).json();
      expect(stats.totals.events).toBe(1);
      expect(stats.events[0]).toMatchObject({ source: "s", type: "t" });

      expect((await h.app.inject({ method: "GET", url: "/api/ingest/events/nope" })).statusCode).toBe(404);
    } finally { await h.close(); }
  });

  it("D1/B: rules export/import round-trip; a bad rule in the import is refused BY NAME", async () => {
    const h = await build({ enabled: true });
    try {
      const agentId = h.rooms.listAgents(h.rooms.listRooms()[0]!.id)[0]!.id;
      await post(h, {
        name: "good", ask: "x", lane: "L1", when: { sources: ["s"] },
        to: { memberId: agentId, workspacePath: "/tmp/ws" },
      }, undefined, "/api/ingest/rules");

      const exported = (await h.app.inject({ method: "GET", url: "/api/ingest/rules/export" })).json();
      expect(exported.version).toBe(1);
      expect(exported.rules).toHaveLength(1);
      // No ids a human cannot re-type.
      expect(exported.rules[0]).not.toHaveProperty("id");
      expect(exported.rules[0].name).toBe("good");

      const imported = await post(h, {
        rules: [
          { name: "n", ask: "a", lane: "L", when: { sources: ["s"] }, to: { memberId: "nobody", workspacePath: "/w" } },
        ],
      }, undefined, "/api/ingest/rules/import");
      expect(imported.statusCode).toBe(400);
      expect(imported.json().created).toHaveLength(0);
      expect(imported.json().refused).toHaveLength(1);
      expect(imported.json().refused[0].errors[0].code).toBe("UNKNOWN_MEMBER");
    } finally { await h.close(); }
  });

  it("a body missing summary is a 400 and records nothing", async () => {
    const h = await build({ enabled: true });
    try {
      const res = await post(h, { source: "s", type: "t" });
      expect(res.statusCode).toBe(400);
      const events = await h.app.inject({ method: "GET", url: "/api/ingest/events" });
      expect(events.json().events).toHaveLength(0);
    } finally { await h.close(); }
  });
});
