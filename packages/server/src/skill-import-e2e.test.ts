import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importTemplatePackage, listAgentSkills, runSkillPaths, RoomStore, type ImportResult } from "@my-team-agents/orchestrator";
import { piSkillDirs, PiAdapter } from "@my-team-agents/runtime-pi";

/**
 * I9's coupling test — the one place where BOTH sides of the skill convention are
 * imported, because the defect was a disagreement between them:
 *
 *  - `template-import.ts` landed skills in `<agentDir>/skills/<slug>/`.
 *  - `runtime-pi` never told Pi about that directory, and Pi's project discovery
 *    roots are `.pi/skills/` / `.agents/skills/` (docs/configuration.md:35,
 *    docs/skills.md:61), so the files were inert (defect 1 + defect 2).
 *
 * A test inside one package can only assert its own half. This asserts the
 * contract: the importer's layout, the API listing's `loadable` set and the argv
 * `PiAdapter` builds are three readings of ONE fact. When they agree AC8.2 is
 * true; if a future refactor moves either side alone, this fails.
 *
 * The real-`pi` case at the bottom is the end-to-end proof and is opt-in
 * (`MTA_REAL_PI=1`), like `just pi-smoke`: it needs the installed binary and is
 * deliberately out of CI. It runs with an isolated `HOME`/`PI_CODING_AGENT_DIR`,
 * so the operator's own `~/.pi/agent/skills` cannot make it pass by accident.
 */

const tempDir = mkdtempSync(join(tmpdir(), "i9-e2e-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

const TEMPLATES = join(process.cwd(), "ref", "teamagentx-templates");
/** `全栈软件研发` ships NO skills (verified: 5 zip entries, none under `skills/`),
 *  so the package that can prove the landing path is `PPT-演示创作`: 5 skills. */
const REAL_ZIP = join(TEMPLATES, "PPT-演示创作-2026-06-03.zip");

let imported: ImportResult;
beforeAll(() => {
  expect(existsSync(REAL_ZIP), `${REAL_ZIP} is missing (ref/ is an untracked tree)`).toBe(true);
  const store = new RoomStore(join(tempDir, "rooms.sqlite"));
  imported = importTemplatePackage({
    zip: new Uint8Array(readFileSync(REAL_ZIP)),
    store,
    projectId: "my-team-agents",
    roomsRoot: join(tempDir, ".rooms"),
  });
  store.close();
});

const firstAgentWithSkills = (): { agentDir: string; dirs: string[] } | null => {
  for (const agent of imported.agents) {
    const dirs = piSkillDirs(agent.agentDir);
    if (dirs.length > 0) return { agentDir: agent.agentDir, dirs };
  }
  return null;
};

describe("importer → listing → spawn args are one fact", () => {
  it("imports the real package with skills on more than one agent", () => {
    expect(imported.agents).toHaveLength(7);
    const withSkills = imported.agents.filter((a) => a.agentDir && listAgentSkills(a.agentDir).skills.length > 0);
    expect(withSkills.length).toBeGreaterThan(1);
    expect(firstAgentWithSkills()).not.toBeNull();
  });

  it("each agent's loadable listing is exactly what a run injects", () => {
    let skillsSeen = 0;
    for (const agent of imported.agents) {
      const listed = listAgentSkills(agent.agentDir);
      // Same directory, same rule, three entry points: they must not disagree.
      expect(piSkillDirs(agent.agentDir), agent.name)
        .toEqual(listed.skills.filter((s) => s.loadable).map((s) => s.path));
      expect(runSkillPaths(agent.agentDir), agent.name).toEqual(piSkillDirs(agent.agentDir));
      for (const skill of listed.skills) {
        expect(skill.path, agent.name).toBe(join(agent.agentDir, "skills", skill.slug));
        skillsSeen += 1;
      }
    }
    expect(skillsSeen, "the PPT package must land skills").toBeGreaterThan(10);
  });

  it("PiAdapter's argv names every injected skill directory", async () => {
    const found = firstAgentWithSkills();
    if (!found) throw new Error("no imported agent had a loadable skill");

    const argv: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      argv.push(...args);
      // Never resolves: this test reads argv only. The iterator is closed below.
      return {
        stdout: { setEncoding: () => {}, on: () => {} },
        stdin: { write: () => {} },
        kill: () => {},
        on: () => {},
      } as never;
    }) as unknown as ConstructorParameters<typeof PiAdapter>[0]["spawn"];

    const handle = await new PiAdapter({ approveProjectResources: true, spawn }).start({
      runId: "e2e-argv", tenantId: "t", projectId: "p", memberId: "m",
      workspacePath: tempDir, agentDir: found.agentDir, prompt: "hi",
    });
    void handle.settled.catch(() => undefined);
    expect(argv).toContain("--skill");
    for (const dir of found.dirs) expect(argv, dir).toContain(dir);
  });
});

const piAvailable = (() => {
  try {
    execFileSync("pi", ["--version"], { stdio: "pipe", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
})();

/**
 * End-to-end against the real binary: start Pi exactly the way `PiAdapter` does
 * (cwd = persona dir, `--mode rpc`, `--no-approve`, one `--skill` per loadable
 * dir) and ask it what it loaded. `get_commands` is answered from the loaded
 * resource set (docs/rpc-commands.md:786-832), so a skill appears there ONLY if
 * Pi parsed its `SKILL.md` and accepted it — a directory missing a
 * `description` would stay absent even though it is on disk and named in argv.
 */
describe.skipIf(!process.env.MTA_REAL_PI || !piAvailable)(
  "real pi binary loads the imported skills",
  () => {
    it("get_commands reports each injected persona skill as skill:<name>", async () => {
      const found = firstAgentWithSkills();
      if (!found) throw new Error("no imported agent had a loadable skill");

      const home = join(tempDir, "pi-home");
      rmSync(home, { recursive: true, force: true });
      // Isolated agent dir: without this the operator's own ~/.pi/agent/skills
      // would answer the question for us and the test would prove nothing.
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });

      const { spawn } = await import("node:child_process");
      const args = ["--mode", "rpc", "--no-approve", "--no-session",
        ...found.dirs.flatMap((d) => ["--skill", d])];
      const child = spawn("pi", args, {
        cwd: found.agentDir,
        env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_OFFLINE: "1" },
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      let out = "";
      let err = "";
      const reply = new Promise<string>((resolve, reject) => {
        child.stdout.on("data", (chunk: string) => {
          out += chunk;
          if (out.includes('"command":"get_commands"')) {
            child.kill("SIGKILL");
            resolve(out);
          }
        });
        child.stderr.on("data", (chunk: string) => { err += chunk; });
        child.on("exit", (code) => {
          if (!out.includes('"command":"get_commands"')) {
            reject(new Error(`pi exited ${code}\nargv: ${args.join(" ")}\nstderr: ${err.slice(-2000)}\nstdout: ${out.slice(-4000)}`));
          }
        });
        child.stdin.write(`${JSON.stringify({ id: "c1", type: "get_commands" })}\n`);
      });

      const body = await reply;
      const loaded = [...body.matchAll(/"name":"(skill:[^"]+)"/g)].map((m) => m[1] ?? "");
      for (const dir of found.dirs) {
        const declared = /^name:\s*(.+)$/m.exec(readFileSync(join(dir, "SKILL.md"), "utf8"))?.[1]?.trim();
        const name = declared && declared.length > 0 ? declared : dir.split("/").pop();
        expect(loaded, `${name} from ${dir}`).toContain(`skill:${name}`);
      }
      // Nothing was discovered from cwd that we did not inject: the persona dir
      // has no `.pi/skills` and no `.agents/skills`, and trust is declined.
      expect(loaded.length).toBe(found.dirs.length);
    }, 120_000);
  },
);
