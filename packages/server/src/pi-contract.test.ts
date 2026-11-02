import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createPiHttpClient } from "@assistant-ui/react-pi";
import { attributeModel, mergeModels, piAgentDir, readModelCatalog } from "./pi-models.js";
import { PiThreadStore } from "./pi-thread-store.js";
import { buildHarness, deferred, gatedAdapter, messagesOf, seedRoom, waitFor } from "./pi-room-test-harness.js";

/**
 * The `PiClient` endpoints the P7a projection never served.
 *
 * `createPiHttpClient` calls all of them; unserved they 404, and the UI breaks
 * (e.g. `ThreadListItemPrimitive.Delete` → `deleteThread` → `DELETE /threads/:id`
 * was a guaranteed failure). Each route gets a case here, and the ones that
 * cannot do real work answer honestly instead of pretending — see the per-route
 * comments in `pi-routes.ts`.
 */

const tempDir = mkdtempSync(join(tmpdir(), "pi-contract-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

describe("model catalog (GET /api/pi/models)", () => {
  it("reads only the whitelisted fields and never echoes credentials", () => {
    const path = join(tempDir, "models.json");
    writeFileSync(path, JSON.stringify({
      providers: {
        "acme": {
          name: "Acme AI",
          baseUrl: "https://acme.test/v1",
          apiKey: "SECRET-DO-NOT-ECHO",
          headers: { Authorization: "Bearer SECRET" },
          models: [
            { id: "acme-large", name: "Acme Large", reasoning: true, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
            { id: "acme-small", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
            { name: "no id, skipped" },
          ],
        },
      },
    }));
    const catalog = readModelCatalog(path);
    expect(catalog).toEqual([
      { provider: "acme", modelId: "acme-large", name: "Acme Large", supportsThinking: true },
      { provider: "acme", modelId: "acme-small" },
    ]);
    // Belt and braces: nothing that looks like a secret survives the whitelist.
    expect(JSON.stringify(catalog)).not.toContain("SECRET");
  });

  it("degrades to an empty list rather than throwing", () => {
    expect(readModelCatalog(join(tempDir, "does-not-exist.json"))).toEqual([]);
    const bad = join(tempDir, "bad.json");
    writeFileSync(bad, "{ not json");
    expect(readModelCatalog(bad)).toEqual([]);
    const noProviders = join(tempDir, "empty.json");
    writeFileSync(noProviders, JSON.stringify({ providers: {} }));
    expect(readModelCatalog(noProviders)).toEqual([]);
  });

  it("follows Pi's own agent-dir resolution", () => {
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "/custom/agent" })).toBe("/custom/agent");
    expect(piAgentDir({})).toBe(join(homedir(), ".pi", "agent"));
  });

  it("refuses to invent a provider for an unqualified model name", () => {
    // A bare id with no catalog entry cannot be attributed; guessing would put a
    // selectable-but-nonexistent model in front of the user.
    expect(attributeModel("sonnet", [])).toBeNull();
    expect(attributeModel("anthropic/claude-x", [])).toEqual({ provider: "anthropic", modelId: "claude-x" });
    expect(attributeModel("", [])).toBeNull();
    expect(mergeModels([], ["a/b", null, undefined, "unqualified"]).length).toBe(1);
  });

  it("serves the route, and the client parses whatever it returns", async () => {
    const h = await buildHarness("models");
    const task = h.store.createTask({
      tenantId: "default", projectId: "p", memberId: "m", workspacePath: "/ws",
      prompt: "x", model: "openai/gpt-5-mini",
    }, Date.now());
    const res = await h.app.inject({ method: "GET", url: "/api/pi/models" });
    expect(res.statusCode).toBe(200);
    const models = res.json() as Array<{ provider: string; modelId: string }>;
    expect(models.some((m) => m.provider === "openai" && m.modelId === "gpt-5-mini")).toBe(true);
    for (const model of models) {
      expect(typeof model.provider).toBe("string");
      expect(model.provider.length).toBeGreaterThan(0);
    }
    expect(task.model).toBe("openai/gpt-5-mini");
    await h.close();
  });
});

describe("PATCH /threads/:id (rename)", () => {
  it("renames a Task thread without touching its prompt", async () => {
    const h = await buildHarness("rename-task");
    const task = h.store.createTask({
      tenantId: "default", projectId: "p", memberId: "m",
      workspacePath: "/ws", prompt: "原始任务描述",
    }, Date.now());
    const res = await h.app.inject({ method: "PATCH", url: `/api/pi/threads/${task.id}`, payload: { title: "新的会话名" } });
    expect(res.statusCode).toBe(204);
    expect(h.store.getTask(task.id)!.prompt).toBe("原始任务描述");
    const list = await h.app.inject({ method: "GET", url: "/api/pi/threads" });
    expect((list.json() as Array<{ id: string; title?: string }>).find((t) => t.id === task.id)?.title)
      .toBe("新的会话名");
    // A rename with no title is a bad request, not a silent no-op.
    expect((await h.app.inject({ method: "PATCH", url: `/api/pi/threads/${task.id}`, payload: { title: "  " } })).statusCode).toBe(400);
    expect((await h.app.inject({ method: "PATCH", url: "/api/pi/threads/task-nope", payload: { title: "x" } })).statusCode).toBe(404);
    await h.close();
  });
});

describe("DELETE /threads/:id", () => {
  it("keeps a Task thread with an in-flight Attempt from being destroyed", async () => {
    const h = await buildHarness("delete-inflight");
    const { room } = seedRoom(h);
    const task = h.store.createTask({
      tenantId: "default", projectId: "p", memberId: "m", workspacePath: "/ws",
      prompt: "跑着的东西", groupId: room.id,
    }, Date.now());
    const claim = h.store.claimNext("w", Date.now());
    expect(claim?.task.id).toBe(task.id);

    expect((await h.app.inject({ method: "DELETE", url: `/api/pi/threads/${task.id}` })).statusCode).toBe(204);
    // Cancelled, not deleted: no dangling running Attempt behind an invisible thread.
    expect(h.store.getTask(task.id)!.status).toBe("cancelling");
    expect(h.store.getAttempts(task.id).map((a) => a.status)).toContain("leased");
    // And the rows are all still there for /api/tasks and cost reporting.
    expect(h.store.getEvents(task.id)).toHaveLength(0); // never ran, so no events
    expect((await h.app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).statusCode).toBe(200);
    expect((await h.app.inject({ method: "GET", url: `/api/pi/threads/${task.id}` })).statusCode).toBe(404);
    // Idempotent, twice over.
    expect((await h.app.inject({ method: "DELETE", url: `/api/pi/threads/${task.id}` })).statusCode).toBe(204);
    expect((await h.app.inject({ method: "DELETE", url: `/api/pi/threads/${task.id}` })).statusCode).toBe(204);
    await h.close();
  });

  it("leaves a finished Task's evidence alone and never deletes room messages", async () => {
    const h = await buildHarness("delete-evidence");
    const { room, arch } = seedRoom(h);
    const posted = await h.app.inject({
      method: "POST", url: `/api/pi/threads/room:${room.id}/messages`,
      payload: { input: { content: `@${arch.name} 说话` } },
    });
    const queued = (posted.json() as { tasks: Array<{ id: string }> }).tasks[0]!;
    h.store.claimNext("w", Date.now());
    h.store.db.prepare("UPDATE tasks SET status='succeeded' WHERE id=?").run(queued.id);
    h.rooms.appendMessage({ roomId: room.id, authorKind: "agent", authorAgentId: arch.id, content: "答复", taskId: queued.id }, Date.now());
    const before = h.rooms.listMessages(room.id).length;

    expect((await h.app.inject({ method: "DELETE", url: "/api/pi/threads/room:" + room.id })).statusCode).toBe(204);
    expect(h.rooms.listMessages(room.id)).toHaveLength(before);
    expect(h.store.getTask(queued.id)!.status).toBe("succeeded");
    expect(h.rooms.getRoom(room.id)).not.toBeNull();
    await h.close();
  });
});

describe("queue/clear, thinking, host-ui: honest empty answers", () => {
  it("reports no queue for both thread kinds and 404s for neither", async () => {
    const h = await buildHarness("queue-clear");
    const { room } = seedRoom(h);
    const task = h.store.createTask({
      tenantId: "default", projectId: "p", memberId: "m", workspacePath: "/ws", prompt: "x",
    }, Date.now());
    for (const id of [task.id, `room:${room.id}`]) {
      const res = await h.app.inject({ method: "POST", url: `/api/pi/threads/${id}/queue/clear` });
      expect(res.statusCode).toBe(200);
      // P6 has no Pi steer/follow-up queue: empty is the truth, not a stub.
      expect(res.json()).toEqual({ steering: [], followUp: [] });
    }
    expect((await h.app.inject({ method: "POST", url: "/api/pi/threads/nope/queue/clear" })).statusCode).toBe(404);
    await h.close();
  });

  it("accepts a thinking level as a no-op without claiming it in metadata", async () => {
    const h = await buildHarness("thinking");
    const { room } = seedRoom(h);
    const task = h.store.createTask({
      tenantId: "default", projectId: "p", memberId: "m", workspacePath: "/ws", prompt: "x",
    }, Date.now());
    expect((await h.app.inject({ method: "POST", url: `/api/pi/threads/${task.id}/thinking`, payload: { level: "high" } })).statusCode).toBe(204);
    expect((await h.app.inject({ method: "POST", url: `/api/pi/threads/room:${room.id}/thinking`, payload: { level: "low" } })).statusCode).toBe(204);
    expect((await h.app.inject({ method: "POST", url: `/api/pi/threads/${task.id}/thinking`, payload: {} })).statusCode).toBe(400);
    expect((await h.app.inject({ method: "POST", url: "/api/pi/threads/task-nope/thinking", payload: { level: "low" } })).statusCode).toBe(404);
    // The honesty check: nothing echoes back as applied config.
    const snap = await h.app.inject({ method: "GET", url: `/api/pi/threads/${task.id}` });
    expect((snap.json() as { metadata: { config?: unknown } }).metadata.config).toBeUndefined();
    await h.close();
  });

  it("has no pending host-UI request to answer", async () => {
    const h = await buildHarness("host-ui");
    const task = h.store.createTask({
      tenantId: "default", projectId: "p", memberId: "m", workspacePath: "/ws", prompt: "x",
    }, Date.now());
    const res = await h.app.inject({
      method: "POST", url: `/api/pi/threads/${task.id}/host-ui`, payload: { response: { requestId: "r1", confirmed: true } },
    });
    expect(res.statusCode).toBe(204);
    expect(res.payload).toBe(""); // a 204 must not carry a body
    expect((await h.app.inject({ method: "POST", url: `/api/pi/threads/${task.id}/host-ui`, payload: {} })).statusCode).toBe(400);
    expect((await h.app.inject({ method: "POST", url: "/api/pi/threads/task-nope/host-ui", payload: { response: {} } })).statusCode).toBe(404);
    // And the snapshot advertises no pending requests, so the UI shows none.
    const snap = await h.app.inject({ method: "GET", url: `/api/pi/threads/${task.id}` });
    expect((snap.json() as { hostUiRequests?: unknown[] }).hostUiRequests).toBeUndefined();
    await h.close();
  });

  it("refuses a thread-level model on a room, and writes one on a Task", async () => {
    const h = await buildHarness("model-route");
    const { room, arch } = seedRoom(h);
    h.rooms.db.prepare("UPDATE room_agents SET model=? WHERE id=?").run("deepseek/v4", arch.id);
    const task = h.store.createTask({
      tenantId: "default", projectId: "p", memberId: "m", workspacePath: "/ws", prompt: "x",
    }, Date.now());
    const roomRes = await h.app.inject({
      method: "POST", url: `/api/pi/threads/room:${room.id}/model`, payload: { provider: "a", modelId: "b" },
    });
    expect(roomRes.statusCode).toBe(400);
    expect(roomRes.json().code).toBe("ROOM_MODEL_IS_PER_AGENT");
    const ok = await h.app.inject({
      method: "POST", url: `/api/pi/threads/${task.id}/model`, payload: { provider: "anthropic", modelId: "claude" },
    });
    expect(ok.statusCode).toBe(204);
    expect(h.store.getTask(task.id)!.model).toBe("anthropic/claude");
    // The room's per-persona model is what the catalog reports, not a thread one.
    const models = (await h.app.inject({ method: "GET", url: "/api/pi/models" })).json() as Array<{ modelId: string }>;
    expect(models.some((m) => m.modelId === "v4")).toBe(true);
    await h.close();
  });
});

describe("room seq watermark allocation", () => {
  it("claims strictly above what it has issued, and above a caller-provided floor", async () => {
    // `PiThreadStore.claimWatermark` is the only thing keeping a room stream's
    // seq monotonic, and the client silently DROPS any frame at or below its own
    // watermark (threadState.ts:224-231). Both halves of the rule are asserted:
    // the plain claim is strictly increasing, and the `seen` floor lifts the next
    // claim when a reconnecting client's local watermark ran ahead of ours.
    const h = await buildHarness("watermark");
    const { room } = seedRoom(h);
    const threads = new PiThreadStore(h.store.db);
    const first = threads.claimWatermark(room.id);
    const second = threads.claimWatermark(room.id);
    expect(second).toBe(first + 1);
    // A caller that has already seen 40 must not get 3 back.
    const jumped = threads.claimWatermark(room.id, 40);
    expect(jumped).toBe(41);
    expect(threads.watermark(room.id)).toBe(41);
    // And a read-only projection call never advances it (GET must not burn seqs).
    await h.app.inject({ method: "GET", url: `/api/pi/threads/room:${room.id}` });
    expect(threads.watermark(room.id)).toBe(41);
    await h.close();
  });
});

describe("single-agent thread: follow-ups refused honestly, never silently dropped", () => {
  /**
   * The bug this guards (found in review of the I7 delivery): the P7a messages
   * route mapped a follow-up on a finished Task thread to `retryTask` and
   * DISCARDED the message content, answering 204. react-pi resolves 2xx and keeps
   * its optimistic user message, but the transcript is rebuilt from the old
   * `task.prompt`, so the user's words appeared briefly and then vanished while
   * the worker re-ran the original prompt. The route now answers 4xx with
   * FOLLOW_UP_NOT_SUPPORTED, which makes the client THROW — a visible failure
   * instead of eaten input.
   */
  const finishedTaskThread = async (name: string, status: "succeeded" | "failed" | "cancelled" | "blocked") => {
    const h = await buildHarness(name);
    const task = h.store.createTask({
      tenantId: "default", projectId: "p", memberId: "m",
      workspacePath: "/ws", prompt: "第一句话",
    }, Date.now());
    h.store.claimNext("w", Date.now());
    h.store.db.prepare("UPDATE tasks SET status=?,batch_attempts=2 WHERE id=?").run(status, task.id);
    return { h, task: h.store.getTask(task.id)! };
  };

  for (const status of ["succeeded", "failed", "cancelled", "blocked"] as const) {
    it(`a ${status} Task thread answers 4xx + code and changes NOTHING about the Task`, async () => {
      const { h, task } = await finishedTaskThread(`followup-${status}`, status);
      const before = { prompt: task.prompt, batch: task.batch, attempts: h.store.getAttempts(task.id).length };

      const res = await h.app.inject({
        method: "POST", url: `/api/pi/threads/${task.id}/messages`,
        payload: { input: { content: "这是会被旧代码吞掉的一句追问" } },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json() as { code: string; error: string; taskStatus: string };
      expect(body.code).toBe("FOLLOW_UP_NOT_SUPPORTED");
      expect(body.error).toContain("不支持追问");
      expect(body.taskStatus).toBe(status);

      // Nothing moved: no prompt rewrite, no new batch, no new Attempt — the
      // "silent retry" this replaces would have bumped the batch.
      const after = h.store.getTask(task.id)!;
      expect(after.prompt).toBe(before.prompt);
      expect(after.batch).toBe(before.batch);
      expect(h.store.getAttempts(task.id).length).toBe(before.attempts);
      await h.close();
    });
  }

  it("the real client THROWS on the refusal, so the UI cannot render it as success", async () => {
    // "cancelled" specifically: the pre-fix code answered 204 for this status
    // (retryTask accepts it), so only here does the client's resolve-vs-throw
    // behaviour actually discriminate the fix from the bug.
    const { h, task } = await finishedTaskThread("followup-client", "cancelled");
    const client = createPiHttpClient({ baseUrl: `${h.origin}/api/pi`, streamCloseDelayMs: 0 });
    await expect(client.sendMessage(task.id, { content: "追问" })).rejects.toThrow(/409/);
    await expect(client.sendMessage(task.id, { content: "追问" })).rejects.toThrow(/FOLLOW_UP_NOT_SUPPORTED/);
    expect(h.store.getTask(task.id)!.batch).toBe(1);
    await h.close();
  });

  it("a queued placeholder still activates on its first message (204, prompt written)", async () => {
    const h = await buildHarness("placeholder-regression");
    const created = await h.app.inject({ method: "POST", url: "/api/pi/threads", payload: {} });
    const threadId = (created.json() as { metadata: { id: string } }).metadata.id;
    const sent = await h.app.inject({
      method: "POST", url: `/api/pi/threads/${threadId}/messages`,
      payload: { input: { content: "真实首条任务" } },
    });
    expect(sent.statusCode).toBe(204);
    expect(h.store.getTask(threadId)!.prompt).toBe("真实首条任务");
    expect(h.store.claimNext("w", Date.now())?.task.id).toBe(threadId);
    // And an empty message is refused with a code, never parked silently.
    const empty = await h.app.inject({
      method: "POST", url: `/api/pi/threads/${threadId}/messages`,
      payload: { input: { content: "  " } },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().code).toBe("CONTENT_REQUIRED");
    await h.close();
  });

  it("room threads keep accepting multiple turns (multi-turn lives on the group side)", async () => {
    const h = await buildHarness("room-multiturn");
    const { room, arch } = seedRoom(h);
    const threadId = `room:${room.id}`;
    const first = await h.app.inject({
      method: "POST", url: `/api/pi/threads/${threadId}/messages`,
      payload: { input: { content: `@${arch.name} 第一轮` } },
    });
    expect(first.statusCode).toBe(201);
    const second = await h.app.inject({
      method: "POST", url: `/api/pi/threads/${threadId}/messages`,
      payload: { input: { content: `@${arch.name} 第二轮` } },
    });
    expect(second.statusCode).toBe(201);
    expect((second.json() as { blocked: unknown[] }).blocked).toEqual([]);
    const snap = await h.app.inject({ method: "GET", url: `/api/pi/threads/${threadId}` });
    expect(messagesOf(snap.json()).map((m) => m.content)).toEqual([
      `@${arch.name} 第一轮`, `@${arch.name} 第二轮`,
    ]);
    await h.close();
  });
});

describe("Task-thread SSE is unchanged by the room work", () => {
  it("streams a single-agent run to a settled state, as P7a did", async () => {
    const gate = deferred();
    const h = await buildHarness("task-sse", gatedAdapter(gate.promise, "single agent answer"));
    const { room } = seedRoom(h);
    // A Task with no room: the P7a placeholder path, then a real prompt.
    const created = await h.app.inject({ method: "POST", url: "/api/pi/threads", payload: {} });
    const threadId = (created.json() as { metadata: { id: string } }).metadata.id;
    expect(room.id).toBeTruthy();
    await h.app.inject({
      method: "POST", url: `/api/pi/threads/${threadId}/messages`,
      payload: { input: { content: "干活" } },
    });

    const res = await fetch(`${h.origin}/api/pi/threads/${threadId}/events`);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const decode = async (): Promise<string[]> => {
      const { value } = await reader.read();
      return (value ? new TextDecoder().decode(value, { stream: true }) : "")
        .split("\n\n").filter((chunk) => chunk.startsWith("data: "))
        .map((chunk) => chunk.slice(6));
    };
    // Snapshot first, exactly as before.
    const first = JSON.parse((await decode())[0]!) as { threadId: string; type: string };
    expect(first).toMatchObject({ threadId, type: "snapshot" });

    const running = h.worker.runOnce();
    await waitFor(() => h.store.getTask(threadId)!.status === "running");
    gate.resolve();
    await running;

    const later: string[] = [];
    for (let i = 0; i < 40; i++) {
      for (const frame of await decode()) later.push(frame);
      if (later.some((f) => JSON.parse(f).type === "agent_settled")) break;
    }
    const events = later.map((f) => JSON.parse(f) as { type: string; seq: number });
    expect(events.some((e) => e.type === "message_end")).toBe(true);
    expect(events.filter((e) => e.type === "agent_settled")).toHaveLength(1);
    // The transcript is rebuilt from canonical events, unchanged by I7: the task
    // prompt as a user message, then the attempt's assistant reply.
    const snapshots = later.map((f) => JSON.parse(f)).filter((e) => e.type === "snapshot");
    const last = snapshots[snapshots.length - 1]!.snapshot as { messages: Array<{ role: string; content: unknown }> };
    expect(last.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(last.messages[0]!.content).toBe("干活");
    // seq stays monotonic on the Task side too (the room work shares no counter).
    const seqs = events.map((e) => e.seq);
    expect(seqs.every((s, i) => i === 0 || s > seqs[i - 1]!)).toBe(true);
    await reader.cancel();
    await h.close();
  }, 30_000);

  it("still 404s an unknown thread on every route, including the new ones", async () => {
    const h = await buildHarness("unknown");
    const paths: Array<[string, string, unknown?]> = [
      ["GET", "/api/pi/threads/task-nope"],
      ["POST", "/api/pi/threads/task-nope/messages", { input: { content: "x" } }],
      ["POST", "/api/pi/threads/task-nope/cancel"],
      ["PATCH", "/api/pi/threads/task-nope", { title: "x" }],
      ["POST", "/api/pi/threads/task-nope/queue/clear"],
      ["POST", "/api/pi/threads/task-nope/thinking", { level: "low" }],
      ["POST", "/api/pi/threads/task-nope/archive"],
      ["POST", "/api/pi/threads/task-nope/unarchive"],
      ["POST", "/api/pi/threads/task-nope/host-ui", { response: { requestId: "r", dismissed: true } }],
      ["POST", "/api/pi/threads/room:room-nope"],
      ["GET", "/api/pi/threads/room:room-nope"],
    ];
    for (const [method, path, payload] of paths) {
      const res = await h.app.inject({ method, url: path, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${path}`).toBe(404);
    }
    // DELETE is the one that must NOT 404 (contract idempotency).
    expect((await h.app.inject({ method: "DELETE", url: "/api/pi/threads/task-nope" })).statusCode).toBe(204);
    expect((await h.app.inject({ method: "DELETE", url: "/api/pi/threads/room:room-nope" })).statusCode).toBe(204);
    await h.close();
  });
});
