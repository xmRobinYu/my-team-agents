import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * D1's wiring test: the seam between the production factory and the adapter.
 *
 * D1/D3 take effect through `PiAdapter`'s DEFAULTS (`handoffExtension !== false`,
 * `isolatePersonaSessions !== false`), which is why `runtime.ts` needs no change and
 * its `new PiAdapter({ approveProjectResources: true })` line is NOT a regression.
 * "Reverting" it to itself changes nothing; adding `handoffExtension: true` there
 * would be redundancy that a future default flip could contradict silently.
 *
 * Stance: the defaults ARE the contract, so this test guards three things it was
 * measured to actually catch (mutation runs in the I10 report):
 *   1. flipping an adapter default to opt-in (`x !== false` -> `x === true`) — red;
 *   2. the factory opting out explicitly (`handoffExtension: false` or
 *      `isolatePersonaSessions: false` passed here) — red;
 *   3. the argv losing `--extension` / `--session-dir` for a persona run — red.
 * It does NOT fail on `runtime.ts` reverting to the bare constructor, because that
 * bare constructor already loads both. `handoff-pi-contract.test.ts` covers the
 * mechanism (argv -> extension file -> parser); this file covers who builds it.
 *
 * `node:child_process.spawn` is mocked, and the suite was also run with `pi` absent
 * from `PATH` (3 passed), so no process launches and no model is called: the only
 * fact under test is the command line the production factory produces.
 */

const captured: Array<{ command: string; args: string[]; cwd: string | undefined }> = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options?: { cwd?: string }) => {
      captured.push({ command, args, cwd: options?.cwd });
      const child = new EventEmitter() as EventEmitter & {
        stdout: { setEncoding(): void; on(): void };
        stdin: { write(): void };
        kill(): void;
        exitCode: number | null;
        killed: boolean;
      };
      child.stdout = { setEncoding: () => {}, on: () => {} };
      child.stdin = { write: () => {} };
      child.kill = () => {};
      child.exitCode = null;
      child.killed = false;
      return child as never;
    },
  };
});

const tempDir = mkdtempSync(join(tmpdir(), "d1-wiring-"));
const persona = join(tempDir, "persona");
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

let runtimeFor: typeof import("./runtime.js").runtimeFor;
let handoffExtensionPath: typeof import("@my-team-agents/runtime-pi").handoffExtensionPath;
let piSessionDirForAgent: typeof import("@my-team-agents/runtime-pi").piSessionDirForAgent;

beforeAll(async () => {
  // Imported after the mock is installed, so PiAdapter's `spawn` is the recorder.
  ({ runtimeFor } = await import("./runtime.js"));
  ({ handoffExtensionPath, piSessionDirForAgent } = await import("@my-team-agents/runtime-pi"));
});

const spec = (memberId: string, agentDir?: string) => ({
  runId: `wiring-${memberId}`, tenantId: "t", projectId: "p", memberId,
  workspacePath: tempDir, ...(agentDir ? { agentDir } : {}), prompt: "ship it",
});

describe("runtimeFor — the adapters the server actually spawns", () => {
  it("the Pi member's command line loads the handoff extension", async () => {
    mkdirSync(persona, { recursive: true });
    captured.length = 0;
    const handle = await runtimeFor("pi-agent").start(spec("pi-agent", persona));
    void handle.settled.catch(() => undefined);

    const call = captured[0];
    if (!call) throw new Error("runtimeFor spawned nothing");
    expect(call.command).toBe("pi");
    expect(call.args[call.args.indexOf("--extension") + 1]).toBe(handoffExtensionPath());
    expect(call.args[call.args.indexOf("--session-dir") + 1]).toBe(piSessionDirForAgent(persona));
    expect(call.cwd).toBe(persona);
  });

  it("a persona-less Pi run isolates nothing but still registers the tool", async () => {
    captured.length = 0;
    const handle = await runtimeFor("pi-plain").start(spec("pi-plain"));
    void handle.settled.catch(() => undefined);

    const call = captured[0];
    if (!call) throw new Error("runtimeFor spawned nothing");
    // D1 applies to every Pi run — a room member without an agentDir still hands off.
    expect(call.args).toContain("--extension");
    // D3 must not touch a run that has no persona dir: no flag, cwd unchanged.
    expect(call.args).not.toContain("--session-dir");
    expect(call.cwd).toBe(tempDir);
  });

  it("the CLI members are untouched by both fixes", async () => {
    // "没有 agentDir 的 Task（以及 runtime-cli）行为不得改变" — the CLI adapters
    // build their own argv and must not acquire Pi flags or a Pi-shaped cwd.
    captured.length = 0;
    for (const memberId of ["claude-x", "codex-x", "dsh-x"]) {
      const handle = await runtimeFor(memberId).start(spec(memberId));
      void handle.settled.catch(() => undefined);
    }
    expect(captured.map((call) => call.command)).toEqual(["claude", "codex", "dsh"]);
    for (const call of captured) {
      expect(call.args).not.toContain("--extension");
      expect(call.args).not.toContain("--session-dir");
      expect(call.args).not.toContain("--mode");
    }
  });
});
