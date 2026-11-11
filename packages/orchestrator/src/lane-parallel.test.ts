/**
 * P9c/AC3.2 — `parallel` is honoured, and a Room is never widened by it.
 *
 * The multi-process shape is the point, same as `group-serial.test.ts`: two
 * `ExecutionStore` instances over ONE FILE. One worker would look concurrent (or
 * serial) by accident.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExecutionStore } from "./execution-store.js";

const dir = mkdtempSync(join(tmpdir(), "mta-parallel-"));

const base = (over: Record<string, unknown> = {}) => ({
  tenantId: "t1", projectId: "p1", memberId: "agent-pm",
  workspacePath: "/tmp/ws", prompt: "work", ...over,
});

/** Live (leased/running, unexpired) Attempts per serialisation key. */
const livePerKey = (store: ExecutionStore) => {
  const rows = store.db.prepare(`
    SELECT COALESCE(t.lane, t.group_id) AS key, COUNT(*) AS n
    FROM tasks t JOIN attempts a ON a.task_id = t.id
    WHERE a.status IN ('leased','running') AND a.lease_expires_at > ?
    GROUP BY key`).all(Date.now()) as Array<{ key: string | null; n: number }>;
  return new Map(rows.map((r) => [r.key, r.n]));
};

describe("P9c parallel fan-out", () => {
  it("parallel=2 lets two workers take two Tasks of one lane", () => {
    const a = new ExecutionStore(join(dir, "p2.sqlite"));
    const b = new ExecutionStore(join(dir, "p2.sqlite"));
    for (let i = 0; i < 3; i += 1) a.createTask(base({ lane: "L2", parallel: 2, prompt: `job-${i}` }));

    const first = a.claimNext("w1", Date.now(), 60_000);
    const second = b.claimNext("w2", Date.now(), 60_000);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.task.id).not.toBe(second!.task.id);
    expect(livePerKey(a).get("L2")).toBe(2);

    // ... and the THIRD is still held back: the bound is 2, not unlimited.
    expect(a.claimNext("w3", Date.now(), 60_000)).toBeNull();
    a.close(); b.close();
  });

  it("the default is still 1, so every pre-existing lane stays serial", () => {
    const a = new ExecutionStore(join(dir, "p1.sqlite"));
    const b = new ExecutionStore(join(dir, "p1.sqlite"));
    a.createTask(base({ lane: "L1" }));
    a.createTask(base({ lane: "L1", prompt: "second" }));
    expect(a.claimNext("w1", Date.now(), 60_000)).not.toBeNull();
    expect(b.claimNext("w2", Date.now(), 60_000)).toBeNull();
    a.close(); b.close();
  });

  it("a groupId Task is clamped to 1 even when asked for more (I3 AC3)", () => {
    const store = new ExecutionStore(join(dir, "room.sqlite"));
    const t = store.createTask(base({ groupId: "room-1", parallel: 4 }));
    // The clamp is on the ROW, not just in the predicate, so nothing downstream can
    // read a promise the queue will not keep.
    expect(store.getTask(t.id)!.parallel).toBe(1);
    store.createTask(base({ groupId: "room-1", parallel: 4, prompt: "second" }));
    expect(store.claimNext("w1", Date.now(), 60_000)).not.toBeNull();
    expect(store.claimNext("w2", Date.now(), 60_000)).toBeNull();
    store.close();
  });

  it("a nonsense value degrades to 1 rather than to unbounded", () => {
    const store = new ExecutionStore(join(dir, "junk.sqlite"));
    for (const bad of [0, -3, 1.5]) {
      const t = store.createTask(base({ lane: `L-${bad}`, parallel: bad }));
      expect(store.getTask(t.id)!.parallel).toBe(1);
    }
    store.close();
  });

  it("two lanes do not share a bound", () => {
    const store = new ExecutionStore(join(dir, "two-lane.sqlite"));
    store.createTask(base({ lane: "A", parallel: 1 }));
    store.createTask(base({ lane: "B", parallel: 1 }));
    const a = store.claimNext("w1", Date.now(), 60_000);
    const b = store.claimNext("w2", Date.now(), 60_000);
    expect(a!.task.lane).not.toBe(b!.task.lane);
    store.close();
  });
});

it("re-opening an old database defaults its rows to parallel=1", () => {
  // The column arrives through the ledger, so a row written before it existed has no
  // value at all. Reading that as "unbounded" would silently parallelise a live
  // system on upgrade.
  const file = join(dir, "legacy.sqlite");
  const first = new ExecutionStore(file);
  const t = first.createTask(base({ lane: "OLD" }));
  first.db.exec("UPDATE tasks SET parallel = NULL WHERE id = ?");
  first.close();

  const second = new ExecutionStore(file);
  expect(second.getTask(t.id)!.parallel).toBe(1);
  second.createTask(base({ lane: "OLD", prompt: "second" }));
  expect(second.claimNext("w1", Date.now(), 60_000)).not.toBeNull();
  expect(second.claimNext("w2", Date.now(), 60_000)).toBeNull();
  second.close();
});
