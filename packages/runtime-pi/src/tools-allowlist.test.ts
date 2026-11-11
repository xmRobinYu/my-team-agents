/**
 * AC5.2 at the adapter boundary: the read-only allowlist must become a real
 * `--tools` argument, and a run WITHOUT an allowlist must keep byte-identical argv.
 *
 * A registration-time check that never reaches the command line is phantom
 * enforcement — the rule would say "read-only" while Pi still got its default
 * `read,bash,edit,write`. This pins the half that actually constrains the run.
 */

import { EventEmitter } from "node:events";
import { afterAll, describe, expect, it } from "vitest";
import type { RunSpec } from "@my-team-agents/runtime-core";
import { PiAdapter } from "./adapter.js";

type FakeChild = EventEmitter & {
  stdout: { setEncoding(): void; on(ev: "data", fn: (chunk: string) => void): void };
  stdin: { write(value: string): void };
  kill(): void;
  killed: boolean;
  exitCode: number | null;
};

/** Fake `pi`: records argv, then streams a settled run (the shape adapter.ts reads). */
function fakeSpawn(): { spawn: typeof import("node:child_process").spawn; args: () => string[] } {
  let captured: string[] = [];
  const spawn = ((_command: string, args: string[]) => {
    captured = [...args];
    const child = new EventEmitter() as FakeChild;
    child.killed = false;
    child.exitCode = null;
    child.stdout = {
      setEncoding: () => {},
      on: (_ev, listener) => {
        setTimeout(() => {
          for (const line of [
            { type: "agent_start" },
            { type: "agent_end" },
            { type: "agent_settled", aborted: false },
          ]) listener(`${JSON.stringify(line)}\n`);
        }, 0);
      },
    };
    child.stdin = { write: () => {} };
    child.kill = () => { child.killed = true; };
    return child as never;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, args: () => captured };
}

const baseSpec: RunSpec = {
  runId: "r1", tenantId: "t", projectId: "p", memberId: "m",
  workspacePath: "/tmp/project", prompt: "work",
};

async function argvFor(
  spec: RunSpec,
  options: { handoffExtension?: boolean; isolatePersonaSessions?: boolean } = {},
): Promise<string[]> {
  const { spawn, args } = fakeSpawn();
  const handle = await new PiAdapter({
    approveProjectResources: true,
    spawn,
    ...(options.handoffExtension === false ? { handoffExtension: false } : {}),
    ...(options.isolatePersonaSessions === false ? { isolatePersonaSessions: false } : {}),
  }).start(spec);
  for await (const _event of handle.events) { /* drain */ }
  await handle.settled;
  return args();
}

const valueAfter = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

describe("AC5.2 — the tool allowlist reaches pi's command line", () => {
  it("passes --tools with the read-only set, comma-joined", async () => {
    const args = await argvFor({ ...baseSpec, tools: ["read", "grep", "find", "ls", "handoff_to"] });
    expect(valueAfter(args, "--tools")).toBe("read,grep,find,ls,handoff_to");
    // The default selection is REPLACED, so no writable default survives.
    expect(valueAfter(args, "--tools")).not.toContain("write");
    expect(valueAfter(args, "--tools")).not.toContain("bash");
  });

  it("appends no --tools when the run has none: existing argv is unchanged", async () => {
    const args = await argvFor(baseSpec, { handoffExtension: false, isolatePersonaSessions: false });
    expect(args).not.toContain("--tools");
  });

  it("an empty allowlist is treated as absent, not as 'deny everything'", async () => {
    // `--tools ""` would disable the whole tool set. An empty array must mean
    // "runtime default", which is what a non-ingress Task carries.
    const args = await argvFor({ ...baseSpec, tools: [] }, { handoffExtension: false });
    expect(args).not.toContain("--tools");
  });
});
