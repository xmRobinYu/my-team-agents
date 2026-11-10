import { describe, expect, it } from "vitest";
import type { CanonicalEvent, RunHandle, RunSpec, RuntimeAdapter } from "@my-team-agents/runtime-core";
import { ExecutionStore } from "./execution-store.js";
import { RoomStore } from "./room-store.js";
import { createDurableWorker } from "./durable-worker.js";
import { postRoomMessage } from "./room-trigger.js";

/**
 * P8 patch (event-ingress PRD §10): `RoomAgent.thinkingMode` -> `RunSpec.thinking`.
 *
 * The chain was broken in the middle, and every link on both sides was already
 * tested -- `thinking_mode` is stored (`room-store.test.ts`), the template importer
 * migrates it (`template-import.test.ts`), and Pi turns `spec.thinking` into
 * `--thinking` (`runtime-pi/src/skills.test.ts` pins the argv). What nobody tested
 * was the seam: `durable-worker` never set `spec.thinking`, so a room that declared
 * `thinkingMode: "high"` silently ran at the adapter default. The proof has to be
 * the spec the WORKER hands the adapter, because that is the exact place the value
 * used to disappear.
 */

const summary = (text: string) => JSON.stringify({
  outcome: "success", summary: text, artifacts: [], remainingRisks: [],
});

const CAPS = {
  streaming: true, steer: false, cancel: true, approval: "none" as const, sandbox: "none" as const,
  workspacePerRun: true, agentDirPerRun: true, usageAttribution: "message" as const,
  costCap: false, sessionResume: false,
};

const handle = (spec: RunSpec, text: string): RunHandle => {
  const event: CanonicalEvent = {
    type: "message_end", runId: spec.runId, timestamp: "", text: summary(text),
  };
  return {
    runId: spec.runId,
    events: (async function* () { yield event; })(),
    settled: Promise.resolve({ runId: spec.runId, status: "completed" }),
    async cancel() {},
  };
};

/** Records every RunSpec the worker starts. */
const recorder = (): { adapter: RuntimeAdapter; specs: RunSpec[] } => {
  const specs: RunSpec[] = [];
  const adapter: RuntimeAdapter = {
    kind: "pi",
    capabilities: CAPS,
    async start(spec) { specs.push(spec); return handle(spec, "已收到"); },
  };
  return { adapter, specs };
};

const setup = (thinkingMode: string | null) => {
  const store = new ExecutionStore(":memory:");
  const rooms = new RoomStore(store.db);
  const room = rooms.createRoom({ projectId: "proj-1", name: "研发群" }, 100);
  const lead = rooms.addAgent({
    roomId: room.id, name: "架构师", role: "架构", prompt: "You design.",
    agentDir: "/persona/arch", model: "acme/large", thinkingMode,
  }, 100);
  const seen = recorder();
  const worker = createDurableWorker(store, {
    workerId: "w1", adapterFor: () => seen.adapter, rooms, now: () => 200,
  });
  const trigger = () => postRoomMessage(rooms, store, {
    roomId: room.id, content: "请 @架构师 定方案",
    tenantId: "default", workspacePath: "/workspace/proj-1", now: 200,
  });
  return { store, rooms, room, lead, worker, seen, trigger };
};

describe("RoomAgent.thinkingMode reaches the run (P8 patch)", () => {
  it("passes the declared level to the adapter instead of the default", async () => {
    const h = setup("high");
    h.trigger();
    expect(await h.worker.runOnce()).toBe(true);

    const spec = h.seen.specs[0]!;
    expect(spec.thinking, "worker 必须把花名册的 thinkingMode 交给 adapter").toBe("high");
    // The neighbouring persona fields must keep working: this fix must not have
    // been achieved by reordering or replacing the existing spread.
    expect(spec.agentDir).toBe("/persona/arch");
    expect(spec.model).toBe("acme/large");
    h.store.close();
  });

  it("omits thinking entirely when the room declares none, so the adapter default stands", async () => {
    const h = setup(null);
    h.trigger();
    expect(await h.worker.runOnce()).toBe(true);

    // `undefined`, not `"off"`: inventing a level the room never asked for would
    // change every existing room's behaviour on upgrade.
    expect(h.seen.specs[0]!.thinking).toBeUndefined();
    h.store.close();
  });

  it("drops a value outside Pi's set rather than putting free text on the command line", async () => {
    // `thinking_mode` is TEXT and the value comes from model-authored team
    // templates, so it must be clamped. `--thinking` is spliced into argv; an
    // arbitrary string there is a template-controlled command-line token.
    const h = setup("high; rm -rf /");
    h.trigger();
    expect(await h.worker.runOnce()).toBe(true);

    expect(h.seen.specs[0]!.thinking).toBeUndefined();
    // A bad level must not cost the run: the task still succeeds on the default.
    expect(h.store.listTasks()[0]?.status).toBe("succeeded");
    h.store.close();
  });

  it("falls back to the adapter default for a non-group task, which has no persona row", async () => {
    const h = setup("high");
    // No groupId => `memberId` is an execution member, not a persona. Reading a
    // roster row here would be the same mistake `personaFields` documents.
    h.store.createTask({
      tenantId: "t", projectId: "p", memberId: h.lead.id,
      workspacePath: "/workspace/proj-1", prompt: "plain work",
    }, 200);
    expect(await h.worker.runOnce()).toBe(true);

    const spec = h.seen.specs[0]!;
    expect(spec.thinking).toBeUndefined();
    expect(spec.agentDir).toBeUndefined();
    h.store.close();
  });

  it("gives a dispatched child its OWN level, not the parent's", async () => {
    // The reason `thinking` is derived per run instead of copied onto the Task:
    // a child speaks as a different persona and must not inherit the parent's
    // depth. Parent = 架构师(high), child = QA(low), dispatched by `@QA`.
    const store = new ExecutionStore(":memory:");
    const rooms = new RoomStore(store.db);
    const room = rooms.createRoom({ projectId: "proj-1", name: "研发群" }, 100);
    rooms.addAgent({
      roomId: room.id, name: "架构师", role: "架构", prompt: "You design.",
      agentDir: "/persona/arch", thinkingMode: "high",
    }, 100);
    const qa = rooms.addAgent({
      roomId: room.id, name: "QA", role: "测试", prompt: "You test.",
      agentDir: "/persona/qa", thinkingMode: "low",
    }, 101);

    const specs: RunSpec[] = [];
    const adapter: RuntimeAdapter = {
      kind: "pi",
      capabilities: CAPS,
      async start(spec) {
        specs.push(spec);
        // The architect's reply mentions QA, which dispatches the child on the
        // secondary (`@name`) path -- the same bytes are spoken and honoured.
        return handle(spec, spec.agentDir === "/persona/arch" ? "@QA 请复核" : "复核完成");
      },
    };
    const worker = createDurableWorker(store, {
      workerId: "w1", adapterFor: () => adapter, rooms, now: () => 200,
    });
    postRoomMessage(rooms, store, {
      roomId: room.id, content: "请 @架构师 定方案",
      tenantId: "default", workspacePath: "/workspace/proj-1", now: 200,
    });
    while (await worker.runOnce()) { /* drain parent then child */ }

    const byDir = new Map(specs.map((s) => [s.agentDir, s.thinking]));
    expect(byDir.get("/persona/arch")).toBe("high");
    expect(byDir.get("/persona/qa"), "子 Task 用自己的 thinkingMode，不继承父的").toBe("low");
    expect(store.listTasks().find((t) => t.memberId === qa.id)?.status).toBe("succeeded");
    store.close();
  });
});
