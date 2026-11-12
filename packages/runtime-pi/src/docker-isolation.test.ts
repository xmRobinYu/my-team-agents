/**
 * P9d — the isolation backend's contract, tested without a daemon.
 *
 * The point of these assertions is the argv, because the argv IS the containment:
 * a dropped `--read-only`, a forgotten `--cap-drop ALL`, or a mount rewritten to a
 * different path would leave every other test in this repo green while the
 * isolation claim became false. What cannot be tested here (that the kernel
 * enforces it) is measured by `just p9-smoke`'s `iso` item against real containers.
 */

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { RunSpec } from "@my-team-agents/runtime-core";
import { PiAdapter } from "./adapter.js";
import {
  DEFAULT_ISOLATION_IMAGE,
  DockerIsolation,
  containerNameFor,
  isolationFromEnv,
  probeDockerIsolation,
  type RunIsolation,
} from "./docker-isolation.js";

/**
 * A docker binary that exists but never runs: `wrap()` is pure, so argv can be
 * asserted without a daemon, and `kill()` records instead of spawning.
 */
const isolationFor = (over: { exec?: (command: string, args: string[]) => void } = {}) =>
  new DockerIsolation({
    docker: process.execPath,
    image: "mta-test:1",
    modelsFile: "/nonexistent/models.json",
    ...over,
  });

const wrap = (over: Partial<Parameters<DockerIsolation["wrap"]>[0]> = {}) =>
  isolationFor().wrap({
    args: ["--mode", "rpc", "--approve"],
    cwd: "/workspace/p1/personas/a1",
    workspacePath: "/workspace/p1",
    agentDir: "/workspace/p1/personas/a1",
    runId: "attempt-7f3a",
    ...over,
  });

const flagValue = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

describe("P9d — container names", () => {
  it("sanitizes to docker's charset and never yields an empty name", () => {
    expect(containerNameFor("attempt-7f3a")).toBe("mta-attempt-7f3a");
    expect(containerNameFor("task:0df967/attempt 1")).toBe("mta-task-0df967-attempt-1");
    expect(containerNameFor("...")).toBe("mta-run");
    expect(containerNameFor("x".repeat(200)).length).toBeLessThanOrEqual(52);
  });
});

describe("P9d — the launched argv is the containment", () => {
  it("drops privilege, makes the rootfs read-only, and caps resources", () => {
    const args = wrap().args;
    expect(flagValue(args, "--cap-drop")).toBe("ALL");
    expect(flagValue(args, "--security-opt")).toBe("no-new-privileges");
    expect(flagValue(args, "--user")).toBe("1000:1000");
    expect(args).toContain("--read-only");
    expect(flagValue(args, "--pids-limit")).toBe("512");
    expect(flagValue(args, "--memory")).toBe("2g");
    // Equal swap means "no swap", otherwise the memory ceiling is only nominal.
    expect(flagValue(args, "--memory-swap")).toBe(flagValue(args, "--memory"));
    expect(flagValue(args, "--cpus")).toBe("2");
    // --init: without a reaper, a killed run leaves zombies that hold the pids cap.
    expect(args).toContain("--init");
    // --rm so a finished run leaves nothing; --name so a hung one can be reaped.
    expect(args).toContain("--rm");
    expect(flagValue(args, "--name")).toBe("mta-attempt-7f3a");
  });

  it("mounts the workspace and persona dir at the SAME paths, writable", () => {
    const args = wrap().args;
    expect(args).toContain("/workspace/p1:/workspace/p1:rw");
    expect(args).toContain("/workspace/p1/personas/a1:/workspace/p1/personas/a1:rw");
    // Same path is the whole reason the adapter's argv needs no translation.
    expect(flagValue(args, "--workdir")).toBe("/workspace/p1/personas/a1");
  });

  it("does not duplicate a persona dir that IS the workspace", () => {
    const args = wrap({ workspacePath: "/w", agentDir: "/w", cwd: "/w" }).args;
    expect(args.filter((a) => a.startsWith("/w:/w:"))).toHaveLength(1);
  });

  it("omits the agent mount for a workspace-only run", () => {
    const args = wrap({ workspacePath: "/w", cwd: "/w", agentDir: "" }).args;
    // tmpfs entries also end in `:rw`; only `--volume` arguments are mounts.
    const mounts = args.flatMap((value, i) => (args[i - 1] === "--volume" ? [value] : []));
    expect(mounts).toEqual(["/w:/w:rw"]);
  });

  it("ends with <image> pi <the adapter's own argv>, unchanged", () => {
    const launched = wrap();
    expect(launched.command).toBe(process.execPath);
    expect(launched.args.slice(-5)).toEqual(["mta-test:1", "pi", "--mode", "rpc", "--approve"]);
  });

  it("reaps by the same name it launched with", () => {
    const seen: string[][] = [];
    const isolation = isolationFor({ exec: (_command, args) => { seen.push(args); } });
    isolation.wrap({ args: [], cwd: "/w", workspacePath: "/w", runId: "attempt-7f3a" });
    isolation.kill("attempt-7f3a");
    expect(seen).toEqual([["kill", "mta-attempt-7f3a"]]);
  });
});

describe("P9d — the probe measures, it does not read config", () => {
  it("reports an unreachable daemon instead of claiming isolation", () => {
    const probe = probeDockerIsolation({ docker: "/nonexistent/docker-binary", image: "x:1" });
    expect(probe.ok).toBe(false);
    expect(probe.reason).toBeTruthy();
  });

  it("treats an unset switch as 'not isolated' and still refuses writable tools", () => {
    const setup = isolationFromEnv({});
    expect(setup.isolation).toBeNull();
    expect(setup.probe.backend).toBe("none");
    expect(setup.writableTools.allowed).toBe(false);
    expect(setup.writableTools.reason).toContain("MTA_ISOLATION");
  });

  it("refuses an unknown backend rather than silently falling back", () => {
    const setup = isolationFromEnv({ MTA_ISOLATION: "podman" });
    expect(setup.isolation).toBeNull();
    expect(setup.writableTools.allowed).toBe(false);
    expect(setup.writableTools.reason).toContain("docker");
  });
});

describe("P9d — the adapter runs the same argv through the sandbox", () => {
  /** Fake child that settles immediately; records what was spawned. */
  function fakeSpawn(): { spawn: typeof import("node:child_process").spawn;
    command: () => string; args: () => string[] } {
    let command = "";
    let captured: string[] = [];
    const spawn = ((cmd: string, args: string[]) => {
      command = cmd;
      captured = [...args];
      const child = new EventEmitter() as EventEmitter & {
        stdout: { setEncoding(): void; on(ev: "data", fn: (chunk: string) => void): void };
        stdin: { write(value: string): void };
        kill(): void; killed: boolean; exitCode: number | null;
      };
      child.killed = false;
      child.exitCode = null;
      child.stdout = { setEncoding: () => {}, on: (_ev, fn) => {
        setTimeout(() => {
          for (const line of [{ type: "agent_start" }, { type: "agent_settled", aborted: false }]) {
            fn(`${JSON.stringify(line)}\n`);
          }
        }, 0);
      } };
      child.stdin = { write: () => {} };
      child.kill = () => { child.killed = true; };
      return child as never;
    }) as unknown as typeof import("node:child_process").spawn;
    return { spawn, command: () => command, args: () => captured };
  }

  const spec: RunSpec = {
    runId: "attempt-7f3a", tenantId: "t", projectId: "p", memberId: "m",
    workspacePath: "/tmp/project", prompt: "work",
  };

  it("spawns docker, not pi, and reports sandbox=workspace-write", async () => {
    const real = isolationFor();
    // Spread would drop prototype methods, so delegate explicitly.
    const killCalls: string[] = [];
    const wrapped: RunIsolation = {
      kind: "docker",
      image: real.image,
      wrap: (input) => real.wrap(input),
      kill: (runId) => { killCalls.push(runId); },
    };
    const fake = fakeSpawn();
    const adapter = new PiAdapter({ approveProjectResources: true, spawn: fake.spawn, isolation: wrapped });
    expect(adapter.capabilities.sandbox).toBe("workspace-write");
    const handle = await adapter.start(spec);
    for await (const _event of handle.events) { /* drain */ }
    await handle.settled;
    expect(fake.command()).toBe(process.execPath);
    expect(fake.args()).toContain("--read-only");
    // The adapter's own argv survived the wrap: the container is a launcher, not a
    // second implementation that could drift from the verified command line.
    expect(fake.args().indexOf("pi")).toBeGreaterThan(fake.args().indexOf("run"));
    expect(fake.args().indexOf("--mode")).toBeGreaterThan(fake.args().indexOf("pi"));
  });

  it("keeps the historical launch byte-for-byte when isolation is absent", async () => {
    const fake = fakeSpawn();
    const adapter = new PiAdapter({ approveProjectResources: true, spawn: fake.spawn });
    expect(adapter.capabilities.sandbox).toBe("none");
    const handle = await adapter.start(spec);
    for await (const _event of handle.events) { /* drain */ }
    await handle.settled;
    expect(fake.command()).toBe("pi");
    expect(fake.args().slice(0, 2)).toEqual(["--mode", "rpc"]);
  });
});


/**
 * `constraints.yaml` declares the isolation limits. A declared limit with no
 * checker reads as a guarantee, which is why `max_complexity` is explicitly
 * recorded there as NOT enforced. These must not join it: the declaration is
 * compared against the argv the launcher actually builds, so editing one side
 * and not the other fails here instead of shipping a false claim.
 */
const CONSTRAINTS = new URL("../../../constraints.yaml", import.meta.url);

const flatValue = (text: string, key: string): string | undefined => {
  const m = new RegExp(`^\\s*${key}:\\s+(.+?)\\s*$`, "m").exec(text);
  return m?.[1]?.replace(/\\s+#.*$/, "").replace(/^"|"$/g, "").trim();
};

const isolationLimit = (text: string, key: string): string | undefined => {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^\s*isolation_limits:\s*$/.test(line));
  if (start === -1) return undefined;
  const indent = /^(\s*)/.exec(lines[start] ?? "")?.[1]?.length ?? 0;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const depth = /^(\s*)/.exec(line)?.[1]?.length ?? 0;
    if (depth <= indent) break;
    const m = /^\s*([a-z_]+):\s*(.+?)\s*$/.exec(line);
    if (m?.[1] === key && m[2]) return m[2].replace(/\s+#.*$/, "").replace(/^"|"$/g, "");
  }
  return undefined;
};

describe("P9d — constraints.yaml is measured, not aspirational", () => {
  const text = readFileSync(CONSTRAINTS, "utf8");
  const args = wrap().args;

  it("declares exactly the ceilings that reach docker", () => {
    expect(isolationLimit(text, "memory")).toBe(flagValue(args, "--memory"));
    expect(flagValue(args, "--memory-swap")).toBe(flagValue(args, "--memory"));
    expect(isolationLimit(text, "cpus")).toBe(flagValue(args, "--cpus"));
    expect(isolationLimit(text, "pids")).toBe(flagValue(args, "--pids-limit"));
    expect(isolationLimit(text, "user")).toBe(flagValue(args, "--user"));
    expect(isolationLimit(text, "network")).toBe(flagValue(args, "--network"));
  });

  it("declares the privilege facts that are flags rather than values", () => {
    expect(isolationLimit(text, "capabilities")).toBe("dropped_all");
    expect(flagValue(args, "--cap-drop")).toBe("ALL");
    expect(isolationLimit(text, "rootfs")).toBe("read_only");
    expect(args).toContain("--read-only");
    expect(flagValue(args, "--security-opt")).toBe("no-new-privileges");
  });

  it("names the same backend and default image", () => {
    expect(flatValue(text, "isolation_backend")).toBe("docker");
    expect(flatValue(text, "isolation_image")).toBe(DEFAULT_ISOLATION_IMAGE);
  });
});
