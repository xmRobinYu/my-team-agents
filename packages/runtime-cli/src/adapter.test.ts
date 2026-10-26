import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { CliAdapter, normalizeLine } from "./adapter.js";
import type { RunSpec } from "@my-team-agents/runtime-core";

const spec: RunSpec = {
  runId: "r1",
  tenantId: "t1",
  projectId: "p1",
  memberId: "m1",
  workspacePath: "/tmp/proj",
  prompt: "do it",
};

describe("normalizeLine", () => {
  it("maps shared event names onto the canonical contract", () => {
    const ev = normalizeLine('{"type":"message_update","delta":"hi"}', "r1");
    expect(ev?.type).toBe("message_update");
    expect(ev?.text).toBe("hi");
    expect(ev?.runId).toBe("r1");
  });

  it("maps error events", () => {
    const ev = normalizeLine('{"type":"error","error":"boom"}', "r1");
    expect(ev?.type).toBe("error");
    expect(ev?.isError).toBe(true);
    expect(ev?.error).toBe("boom");
  });

  it("keeps unknown event names visible instead of dropping them", () => {
    const ev = normalizeLine('{"type":"something_new","foo":1}', "r1");
    expect(ev?.type).toBe("unknown");
    expect(ev?.rawType).toBe("something_new");
  });

  it("surfaces plain-text output rather than discarding it", () => {
    const ev = normalizeLine("just text", "r1");
    expect(ev?.type).toBe("unknown");
    expect(ev?.text).toBe("just text");
  });

  it("returns null for blank lines", () => {
    expect(normalizeLine("   ", "r1")).toBeNull();
  });
});

describe("CliAdapter capabilities", () => {
  it("declares no usage attribution and no steer for all CLI runtimes in v1", () => {
    for (const kind of ["claude-cli", "codex-cli", "dsh-cli"] as const) {
      const a = new CliAdapter({ kind });
      expect(a.capabilities.usageAttribution).toBe("none");
      expect(a.capabilities.steer).toBe(false);
      expect(a.capabilities.agentDirPerRun).toBe(false);
    }
  });

  it("exposes claude's cost cap and codex's sandbox as declared capabilities", () => {
    expect(new CliAdapter({ kind: "claude-cli" }).capabilities.costCap).toBe(true);
    expect(new CliAdapter({ kind: "codex-cli" }).capabilities.sandbox).toBe("read-only");
  });
});

describe("CliAdapter.start", () => {
  it("builds the expected argv per runtime", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const fakeSpawn = (command: string, args: string[]) => {
      calls.push({ command, args });
      const child = new EventEmitter() as EventEmitter & {
        stdout: { setEncoding(e: string): void; on(ev: string, fn: (c: unknown) => void): void };
        kill(): void;
      };
      child.stdout = { setEncoding: () => {}, on: () => {} };
      child.kill = () => {};
      return child;
    };

    for (const kind of ["claude-cli", "codex-cli", "dsh-cli"] as const) {
      try {
        await new CliAdapter({ kind, spawn: fakeSpawn as never }).start(spec);
      } catch {
        // The fake child has no stdin plumbing; argv capture is what matters here.
      }
    }

    expect(calls.map((c) => c.command)).toEqual(["claude", "codex", "dsh"]);
    expect(calls[0]!.args).toContain("--output-format");
    expect(calls[0]!.args).toContain("stream-json");
    expect(calls[1]!.args.slice(0, 2)).toEqual(["exec", "--sandbox"]);
    expect(calls[1]!.args).toContain(spec.workspacePath);
    expect(calls[2]!.args.slice(0, 2)).toEqual(["--profile", "headless"]);
    expect(calls[2]!.args.at(-1)).toBe("do it");
  });
});
