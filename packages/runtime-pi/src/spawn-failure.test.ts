import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunSpec } from "@my-team-agents/runtime-core";
import { PiAdapter, spawnFailureMessage } from "./adapter.js";

/**
 * A failed spawn must fail the RUN, not the process.
 *
 * Reproduced against the real binary: `PiAdapter` spawns `pi` with
 * `cwd: spec.agentDir`, and on macOS a missing cwd gives the exact same
 * `ENOENT / syscall: "spawn pi"` as a missing binary. The adapter listened for
 * `error` and rejected the `done` promise that `streamEvents` returns but nobody
 * observes -- an unhandled rejection, which Node treats as fatal. So one Task
 * whose persona directory had been deleted killed the whole Worker, and every
 * other queued Task in every room went down with it. AGENTS.md names this
 * invariant for the dispatcher ("a runtime that throws on start() must degrade to
 * failed, never propagate"); the runtime itself was the one violating it.
 *
 * Vitest fails the file on an unhandled rejection, so simply completing the
 * assertions below is the process-crash proof.
 */

const spec = (over: Partial<RunSpec> = {}): RunSpec => ({
  runId: "run-spawn", tenantId: "t1", projectId: "p1", memberId: "m1",
  workspacePath: "/tmp/project", prompt: "hi", ...over,
});

/** A child that never produces output and fails to spawn, like the real thing. */
const failingSpawn = (message: string) => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: { setEncoding(): void; on(): void };
    stderr: { setEncoding(): void; on(): void };
    stdin: { write(v: string): void };
    kill(): void;
    killed: boolean;
    exitCode: number | null;
  };
  child.killed = false;
  child.exitCode = null;
  // Real stdio streams exist even when the binary cannot be found, and the
  // adapter reads stdout eagerly -- so the stubs must be present.
  child.stdout = { setEncoding: () => {}, on: () => {} };
  child.stderr = { setEncoding: () => {}, on: () => {} };
  child.stdin = { write: () => {} };
  child.kill = () => { child.killed = true; };
  // Node emits the spawn error asynchronously, after start() has returned.
  setTimeout(() => {
    const err = Object.assign(new Error(message), { code: "ENOENT", syscall: "spawn pi" });
    child.emit("error", err);
  }, 0);
  return (() => child) as unknown as typeof import("node:child_process").spawn;
};

describe("PiAdapter spawn failure", () => {
  it("settles the run as failed instead of rejecting unobserved", async () => {
    const adapter = new PiAdapter({
      approveProjectResources: true,
      spawn: failingSpawn("spawn pi ENOENT"),
    });

    const handle = await adapter.start(spec({ agentDir: "/tmp/persona-deleted" }));
    const settled = await handle.settled;

    expect(settled.status).toBe("failed");
    expect(settled.error, "the spawn error must reach RunResult, not the void")
      .toContain("ENOENT");
  });

  it("ends the event stream so the consumer cannot hang on a dead child", async () => {
    const adapter = new PiAdapter({
      approveProjectResources: true,
      spawn: failingSpawn("spawn pi ENOENT"),
    });

    const handle = await adapter.start(spec({ agentDir: "/tmp/persona-deleted" }));
    const seen: string[] = [];
    // Without the fix this awaits forever: `error` only rejected `done`, and the
    // iterator's queue never saw a terminal frame.
    for await (const event of handle.events) seen.push(event.type);

    expect(seen, "a child that never wrote must not fabricate events").toEqual([]);
  });
});

describe("spawnFailureMessage", () => {
  // Node gives a missing cwd and a missing binary the same ENOENT/"spawn pi", so
  // the message has to separate them -- this conflation is what sent an
  // investigation down "pi is not installed" for several runs (CONTEXT.md Q45).
  const enoent = () => Object.assign(new Error("spawn pi ENOENT"), {
    code: "ENOENT", syscall: "spawn pi", path: "pi",
  });

  it("names the missing working directory when the cwd is gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "mta-cwd-"));
    const gone = join(dir, "no-such-persona");
    try {
      const msg = spawnFailureMessage(enoent(), gone);
      expect(msg).toContain("工作目录不存在");
      expect(msg).toContain(gone);
      expect(msg, "must not blame the binary when the cwd is the problem")
        .not.toContain("不在 PATH 上");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("points at PATH when the cwd exists, so the binary really is unreachable", () => {
    const dir = mkdtempSync(join(tmpdir(), "mta-cwd-"));
    try {
      const msg = spawnFailureMessage(enoent(), dir);
      expect(msg).toContain("不在 PATH 上");
      expect(msg).not.toContain("工作目录不存在");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves any other spawn error verbatim", () => {
    const err = Object.assign(new Error("spawn pi EACCES"), { code: "EACCES" });
    expect(spawnFailureMessage(err, "/tmp")).toBe("spawn pi EACCES");
  });
});
