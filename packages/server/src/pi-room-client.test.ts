import { describe, expect, it } from "vitest";
import {
  createPiHttpClient,
  createPiThreadState,
  reducePiThreadState,
} from "@assistant-ui/react-pi";
import type { PiClientEvent, PiThreadState } from "@assistant-ui/react-pi";
import { buildHarness, deferred, gatedAdapter, seedRoom, waitFor } from "./pi-room-test-harness.js";
import { roomThreadId } from "./pi-thread-id.js";

/**
 * I7 proved against the ACTUAL client, not a stand-in.
 *
 * `createPiHttpClient` validates every response and every SSE frame and silently
 * DROPS anything malformed, so "the route returned 200" says nothing about the UI
 * receiving a transcript. These cases run the real `@assistant-ui/react-pi`
 * package over TCP against the real server: react-pi's own reducer accumulates
 * the state, and the assertions are about what that state ends up as.
 */

/**
 * Every client here disables the 30s idle-stream retain that
 * `createSharedStreamCache` applies after the last unsubscribe: with it left on,
 * a graceful `app.close()` would wait on a socket nobody is reading any more,
 * which is a test-harness artefact, not server behaviour.
 */
const clientAt = (origin: string) =>
  createPiHttpClient({ baseUrl: `${origin}/api/pi`, streamCloseDelayMs: 0 });

/** Replay a frame log through react-pi's reducer from a cold thread. */
const replay = (frames: readonly PiClientEvent[], threadId: string): PiThreadState =>
  frames.reduce<PiThreadState>((acc, event) => reducePiThreadState(acc, event), createPiThreadState(threadId));

describe("createPiHttpClient against the group projection", () => {
  it("reads a room thread with all three authors through the client's validators", async () => {
    const h = await buildHarness("read");
    const { room, arch } = seedRoom(h);
    h.rooms.appendMessage({ roomId: room.id, authorKind: "user", content: "@高见远 看下" }, 300);
    h.rooms.appendMessage({ roomId: room.id, authorKind: "agent", authorAgentId: arch.id, content: "看了", taskId: "task-1" }, 400);
    h.rooms.appendMessage({ roomId: room.id, authorKind: "system", content: "【流程守卫·循环】" }, 500);

    const client = clientAt(h.origin);
    const threadId = roomThreadId(room.id);
    const threads = await client.listThreads();
    expect(threads.map((t) => t.id)).toContain(threadId);
    expect(threads.find((t) => t.id === threadId)?.title).toBe("研发群");

    const snapshot = await client.getThread(threadId);
    // The count is the proof: a message whose `details`/`content` failed the
    // client's validators would have thrown here, not been trimmed.
    expect(snapshot.messages).toHaveLength(3);
    expect(snapshot.messages.map((m) => m.role)).toEqual(["user", "custom", "custom"]);
    expect(snapshot.messages[1]).toMatchObject({
      role: "custom", customType: "room-agent",
      details: { authorKind: "agent", name: "高见远", agentId: arch.id },
    });
    expect(snapshot.messages[2]).toMatchObject({
      customType: "room-system", details: { authorKind: "system" },
    });
    expect(snapshot.metadata.status).toBe("idle");
    await h.close();
  });

  it("a group send resolves for the composer and rejects only a malformed request", async () => {
    const h = await buildHarness("send");
    const { room, arch } = seedRoom(h);
    const client = clientAt(h.origin);
    const threadId = roomThreadId(room.id);
    // `sendMessage` resolves on any 2xx and THROWS on 4xx. A guard refusal must
    // therefore stay 2xx: the UI's composer would otherwise show an error for a
    // message that really was written.
    await expect(client.sendMessage(threadId, { content: `@${arch.name} 评审` })).resolves.toBeUndefined();
    expect(h.store.listTasks().filter((t) => t.groupId === room.id)).toHaveLength(1);
    await expect(client.sendMessage(threadId, { content: "无提及" })).rejects.toThrow(/400/);
    await h.close();
  });

  it("runs create → subscribe → send → settle and lands the UI out of running", async () => {
    const gate = deferred();
    const h = await buildHarness("stream", gatedAdapter(gate.promise, "这是群里的答复"));
    const { room, arch } = seedRoom(h);
    const threadId = roomThreadId(room.id);
    const client = clientAt(h.origin);

    let state = createPiThreadState(threadId);
    const frames: PiClientEvent[] = [];
    const stop = client.subscribe(threadId, (event) => {
      frames.push(event);
      state = reducePiThreadState(state, event);
    });
    try {
      await waitFor(() => state.loadState === "loaded");
      expect(state.metadata.id).toBe(threadId);
      expect(state.runStatus).toBe("idle");

      await client.sendMessage(threadId, { content: `@${arch.name} 给结论` });
      await waitFor(() => state.metadata.status === "running" || state.runStatus === "running");
      const round = h.store.listTasks().find((t) => t.groupId === room.id)!;
      expect(round.status).toBe("queued");

      const running = h.worker.runOnce();
      await waitFor(() => h.store.getTask(round.id)!.status === "running");
      gate.resolve();
      await running;

      // The settle must reach the client on its own — no refetch, no reload.
      await waitFor(() => state.runStatus === "idle" && state.metadata.status === "idle");
      const agentTurns = state.messages.filter(
        (m) => m.role === "custom" && m.customType === "room-agent",
      );
      expect(agentTurns).toHaveLength(1);
      expect(agentTurns[0]).toMatchObject({
        display: true,
        details: { authorKind: "agent", name: "高见远", agentId: arch.id },
      });
      expect(state.lastError).toBeUndefined();

      /**
       * Proof this is the anti-stuck mechanism and not a coincidence, in three
       * parts:
       *  1. truncating the log at the last `agent_start` — i.e. "the stream stopped
       *     while a round was in flight" — leaves react-pi `running` forever. The
       *     hazard is real and reachable, which is why the rest matters.
       *  2. the FULL log clears it, and does so through TWO independent
       *     mechanisms: the `agent_end`/`agent_settled` pair AND a terminal
       *     snapshot whose `metadata.status` is not running. Deleting either one
       *     alone still settles — asserted, so the redundancy cannot rot into a
       *     single point of failure.
       *  3. the sequence is strictly increasing: the reducer DROPS any frame at or
       *     below its watermark, so a repeated seq would silently lose a message.
       */
      const lastStart = frames.reduce((acc, f, i) => (f.type === "agent_start" ? i : acc), -1);
      expect(lastStart, "the round must have opened with agent_start").toBeGreaterThan(-1);
      expect(replay(frames.slice(0, lastStart + 1), threadId).runStatus).toBe("running");
      expect(replay(frames, threadId).runStatus).toBe("idle");

      const endFrames = frames.filter((f) => f.type === "agent_end");
      expect(endFrames).toHaveLength(1);
      expect(frames.filter((f) => f.type === "agent_settled")).toHaveLength(1);
      const terminalSnapshots = frames.filter(
        (f) => f.type === "snapshot" && f.snapshot.metadata.status !== "running",
      );
      expect(terminalSnapshots.length).toBeGreaterThan(0);
      // Drop the closing pair: the terminal snapshot still settles the client.
      expect(replay(frames.filter((f) => f.type !== "agent_end" && f.type !== "agent_settled"), threadId).runStatus)
        .toBe("idle");
      // Drop the terminal snapshots: the closing pair still settles it.
      expect(replay(frames.filter((f) => !(f.type === "snapshot" && f.snapshot.metadata.status !== "running")), threadId).runStatus)
        .toBe("idle");
      const seqs = frames.filter((f) => f.type !== "error").map((f) => f.seq);
      expect(seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]!)).toBe(true);
      expect(new Set(seqs).size).toBe(seqs.length);
      // The transcript the client holds matches the store's stream, in order.
      const projectedTexts = state.messages.map((m) =>
        m.role === "user" ? m.content : m.role === "custom"
          ? (m.content as Array<{ text?: string }>)[0]!.text : "");
      expect(projectedTexts).toEqual([`@${arch.name} 给结论`, "这是群里的答复"]);
    } finally {
      stop();
      await h.close();
    }
  }, 30_000);

  it("serves the rest of the PiClient contract for a room thread", async () => {
    const h = await buildHarness("contract-room");
    const { room } = seedRoom(h);
    const threadId = roomThreadId(room.id);
    const client = clientAt(h.origin);

    await client.renameThread(threadId, "改名群");
    await client.archiveThread(threadId);
    expect((await client.listThreads()).some((t) => t.id === threadId)).toBe(false);
    const archived = await client.listThreads({ includeArchived: true });
    expect(archived.find((t) => t.id === threadId)).toMatchObject({ archived: true, title: "改名群" });
    await client.unarchiveThread(threadId);
    expect((await client.listThreads()).some((t) => t.id === threadId)).toBe(true);

    // No steer/follow-up queue exists server-side, so the honest answer is empty.
    expect(await client.clearQueue(threadId)).toEqual({ steering: [], followUp: [] });
    await client.cancelRun(threadId); // an idle room: 200, no throw
    await client.setThinkingLevel(threadId, "high"); // accepted no-op
    await client.respondToHostUiRequest(threadId, { requestId: "r1", confirmed: true });
    expect(await client.getAvailableModels()).toBeInstanceOf(Array);
    // A room has no thread-level model: each persona carries its own (Q29/Q38).
    await expect(client.setModel(threadId, { provider: "p", modelId: "m" })).rejects.toThrow(/400/);

    await client.deleteThread(threadId);
    expect((await client.listThreads()).some((t) => t.id === threadId)).toBe(false);
    // Idempotent, per the contract's "also when it was already gone".
    await expect(client.deleteThread(threadId)).resolves.toBeUndefined();
    await h.close();
  });

  it("keeps the Task-thread contract intact and does not destroy P6 evidence", async () => {
    const h = await buildHarness("contract-task");
    const created = await h.app.inject({ method: "POST", url: "/api/pi/threads", payload: {} });
    const threadId = (created.json() as { metadata: { id: string } }).metadata.id;
    const client = clientAt(h.origin);

    await client.sendMessage(threadId, { content: "真实任务" });
    expect(h.store.getTask(threadId)!.prompt).toBe("真实任务");
    await client.renameThread(threadId, "重命名的会话");
    expect((await client.listThreads()).find((t) => t.id === threadId)?.title).toBe("重命名的会话");
    // A thread title is not a rewrite of the Task's prompt.
    expect(h.store.getTask(threadId)!.prompt).toBe("真实任务");
    expect(await client.clearQueue(threadId)).toEqual({ steering: [], followUp: [] });
    await client.setThinkingLevel(threadId, "low");
    await client.respondToHostUiRequest(threadId, { requestId: "r", dismissed: true });

    await client.deleteThread(threadId);
    expect((await client.listThreads()).some((t) => t.id === threadId)).toBe(false);
    // The Task row survives: deleting a projection must not delete the record.
    expect(h.store.getTask(threadId)).not.toBeNull();
    // The thread itself 404s: gone as a projection, while the row stays.
    await expect(client.getThread(threadId)).rejects.toThrow(/404/);
    await h.close();
  });

  it("never repeats a committed message across stream ticks", async () => {
    const h = await buildHarness("dedup");
    const { room, arch } = seedRoom(h);
    const threadId = roomThreadId(room.id);
    const client = clientAt(h.origin);
    h.rooms.appendMessage({ roomId: room.id, authorKind: "user", content: "第一条" }, Date.now());

    let state = createPiThreadState(threadId);
    const stop = client.subscribe(threadId, (event) => {
      state = reducePiThreadState(state, event);
    });
    try {
      await waitFor(() => state.loadState === "loaded");
      expect(state.messages).toHaveLength(1);
      h.rooms.appendMessage(
        { roomId: room.id, authorKind: "agent", authorAgentId: arch.id, content: "答复" },
        Date.now() + 1,
      );
      await waitFor(() => state.messages.length === 2);
      expect(state.messages[1]).toMatchObject({ role: "custom", customType: "room-agent" });
      // Several 1s ticks later it is still exactly two: dedup is by message id.
      // Several 1s ticks later it is still exactly two: dedup is by message id.
      await new Promise((r) => setTimeout(r, 2_400));
      expect(state.messages).toHaveLength(2);
    } finally {
      stop();
      await h.close();
    }
  }, 30_000);

  it("writes a thread-level model into the Task record and reports it", async () => {
    const h = await buildHarness("model");
    const task = h.store.createTask({
      tenantId: "default", projectId: "p", memberId: "m", workspacePath: "/ws", prompt: "x",
    }, Date.now());
    const client = clientAt(h.origin);
    await client.setModel(task.id, { provider: "anthropic", modelId: "claude-sonnet-4-5" });
    // It really changed the row the worker reads for `--model` — not a 204 theatre.
    expect(h.store.getTask(task.id)!.model).toBe("anthropic/claude-sonnet-4-5");
    await expect(client.setModel("task-nope", { provider: "a", modelId: "b" })).rejects.toThrow(/404/);

    const models = await client.getAvailableModels();
    expect(Array.isArray(models)).toBe(true);
    for (const model of models) {
      expect(model.provider.length).toBeGreaterThan(0);
      expect(model.modelId.length).toBeGreaterThan(0);
    }
    expect(models.some((m) => m.provider === "anthropic" && m.modelId === "claude-sonnet-4-5")).toBe(true);
    await h.close();
  });
});
