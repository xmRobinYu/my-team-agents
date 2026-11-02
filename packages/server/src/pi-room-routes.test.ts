import { describe, expect, it } from "vitest";
import { roomThreadId } from "./pi-thread-id.js";
import {
  buildHarness,
  deferred,
  gatedAdapter,
  messagesOf,
  metadataOf,
  seedRoom,
  tempDir,
  waitFor,
} from "./pi-room-test-harness.js";

/**
 * I7 at the route layer: a ChatRoom is one Pi thread, alongside the existing
 * single-agent Task threads, through the *same* `/api/pi` endpoints.
 *
 * What is asserted here is the server's own contract — which refusal maps to
 * which status, what actually lands in the database, which chain a cancel
 * touches. Whether react-pi accepts the payloads at all is asserted separately
 * against the real client in `pi-room-client.test.ts`.
 */

describe("group threads over /api/pi", () => {
  it("lists a room thread and tells it apart from a Task thread", async () => {
    const h = await buildHarness("list");
    const { room } = seedRoom(h);
    h.store.createTask({
      tenantId: "default", projectId: "my-team-agents", memberId: "pi-agent",
      workspacePath: "/ws", prompt: "单 agent 任务",
    }, 200);

    const list = await h.app.inject({ method: "GET", url: "/api/pi/threads" });
    expect(list.statusCode).toBe(200);
    const threads = list.json() as Array<{ id: string; title?: string; status: string }>;
    expect(threads).toHaveLength(2);
    const roomThread = threads.find((t) => t.id === roomThreadId(room.id));
    const taskThread = threads.find((t) => !t.id.startsWith("room:"));
    // Distinguishable by the id prefix alone: no out-of-contract metadata field.
    expect(roomThread).toMatchObject({ id: `room:${room.id}`, title: "研发群", status: "idle" });
    expect(taskThread!.id).toMatch(/^task-/);
    await h.close();
  });

  it("returns the whole stream in seq order with the right author on each line", async () => {
    const h = await buildHarness("snapshot");
    const { room, arch } = seedRoom(h);
    // Timestamps deliberately INVERT against seq, so a projection that ordered by
    // time would be caught rather than passing by luck.
    h.rooms.appendMessage({ roomId: room.id, authorKind: "user", content: "最早发的" }, 9_000);
    h.rooms.appendMessage({ roomId: room.id, authorKind: "agent", authorAgentId: arch.id, content: "架构答复", taskId: "task-x" }, 10);
    h.rooms.appendMessage({ roomId: room.id, authorKind: "system", content: "【流程守卫·循环】QA：本回合已发言" }, 20);

    const snap = await h.app.inject({ method: "GET", url: `/api/pi/threads/${roomThreadId(room.id)}` });
    expect(snap.statusCode).toBe(200);
    const messages = messagesOf(snap.json());
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.role)).toEqual(["user", "custom", "custom"]);
    // seq order (1,2,3), NOT timestamp order (10,20,9000).
    expect(messages.map((m) => m.timestamp)).toEqual([9_000, 10, 20]);
    expect(messages[0]!.content).toBe("最早发的");
    expect(messages[1]).toMatchObject({
      customType: "room-agent",
      details: { authorKind: "agent", name: "高见远", emoji: "🏗️", color: "#ff0000", seq: 2, taskId: "task-x" },
    });
    expect(messages[1]!.content).toEqual([{ type: "text", text: "架构答复" }]);
    expect(messages[2]).toMatchObject({
      customType: "room-system", details: { authorKind: "system", agentId: null, name: "系统" },
    });
    // Author identity is never smuggled into the text.
    expect(JSON.stringify(messages[1])).not.toContain("高见远：");
    expect(metadataOf(snap.json())).toMatchObject({ id: roomThreadId(room.id), messageCount: 3, status: "idle" });

    expect((await h.app.inject({ method: "GET", url: "/api/pi/threads/room:room-nope" })).statusCode).toBe(404);
    // A raw room id is NOT a thread id: routing is decided by the prefix alone.
    expect((await h.app.inject({ method: "GET", url: `/api/pi/threads/${room.id}` })).statusCode).toBe(404);
    await h.close();
  });

  it("POST /messages enforces the mention contract with 4xx and writes nothing", async () => {
    const h = await buildHarness("mentions-4xx");
    const { room } = seedRoom(h);
    const url = `/api/pi/threads/${roomThreadId(room.id)}/messages`;

    const noAt = await h.app.inject({ method: "POST", url, payload: { input: { content: "随便聊聊" } } });
    expect(noAt.statusCode).toBe(400);
    expect(noAt.json()).toMatchObject({ code: "NO_MENTION" });

    const unknown = await h.app.inject({ method: "POST", url, payload: { input: { content: "@不存在 看下" } } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ code: "UNKNOWN_MENTION", names: ["不存在"] });

    const empty = await h.app.inject({ method: "POST", url, payload: { input: { content: "   " } } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().code).toBe("CONTENT_REQUIRED");

    // A duplicate persona name is ambiguity, not a coin flip.
    h.rooms.addAgent({ roomId: room.id, name: "QA", prompt: "clone", agentDir: "/dup" }, 103);
    const ambiguous = await h.app.inject({ method: "POST", url, payload: { input: { content: "@QA 处理" } } });
    expect(ambiguous.statusCode).toBe(400);
    expect(ambiguous.json().code).toBe("AMBIGUOUS_MENTION");

    // 4xx means nothing at all happened — the same all-or-nothing rule as /api/rooms.
    expect(h.rooms.listMessages(room.id)).toEqual([]);
    expect(h.store.listTasks()).toEqual([]);

    const gone = await h.app.inject({
      method: "POST", url: "/api/pi/threads/room:nope/messages", payload: { input: { content: "@QA 处理" } },
    });
    expect(gone.statusCode).toBe(404);
    await h.close();
  });

  it("a valid @ queues one Task per target through the group trigger", async () => {
    const h = await buildHarness("mentions-ok");
    const { room, arch, qa } = seedRoom(h);
    const res = await h.app.inject({
      method: "POST", url: `/api/pi/threads/${roomThreadId(room.id)}/messages`,
      payload: { input: { content: "@高见远 定方案，@QA 复核" }, workspacePath: "/workspace/demo" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      message: { authorKind: string };
      tasks: Array<{ id: string; memberId: string }>;
      blocked: unknown[];
      snapshot: { metadata: { status: string; id: string } };
    };
    expect(body.message.authorKind).toBe("user");
    expect(body.tasks.map((t) => t.memberId)).toEqual([arch.id, qa.id]);
    expect(body.blocked).toEqual([]);
    const tasks = body.tasks.map((t) => h.store.getTask(t.id)!);
    // Identical to the /api/rooms trigger: persona dir, room serialisation key,
    // injected shared history. Sending through /api/pi cannot bypass I3/I4.
    expect(tasks.map((t) => t.agentDir)).toEqual(
      ["/persona/arch", "/persona/qa"].map((suffix) => `${tempDir}${suffix}`),
    );
    // The path is built with the platform separator by the harness; compare by
    // suffix so the assertion does not encode macOS-specific joining.
    expect(tasks.every((t) => t.agentDir!.startsWith(tempDir))).toBe(true);
    expect(tasks.every((t) => t.groupId === room.id)).toBe(true);
    expect(tasks[0]?.prompt).toContain("# 群聊记录");
    expect(body.snapshot.metadata.status).toBe("running");
    expect(body.snapshot.metadata.id).toBe(roomThreadId(room.id));
    await h.close();
  });

  it("a guard refusal answers 2xx with blocked and keeps both messages", async () => {
    const h = await buildHarness("blocked");
    const { room, arch } = seedRoom(h);
    h.rooms.addAgent({ roomId: room.id, name: "PM", prompt: "You plan.", agentDir: `${tempDir}/persona/pm` }, 103);
    h.rooms.db.prepare("UPDATE chat_rooms SET max_rounds=1 WHERE id=?").run(room.id);

    const res = await h.app.inject({
      method: "POST", url: `/api/pi/threads/${roomThreadId(room.id)}/messages`,
      payload: { input: { content: "@高见远 @QA 都看一下" } },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { tasks: Array<{ memberId: string }>; blocked: Array<{ code: string }> };
    expect(body.tasks.map((t) => t.memberId)).toEqual([arch.id]);
    expect(body.blocked).toHaveLength(1);
    expect(body.blocked[0]).toMatchObject({ code: "ROUND_CAP" });

    // 2xx means "written": the user message AND the guard's system message are both
    // in the thread, and the system one is distinguishable from any agent.
    const messages = messagesOf((await h.app.inject({
      method: "GET", url: `/api/pi/threads/${roomThreadId(room.id)}`,
    })).json());
    // The user turn stays a NATIVE `role: "user"` message (no `details`): that is
    // what lets react-pi reconcile the composer's optimistic copy.
    expect(messages.map((m) => (m.role === "user" ? "user" : m.details?.authorKind)))
      .toEqual(["user", "system", "system"]);
    expect(messages[1]!.customType).toBe("room-system");
    expect(JSON.stringify(messages[1]!.content)).toContain("轮次上限");
    await h.close();
  });

  it("cancel stops the chain whose Task is in flight, and never a finished one", async () => {
    const h = await buildHarness("cancel");
    const { room } = seedRoom(h);
    // A chain that already succeeded, older than the next one.
    const done = h.store.createTask({
      tenantId: "default", projectId: "my-team-agents", memberId: "a",
      workspacePath: "/ws", prompt: "done", groupId: room.id,
    }, Date.now() - 60_000);
    h.store.db.prepare("UPDATE tasks SET status='succeeded' WHERE id=?").run(done.id);

    const posted = await h.app.inject({
      method: "POST", url: `/api/pi/threads/${roomThreadId(room.id)}/messages`,
      payload: { input: { content: "@高见远 开工" } },
    });
    const queued = (posted.json() as { tasks: Array<{ id: string }> }).tasks[0]!;
    const claim = h.store.claimNext("w", Date.now());
    expect(claim?.task.id).toBe(queued.id);

    const cancel = await h.app.inject({
      method: "POST", url: `/api/pi/threads/${roomThreadId(room.id)}/cancel`,
    });
    expect(cancel.statusCode).toBe(200);
    const body = cancel.json() as { cancelled: boolean; chainId: string; affected: number };
    expect(body.cancelled).toBe(true);
    // Exactly the in-flight Task's chain — not every chain the room ever had.
    expect(body.chainId).toBe(h.store.getTask(queued.id)!.chainId);
    expect(body.chainId).not.toBe(done.chainId);
    expect(h.store.getTask(queued.id)!.status).toBe("cancelling");
    // The finished Task in the OTHER chain is untouched. (Not because a chain-wide
    // cancel would have flipped it — `requestCancelChain` excludes succeeded rows
    // — but because cancel must not reach outside the in-flight chain at all: the
    // next two cases pin that scope.)
    expect(h.store.getTask(done.id)!.status).toBe("succeeded");

    // Repeated cancel while the attempt is still winding down keeps asking the SAME
    // chain to stop: `cancelling` is still in-flight work, so a second call is not
    // a no-op — and it still must not touch the finished chain.
    const again = await h.app.inject({
      method: "POST", url: `/api/pi/threads/${roomThreadId(room.id)}/cancel`,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ cancelled: true, chainId: h.store.getTask(queued.id)!.chainId });
    expect(h.store.getTask(done.id)!.status).toBe("succeeded");

    // Once the attempt is drained there is nothing to cancel, and the route says
    // so instead of pretending it stopped something.
    h.store.db.prepare("UPDATE tasks SET status='cancelled',active_attempt_id=NULL WHERE id=?").run(queued.id);
    const idle = await h.app.inject({
      method: "POST", url: `/api/pi/threads/${roomThreadId(room.id)}/cancel`,
    });
    expect(idle.statusCode).toBe(200);
    expect(idle.json()).toMatchObject({ cancelled: false, affected: 0 });
    expect(metadataOf((await h.app.inject({
      method: "GET", url: `/api/pi/threads/${roomThreadId(room.id)}`,
    })).json()).status).toBe("idle");
    await h.close();
  });

  it("cancel touches ONLY the in-flight chain: another turn's queued Task survives and stays retryable", async () => {
    const h = await buildHarness("cancel-scope");
    const { room, arch } = seedRoom(h);
    const send = (content: string) => h.app.inject({
      method: "POST", url: `/api/pi/threads/${roomThreadId(room.id)}/messages`,
      payload: { input: { content } },
    });

    // Chain A: triggered and claimed, so a running Attempt owns the room.
    const a = (await send(`@${arch.name} 第一轮`)).json() as { tasks: Array<{ id: string }> };
    const taskA = h.store.getTask(a.tasks[0]!.id)!;
    h.store.claimNext("w", Date.now());
    expect(h.store.getTask(taskA.id)!.status).toBe("running");

    // Chain B: a SECOND user turn, so a separate chain whose Task is still queued
    // behind A (same-room serialisation, Q38). This is the work a room-wide cancel
    // would destroy.
    const b = (await send(`@${arch.name} 第二轮`)).json() as { tasks: Array<{ id: string }> };
    const taskB = h.store.getTask(b.tasks[0]!.id)!;
    expect(taskB.chainId).not.toBe(taskA.chainId);
    expect(taskB.status).toBe("queued");
    expect(h.store.getChain(taskB.chainId).cancelRequested).toBe(false);

    const cancel = await h.app.inject({
      method: "POST", url: `/api/pi/threads/${roomThreadId(room.id)}/cancel`,
    });
    expect((cancel.json() as { chainId: string }).chainId).toBe(taskA.chainId);

    // A: its running Attempt moves to cancelling, which is what cancel asked for.
    expect(h.store.getTask(taskA.id)!.status).toBe("cancelling");
    // B: still queued — untouched, so the round the user did NOT stop still runs.
    expect(h.store.getTask(taskB.id)!.status).toBe("queued");
    // ...and its chain is still cancellable/retryable: cancel_requested is sticky
    // (`requestCancelChain` sets it, nothing clears it) and `retryTask` refuses any
    // Task whose chain carries it, so a leaked flag here would permanently disable
    // an unrelated turn's work.
    expect(h.store.getChain(taskB.chainId).cancelRequested).toBe(false);

    // And the store really does exclude finished rows — the claim I removed from
    // the cancel() comment. A room-wide sweep would cancel B and lock its chain,
    // but it would NOT touch A's chain's finished work either; this asserts which
    // statuses `requestCancelChain` actually writes.
    const done = h.store.createTask({
      tenantId: "default", projectId: "p", memberId: arch.id, workspacePath: "/ws",
      prompt: "上一轮已完成", groupId: room.id,
    }, Date.now());
    h.store.db.prepare("UPDATE tasks SET status='succeeded' WHERE id=?").run(done.id);
    h.store.requestCancelChain(done.chainId, Date.now());
    expect(h.store.getTask(done.id)!.status).toBe("succeeded");
    await h.close();
  });

  it("delete, unlike cancel, does sweep every non-terminal chain — on purpose", async () => {
    const h = await buildHarness("delete-scope");
    const { room, arch } = seedRoom(h);
    const send = (content: string) => h.app.inject({
      method: "POST", url: `/api/pi/threads/${roomThreadId(room.id)}/messages`,
      payload: { input: { content } },
    });
    const a = (await send(`@${arch.name} 第一轮`)).json() as { tasks: Array<{ id: string }> };
    h.store.claimNext("w", Date.now());
    const b = (await send(`@${arch.name} 第二轮`)).json() as { tasks: Array<{ id: string }> };
    const taskB = h.store.getTask(b.tasks[0]!.id)!;
    expect(taskB.status).toBe("queued");

    expect((await h.app.inject({ method: "DELETE", url: `/api/pi/threads/room:${room.id}` })).statusCode).toBe(204);
    // Removing the thread abandons the backlog: both chains are now cancelled,
    // including B's queued Task. Documented in `remove()` — this is the expensive
    // half of deleting, and the reason cancel() refuses to do it.
    expect(h.store.getTask(taskB.id)!.status).toBe("cancelled");
    expect(h.store.getChain(taskB.chainId).cancelRequested).toBe(true);
    // Permanent: `retryTask` refuses any Task on a cancelled chain.
    expect(h.store.retryTask(taskB.id)).toBe(false);
    // Still no row deleted: the stream and the Task rows survive the sweep.
    expect(h.rooms.listMessages(room.id)).toHaveLength(2);
    expect(h.store.getTask(taskB.id)).not.toBeNull();
    await h.close();
  });

  it("a terminated room is idle and says so in the stream, not in thread status", async () => {
    const h = await buildHarness("terminated");
    const { room, arch } = seedRoom(h);
    const finished = h.store.createTask({
      tenantId: "default", projectId: "my-team-agents", memberId: arch.id,
      workspacePath: "/ws", prompt: "上一轮的收尾", groupId: room.id,
    }, 400);
    h.store.db.prepare("UPDATE tasks SET status='succeeded' WHERE id=?").run(finished.id);
    h.rooms.markTerminated(room.id, 500);
    h.rooms.appendMessage({ roomId: room.id, authorKind: "system", content: "【流程守卫·终止】协调者宣布讨论结束" }, 500);

    const snap = await h.app.inject({ method: "GET", url: `/api/pi/threads/${roomThreadId(room.id)}` });
    // `terminated` is flow state, not execution state: the thread is idle because
    // nothing is running, and the ending is visible where it belongs — as the
    // system message the guard itself wrote.
    expect(metadataOf(snap.json()).status).toBe("idle");
    expect(messagesOf(snap.json())[0]!.customType).toBe("room-system");

    // Guards still run through this surface, with I6's semantics intact: a user
    // message opens a NEW turn, so it resets `terminated` and is dispatched rather
    // than refused — a closed room must not be permanently frozen by its own last
    // ending. The next agent→agent handoff is what the flag actually blocks.
    const reopened = await h.app.inject({
      method: "POST", url: `/api/pi/threads/${roomThreadId(room.id)}/messages`,
      payload: { input: { content: "@高见远 继续" } },
    });
    expect(reopened.statusCode).toBe(201);
    expect((reopened.json() as { blocked: unknown[] }).blocked).toEqual([]);
    expect((reopened.json() as { tasks: unknown[] }).tasks).toHaveLength(1);
    expect(h.rooms.getState(room.id).terminated).toBe(false);
    // The thread reflects the reopened round instead of hiding it.
    expect(metadataOf((await h.app.inject({
      method: "GET", url: `/api/pi/threads/${roomThreadId(room.id)}`,
    })).json()).status).toBe("running");
    await h.close();
  });

  it("create with kind:room makes a room thread; a first message still needs @", async () => {
    const h = await buildHarness("create");
    const bad = await h.app.inject({
      method: "POST", url: "/api/pi/threads",
      payload: { kind: "room", title: "新群", initialMessage: { content: "没有提及" } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("NO_MENTION");
    // Refused means no room was created either.
    expect(h.rooms.listRooms()).toEqual([]);

    const created = await h.app.inject({ method: "POST", url: "/api/pi/threads", payload: { kind: "room", title: "新群" } });
    expect(created.statusCode).toBe(201);
    const threadId = (created.json() as { metadata: { id: string; status: string } }).metadata.id;
    expect(threadId.startsWith("room:")).toBe(true);
    expect((created.json() as { metadata: { status: string } }).metadata.status).toBe("idle");
    expect(h.rooms.listRooms()).toHaveLength(1);
    // An empty thread never enters the Task queue.
    expect(h.store.listTasks()).toEqual([]);
    expect(h.store.claimNext("w", Date.now())).toBeNull();

    const renamed = await h.app.inject({ method: "PATCH", url: `/api/pi/threads/${threadId}`, payload: { title: "改名后的群" } });
    expect(renamed.statusCode).toBe(204);
    const list = await h.app.inject({ method: "GET", url: "/api/pi/threads" });
    expect((list.json() as Array<{ id: string; title?: string }>).find((t) => t.id === threadId)?.title)
      .toBe("改名后的群");
    // Thread-local: the ChatRoom entity keeps its own name (P6 authority).
    expect(h.rooms.listRooms()[0]?.name).toBe("新群");
    await h.close();
  });

  it("delete tombstones the thread, cancels in-flight work and is idempotent", async () => {
    const h = await buildHarness("delete");
    const { room } = seedRoom(h);
    const posted = await h.app.inject({
      method: "POST", url: `/api/pi/threads/${roomThreadId(room.id)}/messages`,
      payload: { input: { content: "@高见远 开工" } },
    });
    const queued = (posted.json() as { tasks: Array<{ id: string }> }).tasks[0]!;
    h.store.claimNext("w", Date.now());

    const threadId = roomThreadId(room.id);
    expect((await h.app.inject({ method: "DELETE", url: `/api/pi/threads/${threadId}` })).statusCode).toBe(204);
    // In-flight work is stopped rather than left writing into an invisible thread.
    expect(h.store.getTask(queued.id)!.status).toBe("cancelling");
    // The evidence and the stream survive: a thread is a projection, not the record.
    expect(h.store.getTask(queued.id)).not.toBeNull();
    expect(h.rooms.getRoom(room.id)).not.toBeNull();
    expect(h.rooms.listMessages(room.id)).toHaveLength(1);
    // Gone as a thread.
    expect((await h.app.inject({ method: "GET", url: `/api/pi/threads/${threadId}` })).statusCode).toBe(404);
    const list = await h.app.inject({ method: "GET", url: "/api/pi/threads" });
    expect((list.json() as Array<{ id: string }>).some((t) => t.id === threadId)).toBe(false);
    // Idempotent: a second delete, and a never-existing one, both 204.
    expect((await h.app.inject({ method: "DELETE", url: `/api/pi/threads/${threadId}` })).statusCode).toBe(204);
    expect((await h.app.inject({ method: "DELETE", url: "/api/pi/threads/task-does-not-exist" })).statusCode).toBe(204);
    await h.close();
  });

  it("archive hides a room thread until includeArchived, and it still resolves", async () => {
    const h = await buildHarness("archive");
    const { room } = seedRoom(h);
    const threadId = roomThreadId(room.id);
    expect((await h.app.inject({ method: "POST", url: `/api/pi/threads/${threadId}/archive` })).statusCode).toBe(204);
    const hidden = await h.app.inject({ method: "GET", url: "/api/pi/threads" });
    expect(hidden.json() as unknown[]).toHaveLength(0);
    const withArchived = await h.app.inject({ method: "GET", url: "/api/pi/threads?includeArchived=true" });
    expect((withArchived.json() as Array<{ id: string; archived?: boolean }>)[0])
      .toMatchObject({ id: threadId, archived: true });
    // Still readable: archiving is a list filter, not a delete.
    expect((await h.app.inject({ method: "GET", url: `/api/pi/threads/${threadId}` })).statusCode).toBe(200);
    expect((await h.app.inject({ method: "POST", url: `/api/pi/threads/${threadId}/unarchive` })).statusCode).toBe(204);
    const back = await h.app.inject({ method: "GET", url: "/api/pi/threads" });
    expect(back.json() as unknown[]).toHaveLength(1);
    await h.close();
  });

  it("a round settles: the thread goes running → idle and gains the agent's message", async () => {
    const gate = deferred();
    const h = await buildHarness("settle", gatedAdapter(gate.promise, "方案已给出"));
    const { room, arch } = seedRoom(h);
    const posted = await h.app.inject({
      method: "POST", url: `/api/pi/threads/${roomThreadId(room.id)}/messages`,
      payload: { input: { content: "@高见远 给方案" } },
    });
    const queued = (posted.json() as { tasks: Array<{ id: string }> }).tasks[0]!;
    expect(metadataOf((await h.app.inject({
      method: "GET", url: `/api/pi/threads/${roomThreadId(room.id)}`,
    })).json()).status).toBe("running");

    const running = h.worker.runOnce();
    await waitFor(() => h.store.getTask(queued.id)!.status === "running");
    // While the attempt is in flight the draft is NOT in the transcript: an
    // agent's words enter the stream only with its committed reply (Q39).
    expect(messagesOf((await h.app.inject({
      method: "GET", url: `/api/pi/threads/${roomThreadId(room.id)}`,
    })).json())).toHaveLength(1);

    gate.resolve();
    await running;

    // The reply and the Task's success committed in one transaction, so the thread
    // now shows the agent's message and went idle on its own.
    const snap = await h.app.inject({ method: "GET", url: `/api/pi/threads/${roomThreadId(room.id)}` });
    expect(metadataOf(snap.json()).status).toBe("idle");
    const messages = messagesOf(snap.json());
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      customType: "room-agent",
      details: { authorKind: "agent", name: "高见远", agentId: arch.id },
    });
    expect(messages[1]!.content).toEqual([{ type: "text", text: "方案已给出" }]);
    await h.close();
  });

  it("room and Task threads coexist without changing either projection", async () => {
    const h = await buildHarness("coexist");
    const { room } = seedRoom(h);
    // A P7a single-agent thread, driven exactly the way react-pi drives it.
    const created = await h.app.inject({ method: "POST", url: "/api/pi/threads", payload: {} });
    const taskThreadId = (created.json() as { metadata: { id: string } }).metadata.id;
    expect(taskThreadId.startsWith("room:")).toBe(false);
    const sent = await h.app.inject({
      method: "POST", url: `/api/pi/threads/${taskThreadId}/messages`,
      payload: { input: { content: "单 agent 的真实任务" } },
    });
    expect(sent.statusCode).toBe(204);
    expect(h.store.getTask(taskThreadId)!.prompt).toBe("单 agent 的真实任务");
    // The room is untouched by Task-thread traffic, and vice versa.
    expect(h.store.getTask(taskThreadId)!.groupId).toBeUndefined();
    expect((await h.app.inject({
      method: "GET", url: `/api/pi/threads/${roomThreadId(room.id)}`,
    })).json().metadata).toMatchObject({ status: "idle", messageCount: 0 });
    const taskSnap = await h.app.inject({ method: "GET", url: `/api/pi/threads/${taskThreadId}` });
    expect(messagesOf(taskSnap.json())[0]).toMatchObject({ role: "user", content: "单 agent 的真实任务" });
    await h.close();
  });
});
