import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { ExecutionStore, RoomStore } from "@my-team-agents/orchestrator";
import { buildApp } from "./app.js";

/**
 * I2's service seam: POST /api/rooms/import plus the read endpoints. These
 * tests also guard the requirement that /api/tasks and /api/pi keep behaving
 * exactly as before once the room routes are mounted.
 */

const worker = {
  async runOnce() { return false; },
  recoverExpired() { return 0; },
  requestCancel(taskId: string) { return { affected: 0, attemptId: taskId }; },
};

interface ImportResponse {
  room: { id: string; name: string; projectId: string; coordinatorAgentId: string | null; rules: string };
  agents: Array<{ id: string; name: string; role: string; isCoordinator: boolean; agentDir: string }>;
  coordinator: { source: string; agentName: string; rationale: string };
  roomRoot: string;
  agentDirs: string[];
  ignoredFields: Array<{ scope: string; field: string; agentName?: string; reason: string }>;
  warnings: Array<{ code: string }>;
  error?: string;
  code?: string;
  hint?: string;
}

interface PlanResponse extends Omit<ImportResponse, "room"> {
  dryRun: true;
  roomInput: { projectId: string; name: string };
}

/** A minimal but structurally faithful package: same files, same field names. */
const samplePackage = (): Buffer => {
  const persona = (slug: string) =>
    `---\nname: ${slug}\ndescription: ${slug} role\ncolor: red\nemoji: 🎯\n---\n\n# ${slug}\nWork on it.`;
  const agent = (id: string, name: string) => ({
    id, name, prompt: persona(`role-${id}`), type: "builtin", acpTool: null,
    categoryId: "cat-1", workDir: null, proxyConfig: null, codexModel: null,
    codexFastMode: false, claudeModel: null, thinkingMode: "high", llmProviderId: null,
    speechConfig: { behavior: { enabled: true } }, capabilities: [],
  });
  const room = {
    id: "room-ref-1", name: "全栈软件研发", description: "研发团队",
    rules: "## 团队成员\n👑 齐活林（交付总监）\n• 高见远（架构师）\n",
    workDir: null, defaultAgentId: "a2", agentTriggerMode: "auto",
  };
  return Buffer.from(zipSync({
    "manifest.json": strToU8(JSON.stringify({
      schemaVersion: "1.0", templateId: "tpl-room-ref-1", version: "1.0.0", title: "全栈软件研发",
      summary: null, source: { type: "local" },
      contents: { group: true, agents: 2, categories: 1, skills: 0, cronTasks: 0 },
    })),
    "snapshot.json": strToU8(JSON.stringify({
      room, agents: [agent("a1", "高见远"), agent("a2", "齐活林")],
      categories: [{ id: "cat-1", name: "研发" }], cronTasks: [],
    })),
    "capability-descriptors.json": strToU8(JSON.stringify([
      { agentRef: "a1", capabilityType: "text", required: true, tool: null, modelType: "text" },
      { agentRef: "a2", capabilityType: "text", required: true, tool: null, modelType: "text" },
    ])),
    "skill-usages.json": strToU8("[]"),
    "degraded-skills.json": strToU8("[]"),
  }));
};

const tempDir = mkdtempSync(join(tmpdir(), "room-routes-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

const buildTestApp = async (name: string) => {
  const base = join(tempDir, name);
  mkdirSync(base, { recursive: true });
  // Rooms share the ExecutionStore database handle, mirroring server.ts.
  const store = new ExecutionStore(join(base, "exec.sqlite"));
  const rooms = new RoomStore(store.db);
  const app = await buildApp({
    store,
    worker,
    rooms,
    roomsRoot: join(base, ".rooms"),
    defaultProjectId: "my-team-agents",
  });
  const close = async () => { await app.close(); rooms.close(); store.close(); };
  return { app, store, rooms, base, close };
};

const importByPath = (app: Awaited<ReturnType<typeof buildTestApp>>["app"], path: string) =>
  app.inject({ method: "POST", url: "/api/rooms/import", payload: { path } });

describe("POST /api/rooms/import", () => {
  it("imports a package by path and exposes the room over GET", async () => {
    const h = await buildTestApp("by-path");
    const zipFile = join(h.base, "package.zip");
    writeFileSync(zipFile, samplePackage());

    const res = await importByPath(h.app, zipFile);
    expect(res.statusCode).toBe(201);
    const body = res.json() as ImportResponse;
    expect(body.room.name).toBe("全栈软件研发");
    expect(body.room.projectId).toBe("my-team-agents");
    expect(body.room.rules).toContain("## 团队成员");
    expect(body.agents).toHaveLength(2);
    expect(body.coordinator).toMatchObject({ source: "room.defaultAgentId", agentName: "齐活林" });
    const lead = body.agents.find((a) => a.isCoordinator);
    expect(lead?.name).toBe("齐活林");
    expect(body.room.coordinatorAgentId).toBe(lead?.id ?? null);
    for (const agent of body.agents) {
      expect(existsSync(join(agent.agentDir, "AGENTS.md"))).toBe(true);
    }
    // fields we do not migrate are named, not swallowed
    const reported = new Set(body.ignoredFields.map((f) => f.field));
    for (const field of ["speechConfig", "proxyConfig", "codexModel", "acpTool", "categories"]) {
      expect(reported.has(field), `${field} reported`).toBe(true);
    }

    const list = await h.app.inject({ method: "GET", url: "/api/rooms" });
    expect(list.statusCode).toBe(200);
    expect((list.json() as Array<{ id: string }>).map((r) => r.id)).toContain(body.room.id);

    const agents = await h.app.inject({ method: "GET", url: `/api/rooms/${body.room.id}/agents` });
    const rows = agents.json() as Array<{ name: string; isCoordinator: boolean; agentDir: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.isCoordinator)).toHaveLength(1);
    expect(existsSync(rows.find((r) => r.isCoordinator)?.agentDir ?? "")).toBe(true);

    const messages = await h.app.inject({ method: "GET", url: `/api/rooms/${body.room.id}/messages` });
    expect(messages.statusCode).toBe(200);
    expect(messages.json()).toEqual([]);

    // audit report landed next to the persona dirs
    const report = JSON.parse(readFileSync(join(body.roomRoot, "import-report.json"), "utf8")) as {
      room: { id: string };
    };
    expect(report.room.id).toBe(body.room.id);
    await h.close();
  });

  it("accepts a raw zip upload (what a browser sends with fetch(body: file))", async () => {
    const h = await buildTestApp("upload");
    const res = await h.app.inject({
      method: "POST",
      url: "/api/rooms/import",
      headers: { "content-type": "application/zip" },
      payload: samplePackage(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as ImportResponse;
    expect(body.agents).toHaveLength(2);
    expect(h.rooms.listRooms()).toHaveLength(1);
    await h.close();
  });

  it("dryRun reports the plan without creating a room", async () => {
    const h = await buildTestApp("dry-run");
    const res = await h.app.inject({
      method: "POST", url: "/api/rooms/import",
      payload: { path: join(h.base, "never.zip"), dryRun: true },
    });
    expect(res.statusCode).toBe(404); // path does not exist
    expect(res.json().code).toBe("ZIP_UNREADABLE");

    const zipFile = join(h.base, "package.zip");
    writeFileSync(zipFile, samplePackage());
    const dry = await h.app.inject({
      method: "POST", url: "/api/rooms/import", payload: { path: zipFile, dryRun: true },
    });
    expect(dry.statusCode).toBe(200);
    const plan = dry.json() as PlanResponse;
    expect(plan.dryRun).toBe(true);
    expect(plan.roomInput.name).toBe("全栈软件研发");
    expect(plan.coordinator.agentName).toBe("齐活林");
    expect(plan.agents).toHaveLength(2);
    expect(h.rooms.listRooms()).toHaveLength(0); // nothing committed
    expect(existsSync(plan.roomRoot)).toBe(false); // nothing written
    await h.close();
  });

  it("answers 4xx with a code and leaves the store untouched", async () => {
    const h = await buildTestApp("failures");

    const noBody = await h.app.inject({ method: "POST", url: "/api/rooms/import", payload: {} });
    expect(noBody.statusCode).toBe(400);
    expect(noBody.json().code).toBe("PACKAGE_REQUIRED");

    const notZip = await h.app.inject({
      method: "POST", url: "/api/rooms/import",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("this is not a zip archive at all"),
    });
    expect(notZip.statusCode).toBe(400);
    expect(notZip.json().code).toBe("ZIP_INVALID");

    const wrongExt = await h.app.inject({
      method: "POST", url: "/api/rooms/import", payload: { path: join(h.base, "package.tar") },
    });
    expect(wrongExt.statusCode).toBe(400);
    expect(wrongExt.json().code).toBe("PACKAGE_NOT_ZIP");

    const missingPath = await h.app.inject({
      method: "POST", url: "/api/rooms/import", payload: { path: join(h.base, "absent.zip") },
    });
    expect(missingPath.statusCode).toBe(404);
    expect(missingPath.json().code).toBe("ZIP_UNREADABLE");

    const snapshotOnly = await h.app.inject({
      method: "POST", url: "/api/rooms/import",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(zipSync({ "snapshot.json": strToU8("{}") })),
    });
    expect(snapshotOnly.statusCode).toBe(400);
    expect(snapshotOnly.json().code).toBe("FILE_MISSING");
    expect(String(snapshotOnly.json().hint)).toContain("回滚");

    const badSchema = await h.app.inject({
      method: "POST", url: "/api/rooms/import",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(zipSync({
        "manifest.json": strToU8(JSON.stringify({ schemaVersion: "9.9" })),
        "snapshot.json": strToU8("{}"),
      })),
    });
    expect(badSchema.statusCode).toBe(400);
    expect(badSchema.json().code).toBe("SCHEMA_MISMATCH");

    // no half-imported room is observable anywhere
    expect(h.rooms.listRooms()).toHaveLength(0);
    expect((await h.app.inject({ method: "GET", url: "/api/rooms" })).json()).toEqual([]);
    await h.close();
  });
});

describe("GET /api/rooms/:id/... unknown room", () => {
  it("404s agents and messages", async () => {
    const h = await buildTestApp("unknown");
    const agents = await h.app.inject({ method: "GET", url: "/api/rooms/nope/agents" });
    expect(agents.statusCode).toBe(404);
    expect(agents.json().code).toBe("ROOM_NOT_FOUND");
    const messages = await h.app.inject({ method: "GET", url: "/api/rooms/nope/messages" });
    expect(messages.statusCode).toBe(404);
    await h.close();
  });
});

describe("room routes do not disturb existing APIs", () => {
  it("keeps /api/tasks and /api/pi working with normal JSON bodies", async () => {
    const h = await buildTestApp("regression");
    const task = await h.app.inject({
      method: "POST", url: "/api/tasks",
      payload: {
        tenantId: "default", projectId: "p", memberId: "mock-agent",
        workspacePath: "/tmp", prompt: "still works", idempotencyKey: "i2-regression",
      },
    });
    expect(task.statusCode).toBe(201);
    expect((task.json() as { prompt: string }).prompt).toBe("still works");

    // unsupported content type is still rejected the stock way
    const rawJson = await h.app.inject({
      method: "POST", url: "/api/tasks",
      headers: { "content-type": "application/xml" }, payload: "<x/>",
    });
    expect(rawJson.statusCode).toBe(415);

    const threads = await h.app.inject({ method: "GET", url: "/api/pi/threads" });
    expect(threads.statusCode).toBe(200);
    expect(Array.isArray(threads.json())).toBe(true);
    const invalid = await h.app.inject({ method: "POST", url: "/api/tasks", payload: {} });
    expect(invalid.statusCode).toBe(400);
    await h.close();
  });
});
