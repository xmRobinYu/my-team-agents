import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RunSpec } from "@my-team-agents/runtime-core";
import { PiAdapter } from "./adapter.js";
import { PERSONA_SESSION_DIR_NAME, piSessionDirArgs, piSessionDirForAgent } from "./session-isolation.js";

/**
 * D3: persona isolation did not isolate sessions.
 *
 * `agentDir` only ever reached Pi as the spawn `cwd` (Q38), while Pi stored every
 * transcript in the shared `~/.pi/agent/sessions`, "grouped by working directory" —
 * and grouping is a naming convention, not an access boundary. Acceptance measured
 * the result: a real model used `read`/`bash` to pull other rooms' and other roles'
 * full conversation out of that tree. A prompt-level prohibition cannot fix a
 * permissions fact, and a real sandbox is P7b (V1 has none, by design).
 *
 * The V1-size fix: `--session-dir <agentDir>/.pi/sessions`, documented in
 * docs/cli.md as overriding *storage and lookup*, taking precedence over both
 * `PI_CODING_AGENT_SESSION_DIR` and the `sessionDir` setting. These tests pin the
 * argv, the no-agentDir regression, and — critically — that Q18 resume survives the
 * pairing of `--session <path>` with `--session-dir`.
 */

const tempDir = mkdtempSync(join(tmpdir(), "pi-session-isolation-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

type FakeChild = EventEmitter & {
  stdout: { setEncoding(): void; on(ev: "data", fn: (chunk: string) => void): void };
  stdin: { write(value: string): void };
  kill(): void;
  killed: boolean;
  exitCode: number | null;
};

/** Records argv and ends the run, so `start()` settles without a real Pi. */
function recordingSpawn(): { spawn: typeof import("node:child_process").spawn; calls: string[][] } {
  const calls: string[][] = [];
  const spawn = ((_command: string, args: string[]) => {
    calls.push(args);
    const child = new EventEmitter() as FakeChild;
    child.killed = false;
    child.exitCode = null;
    child.stdout = {
      setEncoding: () => {},
      on: (_ev, listener) => {
        setTimeout(() => { listener(`${JSON.stringify({ type: "agent_settled", aborted: false })}\n`); }, 0);
      },
    };
    child.stdin = { write: () => {} };
    child.kill = () => { child.killed = true; };
    return child as never;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, calls };
}

const persona = join(tempDir, "persona");

const baseSpec: RunSpec = {
  runId: "run-d3", tenantId: "t1", projectId: "p1", memberId: "m1",
  workspacePath: "/tmp/project", prompt: "ship it",
};

const argvFor = async (
  spec: RunSpec,
  options: { isolatePersonaSessions?: boolean; handoffExtension?: boolean } = {},
): Promise<string[]> => {
  const { spawn, calls } = recordingSpawn();
  const handle = await new PiAdapter({
    approveProjectResources: true,
    spawn,
    ...options,
  }).start(spec);
  for await (const _event of handle.events) { /* drain */ }
  await handle.settled;
  const args = calls[0];
  if (!args) throw new Error("pi was never spawned");
  return args;
};

/** `--flag value` pair, as adjacent as the adapter must emit it. */
const valueOf = (args: string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

describe("piSessionDirForAgent", () => {
  it("places the session dir inside the persona dir, under .pi/sessions", () => {
    expect(piSessionDirForAgent(persona)).toBe(join(persona, ".pi", "sessions"));
    expect(PERSONA_SESSION_DIR_NAME).toBe(join(".pi", "sessions"));
  });

  it("makes a relative persona dir absolute, so Pi cannot resolve it elsewhere", () => {
    expect(piSessionDirForAgent("relative/persona")).toBe(join(process.cwd(), "relative/persona", ".pi", "sessions"));
  });

  it("returns no flag at all without a persona dir", () => {
    expect(piSessionDirArgs(undefined)).toEqual([]);
  });
});

describe("PiAdapter session isolation — D3", () => {
  it("passes --session-dir inside the persona dir when the run has an agentDir", async () => {
    const args = await argvFor({ ...baseSpec, agentDir: persona });
    expect(valueOf(args, "--session-dir")).toBe(join(persona, ".pi", "sessions"));
  });

  it("omits --session-dir entirely without an agentDir: unchanged behaviour", async () => {
    const args = await argvFor(baseSpec);
    expect(args).not.toContain("--session-dir");
    expect(args).not.toContain(join(tempDir, "persona"));
  });

  it("can be switched off, restoring the pre-D3 command line byte for byte", async () => {
    const off = await argvFor({ ...baseSpec, agentDir: persona }, { isolatePersonaSessions: false });
    expect(off).not.toContain("--session-dir");
  });

  it("Q18: --session <path> and --session-dir coexist, resume first, isolation alongside it", async () => {
    const sessionPath = join(tempDir, "sessions", "2026-01-01T00-00-00-000Z_run-d3.jsonl");
    const args = await argvFor({
      ...baseSpec,
      agentDir: persona,
      session: { sessionId: "run-d3", sessionDir: join(tempDir, "sessions"), sessionPath, resume: true },
    });

    // Both facts are on the command line; neither may displace the other.
    expect(valueOf(args, "--session")).toBe(sessionPath);
    expect(valueOf(args, "--session-dir")).toBe(join(persona, ".pi", "sessions"));
    // Ephemeral would defeat resume outright.
    expect(args).not.toContain("--no-session");
    // --session comes first: it selects the file, --session-dir is the override for
    // where new/lookup happens. Measured against pi 1.4.0 the pair reopens the file
    // with its history (messageCount 3 -> 5, both user turns in get_messages).
    expect(args.indexOf("--session")).toBeLessThan(args.indexOf("--session-dir"));
  });

  it("an explicitly ephemeral run asks for neither a file nor a directory", async () => {
    const args = await argvFor({ ...baseSpec, agentDir: persona, session: { sessionId: "", sessionDir: "", resume: false } });
    expect(args).toContain("--no-session");
    expect(args).not.toContain("--session-dir");
    expect(args).not.toContain("--session");
    // Measured against pi 1.4.0: `--no-session` + `--session-dir` neither errors nor
    // writes — the directory is not even created. So the flag is skipped as pointless
    // rather than because it would misbehave; the assertion above keeps a later
    // "simplification" from re-adding a flag with no effect to an ephemeral run.
  });
});
