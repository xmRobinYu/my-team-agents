import { describe, expect, it } from "vitest";
import { ExecutionStore } from "@my-team-agents/orchestrator";
import { buildApp } from "./app.js";

const worker = {
  async runOnce() { return false; },
  recoverExpired() { return 0; },
  requestCancel(taskId: string) { return { affected: 1, attemptId: taskId };
  },
};
const body = {
  tenantId: "default", projectId: "p", memberId: "mock-agent",
  workspacePath: "/tmp", prompt: "build a workbench", idempotencyKey: "request-1",
};

describe("local task API", () => {
  it("supports catalog, idempotent task creation and task details", async () => {
    const store = new ExecutionStore();
    const app = await buildApp({ store, worker });
    const catalog = await app.inject({ method: "GET", url: "/api/catalog" });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().projects[0].workspacePath).toBeTruthy();

    const first = await app.inject({ method: "POST", url: "/api/tasks", payload: body });
    const second = await app.inject({ method: "POST", url: "/api/tasks", payload: body });
    expect(first.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);
    expect(store.listTasks()).toHaveLength(1);

    const detail = await app.inject({ method: "GET", url: `/api/tasks/${first.json().id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().attempts).toEqual([]);
    expect(detail.json().chainTasks).toHaveLength(1);
    await app.close();
  });

  it("rejects invalid tasks and unknown IDs", async () => {
    const app = await buildApp({ store: new ExecutionStore(), worker });
    expect((await app.inject({ method: "POST", url: "/api/tasks", payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/tasks/missing" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/tasks/missing/cancel" })).statusCode).toBe(404);
    await app.close();
  });

  it("serves an SSE task snapshot", async () => {
    const store = new ExecutionStore();
    const app = await buildApp({ store, worker });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (typeof address === "object" && address) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/events`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("event: tasks");
      await reader.cancel();
    }
    await app.close();
  });
});
