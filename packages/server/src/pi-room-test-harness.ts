/**
 * Shared fixtures for the I7 group-thread tests. Not a test file itself, so the
 * suites below can import it without re-running each other's cases.
 *
 * `gatedAdapter` is the important piece: it lets a test hold a Pi run open until
 * the test decides to release it. Without that, "is the thread running?" would be
 * a race against a fast mock, and a projection that reported `idle` too early
 * could still pass — precisely the failure mode worth catching.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createDurableWorker, ExecutionStore, RoomStore } from "@my-team-agents/orchestrator";
import type { RuntimeAdapter } from "@my-team-agents/runtime-core";
import { buildApp } from "./app.js";

/** Scratch dir for SQLite files and persona dirs; each test file removes it in
 * its own `afterAll`, because a hook registered from an imported module would
 * attach to whichever suite got there first. */
export const tempDir = mkdtempSync(join(tmpdir(), "pi-room-"));

export const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

/** A runtime that yields its remaining events only after `gate` resolves. */
export const gatedAdapter = (gate: Promise<void>, summary: string): RuntimeAdapter => ({
  kind: "pi",
  capabilities: {
    streaming: true, steer: false, cancel: true, approval: "none", sandbox: "none",
    workspacePerRun: true, agentDirPerRun: true, usageAttribution: "message",
    costCap: false, sessionResume: false,
  },
  async start(spec) {
    return {
      runId: spec.runId,
      events: (async function* () {
        yield { type: "agent_start", runId: spec.runId, timestamp: new Date().toISOString() } as never;
        await gate;
        yield {
          type: "message_end", runId: spec.runId, timestamp: new Date().toISOString(),
          text: JSON.stringify({ outcome: "success", summary, artifacts: [], remainingRisks: [] }),
        } as never;
        yield { type: "agent_settled", runId: spec.runId, timestamp: new Date().toISOString() } as never;
      })(),
      settled: (async () => {
        await gate;
        return { runId: spec.runId, status: "completed" as const };
      })(),
      async cancel() {},
    };
  },
});

export interface Harness {
  app: Awaited<ReturnType<typeof buildApp>>;
  store: ExecutionStore;
  rooms: RoomStore;
  worker: ReturnType<typeof createDurableWorker>;
  /** Real TCP origin — the react-pi client test streams SSE against this. */
  origin: string;
  close: () => Promise<void>;
}

/**
 * A real Fastify listener. Route assertions still use `app.inject` (fast, and
 * body-exact), but `inject` buffers a whole reply, so anything that needs SSE has
 * to use `origin` over TCP.
 */
export const buildHarness = async (name: string, adapter?: RuntimeAdapter): Promise<Harness> => {
  const store = new ExecutionStore(join(tempDir, `${name}.sqlite`));
  const rooms = new RoomStore(store.db);
  const worker = createDurableWorker(store, {
    adapterFor: () => adapter ?? gatedAdapter(Promise.resolve(), "noop"),
    rooms,
  });
  const app = await buildApp({
    store, worker, rooms,
    // Fixed project workspace, so a room thread's `workspacePath` is assertable
    // rather than whatever directory the runner happened to start in.
    defaultWorkspacePath: "/ws/test",
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  return {
    app, store, rooms, worker,
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      await app.close();
      rooms.close();
      store.close();
    },
  };
};

/** Seed a two-persona room; the personas are what author identity resolves to. */
export const seedRoom = (h: Harness) => {
  const room = h.rooms.createRoom({ projectId: "my-team-agents", name: "研发群" }, 100);
  const arch = h.rooms.addAgent({
    roomId: room.id, name: "高见远", role: "架构师", prompt: "You design.",
    agentDir: join(tempDir, "persona/arch"), emoji: "🏗️", color: "#ff0000",
  }, 101);
  const qa = h.rooms.addAgent({
    roomId: room.id, name: "QA", role: "测试", prompt: "You test.",
    agentDir: join(tempDir, "persona/qa"), isCoordinator: true,
  }, 102);
  return { room, arch, qa };
};

export const waitFor = async (predicate: () => boolean, ms = 15_000): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > ms) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 25));
  }
};

export type Projected = Array<{
  role: string;
  customType?: string;
  content: unknown;
  timestamp?: number;
  details?: Record<string, unknown>;
}>;

export const messagesOf = (body: unknown): Projected => (body as { messages: Projected }).messages;
export const metadataOf = (body: unknown): Record<string, unknown> =>
  (body as { metadata: Record<string, unknown> }).metadata;
