import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ExecutionStore, RoomStore } from "@my-team-agents/orchestrator";
import { buildApp } from "./app.js";

/**
 * AC8.1/AC8.3 over HTTP. Same harness shape as `room-routes.test.ts`: an
 * ExecutionStore + RoomStore on one handle, `buildApp`, then `inject` — no
 * listening socket, so these are ordinary unit-speed tests.
 */

const worker = {
  async runOnce() { return false; },
  recoverExpired() { return 0; },
  requestCancel(taskId: string) { return { affected: 0, attemptId: taskId }; },
};

interface Listing {
  agentId: string;
  agentName: string;
  skillsRoot: string;
  skillsRootExists: boolean;
  injectedPaths: string[];
  skills: Array<{
    slug: string; name: string; description: string | null; path: string;
    files: Array<{ path: string; bytes: number }>;
    loadable: boolean; verdict: string;
    issues: Array<{ code: string; message: string }>;
  }>;
  warnings: Array<{ code: string; message: string }>;
  error?: string;
  code?: string;
}

const tempDir = mkdtempSync(join(tmpdir(), "skill-routes-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

const skillMd = (slug: string, description = `${slug} routing description.`) =>
  `---\nname: ${slug}\ndescription: ${description}\n---\n\n# ${slug}\n`;

/** One room, two agents, each with a persona dir that looks like a real import. */
const harness = async (name: string) => {
  const base = join(tempDir, name);
  mkdirSync(base, { recursive: true });
  const store = new ExecutionStore(join(base, "exec.sqlite"));
  const rooms = new RoomStore(store.db);
  const app = await buildApp({ store, worker, rooms, roomsRoot: join(base, ".rooms") });
  const room = rooms.createRoom({ projectId: "p1", name: "研发群", description: "", rules: "", coordinatorAgentId: null }, 1);
  const dir = join(base, ".rooms/room-1/agents/arch");
  mkdirSync(join(dir, "skills", "pdf-tools", "scripts"), { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), "# 架构师\n");
  writeFileSync(join(dir, "skills", "pdf-tools", "SKILL.md"),
    skillMd("pdf-tools", "Extract text and tables from PDF files."));
  writeFileSync(join(dir, "skills", "pdf-tools", "scripts", "extract.sh"), "#!/bin/sh\n");
  // installed but inert — the case a naive listing would hide
  mkdirSync(join(dir, "skills", "nodesc"), { recursive: true });
  writeFileSync(join(dir, "skills", "nodesc", "SKILL.md"), "---\nname: nodesc\nversion: 1.0.0\n---\n# nodesc\n");
  const arch = rooms.addAgent({ roomId: room.id, name: "架构师", prompt: "design", agentDir: dir }, 2);
  const emptyDir = join(base, ".rooms/room-1/agents/qa");
  mkdirSync(emptyDir, { recursive: true });
  writeFileSync(join(emptyDir, "AGENTS.md"), "# QA\n");
  const qa = rooms.addAgent({ roomId: room.id, name: "QA", prompt: "test", agentDir: emptyDir }, 3);
  const url = (agentId: string, slug?: string) =>
    `/api/rooms/${room.id}/agents/${agentId}/skills${slug ? `/${slug}` : ""}`;
  const close = async () => { await app.close(); rooms.close(); store.close(); };
  return { app, room, arch, qa, dir, emptyDir, url, close };
};

describe("GET /api/rooms/:id/agents/:agentId/skills — AC8.1", () => {
  it("lists slug, name, description, path and the file manifest", async () => {
    const h = await harness("list");
    const res = await h.app.inject({ method: "GET", url: h.url(h.arch.id) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Listing;
    expect(body.agentName).toBe("架构师");
    expect(body.skillsRoot).toBe(join(h.dir, "skills"));
    const pdf = body.skills.find((s) => s.slug === "pdf-tools");
    expect(pdf).toMatchObject({
      name: "pdf-tools",
      description: "Extract text and tables from PDF files.",
      loadable: true,
      path: join(h.dir, "skills", "pdf-tools"),
    });
    expect(pdf?.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "scripts/extract.sh"]);
    // the injected set is exactly the loadable one, and the inert skill is not in it
    expect(body.injectedPaths).toEqual([join(h.dir, "skills", "pdf-tools")]);
    await h.close();
  });

  it("marks a description-less skill visible-but-inert instead of hiding it", async () => {
    const h = await harness("inert");
    const body = (await h.app.inject({ method: "GET", url: h.url(h.arch.id) })).json() as Listing;
    const nodesc = body.skills.find((s) => s.slug === "nodesc");
    expect(nodesc?.loadable).toBe(false);
    expect(nodesc?.verdict).toBe("missing-description");
    expect(nodesc?.issues[0]?.message).toContain("看得见");
    expect(body.injectedPaths).not.toContain(join(h.dir, "skills", "nodesc"));
    await h.close();
  });

  it("an agent without a skills dir is 200 with an empty list, not 404", async () => {
    const h = await harness("none");
    const res = await h.app.inject({ method: "GET", url: h.url(h.qa.id) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Listing;
    expect(body.skills).toEqual([]);
    expect(body.skillsRootExists).toBe(false);
    expect(existsSync(join(h.emptyDir, "skills"))).toBe(false); // a GET never writes
    await h.close();
  });

  it("unknown room or unknown agent is 404", async () => {
    const h = await harness("404");
    expect((await h.app.inject({ method: "GET", url: "/api/rooms/nope/agents/x/skills" })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: h.url("no-such-agent") })).statusCode).toBe(404);
    await h.close();
  });

  it("does not disturb the existing /api/rooms surface", async () => {
    const h = await harness("coexist");
    expect((await h.app.inject({ method: "GET", url: "/api/rooms" })).statusCode).toBe(200);
    const agents = await h.app.inject({ method: "GET", url: `/api/rooms/${h.room.id}/agents` });
    expect(agents.statusCode).toBe(200);
    expect((agents.json() as unknown[]).length).toBe(2);
    expect((await h.app.inject({ method: "GET", url: "/api/tasks" })).statusCode).toBe(200);
    await h.close();
  });
});

describe("POST /api/rooms/:id/agents/:agentId/skills — AC8.3 install", () => {
  it("installs a skill and lists it as loadable", async () => {
    const h = await harness("install");
    const res = await h.app.inject({
      method: "POST", url: h.url(h.qa.id),
      payload: {
        slug: "browser-use",
        files: [
          { path: "SKILL.md", content: skillMd("browser-use", "Drive a real browser to click and read pages.") },
          { path: "references/actions.md", content: "# actions\n" },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { path: string; replaced: boolean; listing: { loadable: boolean } };
    expect(body.path).toBe(join(h.emptyDir, "skills", "browser-use"));
    expect(body.replaced).toBe(false);
    expect(body.listing?.loadable).toBe(true);
    expect(readFileSync(join(h.emptyDir, "skills", "browser-use", "SKILL.md"), "utf8")).toContain("browser-use");
    // the persona's own AGENTS.md is untouched
    expect(readFileSync(join(h.emptyDir, "AGENTS.md"), "utf8")).toBe("# QA\n");
    await h.close();
  });

  it("refuses a duplicate slug with 409 unless overwrite is explicit", async () => {
    const h = await harness("dup");
    const payload = (content: string) => ({ slug: "pdf-tools", files: [{ path: "SKILL.md", content }] });
    const first = await h.app.inject({ method: "POST", url: h.url(h.arch.id), payload: payload("# new\n") });
    expect(first.statusCode).toBe(409);
    expect((first.json() as { code: string }).code).toBe("SKILL_EXISTS");
    expect(readFileSync(join(h.dir, "skills", "pdf-tools", "SKILL.md"), "utf8")).toContain("Extract text");

    const forced = await h.app.inject({
      method: "POST", url: h.url(h.arch.id), payload: { ...payload("# replaced\n"), overwrite: true },
    });
    expect(forced.statusCode).toBe(200);
    expect((forced.json() as { replaced: boolean }).replaced).toBe(true);
    expect(readFileSync(join(h.dir, "skills", "pdf-tools", "SKILL.md"), "utf8")).toBe("# replaced\n");
    await h.close();
  });

  it("rejects an invalid slug with 400 before any filesystem write", async () => {
    const h = await harness("bad-slug");
    for (const slug of ["..", "../../etc", "PDF-Tools", "a_b", "", "-lead", "x".repeat(65)]) {
      const res = await h.app.inject({
        method: "POST", url: h.url(h.qa.id),
        payload: { slug, files: [{ path: "SKILL.md", content: "# x\n" }] },
      });
      expect(res.statusCode, slug).toBe(400);
      expect((res.json() as { code: string }).code, slug).toBe("SKILL_SLUG_INVALID");
    }
    expect(existsSync(join(h.emptyDir, "skills"))).toBe(false);
    await h.close();
  });

  it("rejects a file path that would escape the skill dir", async () => {
    const h = await harness("bad-file");
    for (const path of ["../AGENTS.md", "a/../../b.md", "/etc/passwd", "..\\escape.md"]) {
      const res = await h.app.inject({
        method: "POST", url: h.url(h.qa.id),
        payload: { slug: "ok-skill", files: [{ path, content: "# x\n" }, { path: "SKILL.md", content: "# s\n" }] },
      });
      expect(res.statusCode, path).toBe(400);
      expect((res.json() as { code: string }).code, path).toBe("SKILL_FILE_INVALID");
    }
    expect(existsSync(join(h.emptyDir, "escape.md"))).toBe(false);
    expect(readFileSync(join(h.emptyDir, "AGENTS.md"), "utf8")).toBe("# QA\n");
    await h.close();
  });

  it("refuses a payload without SKILL.md — an install that could never load", async () => {
    const h = await harness("no-skill-md");
    const res = await h.app.inject({
      method: "POST", url: h.url(h.qa.id),
      payload: { slug: "docs-only", files: [{ path: "README.md", content: "# nope\n" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(existsSync(join(h.emptyDir, "skills", "docs-only"))).toBe(false);
    await h.close();
  });

  it("needs files at all", async () => {
    const h = await harness("no-files");
    expect((await h.app.inject({ method: "POST", url: h.url(h.qa.id), payload: { slug: "x" } })).statusCode).toBe(400);
    await h.close();
  });
});

describe("DELETE /api/rooms/:id/agents/:agentId/skills/:slug — AC8.3 uninstall", () => {
  it("removes one skill directory and leaves the persona dir intact", async () => {
    const h = await harness("uninstall");
    const res = await h.app.inject({ method: "DELETE", url: h.url(h.arch.id, "pdf-tools") });
    expect(res.statusCode).toBe(200);
    expect(existsSync(join(h.dir, "skills", "pdf-tools"))).toBe(false);
    expect(existsSync(join(h.dir, "skills", "nodesc"))).toBe(true);
    expect(readFileSync(join(h.dir, "AGENTS.md"), "utf8")).toContain("# 架构师");
    await h.close();
  });

  it("a skill that is not installed is 404, not a silent success", async () => {
    const h = await harness("uninstall-404");
    const res = await h.app.inject({ method: "DELETE", url: h.url(h.arch.id, "not-here") });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("SKILL_NOT_FOUND");
    // and the intended victim is still there, which is the point of 404
    expect(existsSync(join(h.dir, "skills", "pdf-tools"))).toBe(true);
    await h.close();
  });

  it("path traversal is refused, and nothing in the tree is harmed", async () => {
    const h = await harness("traversal");
    // Two legitimate rejection layers, kept apart on purpose:
    //  - Fastify's router refuses a param that normalises away (`..`, `%2E%2E`):
    //    404 from the framework, no `code`, the handler never runs;
    //  - anything reaching the handler is refused by the slug whitelist or by the
    //    `skillDirOf()` containment check: 4xx with an explicit code.
    // What must never happen is a 2xx delete outside this agent's skills root.
    const attempts = [
      "%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc", // ../../../../etc
      "..%2Fskills",
      "..%2F..%2Fetc",
      "pdf-tools%2F..%2F..%2F..%2Fagents",
      "%2e",
      "..",
      "%2E%2E",
      "not-here",
    ];
    for (const raw of attempts) {
      const res = await h.app.inject({ method: "DELETE", url: `${h.url(h.arch.id)}/${raw}` });
      expect([200, 201, 202, 204], `${raw} -> ${res.statusCode}`).not.toContain(res.statusCode);
      expect(res.statusCode, raw).toBeLessThan(500);
      const code = (res.json() as { code?: string }).code;
      if (code === undefined) {
        expect(res.statusCode, `${raw} refused by the router itself`).toBe(404);
      } else {
        expect(["SKILL_SLUG_INVALID", "SKILL_PATH_ESCAPE", "SKILL_NOT_FOUND"], `${raw}: ${code}`)
          .toContain(code);
      }
    }
    // the whole persona tree survives every attempt
    expect(existsSync(join(h.dir, "skills", "pdf-tools", "SKILL.md"))).toBe(true);
    expect(existsSync(join(h.dir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(tempDir, "traversal", ".rooms", "room-1", "agents", "qa", "AGENTS.md"))).toBe(true);
    await h.close();
  });

  it("a room/agent mismatch cannot delete another room's skill", async () => {
    const h = await harness("cross-room");
    const res = await h.app.inject({ method: "DELETE", url: `/api/rooms/other-room/agents/${h.arch.id}/skills/pdf-tools` });
    expect(res.statusCode).toBe(404);
    expect(existsSync(join(h.dir, "skills", "pdf-tools"))).toBe(true);
    await h.close();
  });
});
