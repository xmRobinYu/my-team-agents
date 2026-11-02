import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PiAdapter } from "./adapter.js";
import { handoffExtensionPath } from "./handoff-extension.js";
import { piSkillDirs } from "./skills.js";
import type { RunSpec } from "@my-team-agents/runtime-core";

/**
 * I9 defect 2: an imported skill never reached Pi, because `start()` built its
 * args without `--skill` — and `<agentDir>/skills/` is not one of Pi's discovery
 * roots, so cwd-based discovery could not have saved it either. These tests pin
 * the fix (one `--skill <dir>` per loadable skill of the run's persona dir) and,
 * equally important, pin that a run WITHOUT skills produces byte-identical args,
 * so the generic adapter's behaviour cannot drift.
 */

const tempDir = mkdtempSync(join(tmpdir(), "pi-skills-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

/** `[slug, description]`: a `null` description omits the field entirely. */
type SkillFixture = Array<[slug: string, description: string | null]>;

const writePersona = (name: string, skills: SkillFixture): string => {
  const dir = join(tempDir, name);
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), `# ${name}\n`);
  for (const [slug, description] of skills) {
    mkdirSync(join(dir, "skills", slug), { recursive: true });
    writeFileSync(
      join(dir, "skills", slug, "SKILL.md"),
      `---\nname: ${slug}\n${description === null ? "version: 1.0.0" : `description: ${description}`}\n---\n\n# ${slug}\n`,
    );
  }
  return dir;
};

const loadable = (slug: string): [string, string] => [slug, `${slug} routing description.`];

type FakeChild = EventEmitter & {
  stdout: { setEncoding(): void; on(ev: "data", fn: (chunk: string) => void): void };
  stdin: { write(value: string): void };
  kill(): void;
  killed: boolean;
  exitCode: number | null;
};

/** Fake `pi`: records the exact argv + cwd, then streams a settled run. */
function fakeSpawn(): {
  spawn: typeof import("node:child_process").spawn;
  calls: Array<{ args: string[]; cwd: string | undefined }>;
} {
  const calls: Array<{ args: string[]; cwd: string | undefined }> = [];
  const spawn = ((_command: string, args: string[], options?: { cwd?: string }) => {
    calls.push({ args, cwd: options?.cwd });
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
  return { spawn, calls };
}

const baseSpec: RunSpec = {
  runId: "run-i9", tenantId: "t1", projectId: "p1", memberId: "m1",
  workspacePath: "/tmp/project", prompt: "ship it",
};

/** Run once with a recorded spawn; return the argv and the child cwd. */
const startWith = async (
  spec: RunSpec,
  options: {
    approveProjectResources?: boolean;
    extraArgs?: string[];
    handoffExtension?: boolean;
    isolatePersonaSessions?: boolean;
  } = {},
): Promise<{ args: string[]; cwd: string | undefined }> => {
  const { spawn, calls } = fakeSpawn();
  const handle = await new PiAdapter({
    approveProjectResources: options.approveProjectResources ?? true,
    spawn,
    ...(options.extraArgs ? { extraArgs: options.extraArgs } : {}),
    ...(options.handoffExtension === false ? { handoffExtension: false } : {}),
    ...(options.isolatePersonaSessions === false ? { isolatePersonaSessions: false } : {}),
  }).start(spec);
  for await (const _event of handle.events) { /* drain */ }
  await handle.settled;
  const call = calls[0];
  if (!call) throw new Error("pi was never spawned");
  return call;
};

describe("piSkillDirs", () => {
  it("returns the loadable skill dirs of a persona dir, sorted and absolute", () => {
    const dir = writePersona("discovery", [loadable("zeta"), loadable("alpha"), ["no-desc", null]]);
    expect(piSkillDirs(dir)).toEqual([join(dir, "skills", "alpha"), join(dir, "skills", "zeta")]);
  });

  it("treats an empty description the way Pi does: not loadable", () => {
    const dir = writePersona("empty-desc", [["blank", ""]]);
    expect(piSkillDirs(dir)).toEqual([]);
  });

  it("yields nothing for an undefined dir, a missing root, or an empty one", () => {
    expect(piSkillDirs(undefined)).toEqual([]);
    expect(piSkillDirs(join(tempDir, "does-not-exist"))).toEqual([]);
    expect(piSkillDirs(writePersona("bare", []))).toEqual([]);
  });

  it("skips a dir without SKILL.md, a bad slug, and a symlink (never followed)", () => {
    const dir = writePersona("skips", [loadable("good")]);
    mkdirSync(join(dir, "skills", "no-skill-md"), { recursive: true });
    writeFileSync(join(dir, "skills", "no-skill-md", "README.md"), "# nope\n");
    mkdirSync(join(dir, "skills", "Bad_Slug"), { recursive: true });
    writeFileSync(join(dir, "skills", "Bad_Slug", "SKILL.md"), `---\nname: Bad_Slug\ndescription: x\n---\n`);
    const outside = writePersona("outside-target", [loadable("victim")]);
    symlinkSync(join(outside, "skills", "victim"), join(dir, "skills", "linked"), "dir");

    expect(piSkillDirs(dir)).toEqual([join(dir, "skills", "good")]);
  });
});

describe("PiAdapter skill injection — AC8.2 / defect 2", () => {
  it("passes one repeatable --skill <dir> per loadable skill", async () => {
    const dir = writePersona("injected", [loadable("pdf-tools"), loadable("humanize-ppt")]);
    const { args, cwd } = await startWith({ ...baseSpec, agentDir: dir });
    expect(cwd).toBe(dir);
    expect(args).toEqual([
      "--mode", "rpc",
      // D3: a persona run isolates its sessions inside the persona dir.
      "--session-dir", join(dir, ".pi", "sessions"),
      "--approve",
      // D1: the handoff extension is declared before the skills.
      "--extension", handoffExtensionPath(),
      // Order pinned: skills come after the session/trust/model/thinking block.
      "--skill", join(dir, "skills", "humanize-ppt"),
      "--skill", join(dir, "skills", "pdf-tools"),
    ]);
  });

  it("injects from the persona dir only, never from workspacePath", async () => {
    const dir = writePersona("scoped", [loadable("mine")]);
    expect((await startWith({ ...baseSpec, agentDir: dir })).args).toContain("--skill");
    // The same spec without an agentDir has no skills to inject.
    expect((await startWith(baseSpec)).args).not.toContain("--skill");
  });

  it("never injects a skill Pi would refuse to load (missing description)", async () => {
    const dir = writePersona("inert", [loadable("real-skill"), ["no-description", null]]);
    const { args } = await startWith({ ...baseSpec, agentDir: dir });
    expect(args).toEqual([
      "--mode", "rpc",
      "--session-dir", join(dir, ".pi", "sessions"),
      "--approve",
      "--extension", handoffExtensionPath(),
      "--skill", join(dir, "skills", "real-skill"),
    ]);
    expect(args.join(" ")).not.toContain("no-description");
  });

  it("works under --no-approve too: the flag comes from agentDir, not project trust", async () => {
    const dir = writePersona("untrusted", [loadable("ppt-good")]);
    const { args } = await startWith({ ...baseSpec, agentDir: dir }, { approveProjectResources: false });
    expect(args).toEqual([
      "--mode", "rpc",
      "--session-dir", join(dir, ".pi", "sessions"),
      "--no-approve",
      "--extension", handoffExtensionPath(),
      "--skill", join(dir, "skills", "ppt-good"),
    ]);
    // An explicit `-e` path is exactly what survives `--no-extensions` and a
    // declined trust (pi --help), so the skills are not the only injection here.
  });
});

describe("regression — a Task with no skills keeps its exact command line", () => {
  /**
   * Byte-identical is the requirement: `PiAdapter` is the generic adapter, so
   * adding a feature must not perturb existing runs. Both an empty `skills/`
   * root (what the importer creates for a skill-less agent) and no persona dir at
   * all have to produce exactly these args.
   *
   * D1/D3 add `--extension` and `--session-dir`, so this pin is what the two
   * escape hatches (`handoffExtension: false`, `isolatePersonaSessions: false`)
   * still guarantee — the pre-I10 command line is reproducible, not overwritten.
   * `runtime-cli` never touches any of this: different adapter, different argv.
   */
  const expected = [
    "--mode", "rpc",
    "--session", "/tmp/sess/2026-01-01T00-00-00-000Z_run-i9.jsonl",
    "--no-approve",
    "--model", "anthropic/claude-sonnet-4-5",
    "--thinking", "high",
    "--tools", "read,grep",
  ];

  const build = (agentDir?: string): RunSpec => ({
    ...baseSpec,
    ...(agentDir ? { agentDir } : {}),
    model: "anthropic/claude-sonnet-4-5",
    thinking: "high",
    session: {
      sessionId: "run-i9",
      sessionDir: "/tmp/sess",
      sessionPath: "/tmp/sess/2026-01-01T00-00-00-000Z_run-i9.jsonl",
      resume: true,
    },
  });

  const capture = async (spec: RunSpec): Promise<string[]> =>
    (await startWith(spec, {
      extraArgs: ["--tools", "read,grep"],
      approveProjectResources: false,
      handoffExtension: false,
      isolatePersonaSessions: false,
    })).args;

  it("no agentDir -> unchanged args", async () => {
    const args = await capture(build());
    expect(args).toEqual(expected);
    expect(args).not.toContain("--skill");
    expect(args).not.toContain("--extension");
    expect(args).not.toContain("--session-dir");
  });

  it("agentDir with an empty skills root -> byte-identical args", async () => {
    const withEmptyRoot = await capture({ ...build(), agentDir: writePersona("skillless", []) });
    // A persona dir with no skills/ directory at all behaves the same way.
    const bare = join(tempDir, "no-skills-dir");
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, "AGENTS.md"), "# bare\n");
    const withoutRoot = await capture({ ...build(), agentDir: bare });
    expect(withEmptyRoot).toEqual(expected);
    expect(withoutRoot).toEqual(expected);
    expect(withEmptyRoot).toEqual(withoutRoot);
  });

  it("cwd still prefers agentDir over workspacePath when skills are present", async () => {
    const dir = writePersona("cwd-check", [loadable("one")]);
    const { cwd, args } = await startWith({ ...baseSpec, agentDir: dir });
    expect(cwd).toBe(dir);
    expect(args).toContain("--skill");
  });
});
