import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  agentSkillsRoot,
  assertSkillSlug,
  installSkill,
  listAgentSkills,
  runSkillPaths,
  skillDirOf,
  SkillError,
  uninstallSkill,
} from "./skills.js";

/**
 * I9: skill layout, the loadable / not-loadable verdict, install and uninstall.
 *
 * Fixtures mirror what a real package produces (`<slug>/SKILL.md` plus supporting
 * files) and the two shapes that LOOK installed but are inert, because those are
 * invisible in a naive file listing — which is the failure mode AC8.1 must expose.
 */

const tempDir = mkdtempSync(join(tmpdir(), "skills-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

let seq = 0;
const persona = (files: Record<string, string>): string => {
  const dir = join(tempDir, `agent-${(seq += 1)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), "# persona\n\n规则...\n");
  for (const [rel, text] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return dir;
};

const skillMd = (slug: string, description = `${slug} does one specific thing.`) =>
  `---\nname: ${slug}\ndescription: ${description}\n---\n\n# ${slug}\nRead \`references/x.md\`.\n`;

/** Capture the SkillError a call raises, so `.code` can be asserted. */
const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof SkillError ? err.code : `NOT_SKILL_ERROR: ${String(err)}`;
  }
};

describe("slug whitelist", () => {
  /**
   * The whitelist is exactly I9's mandated pattern. It is deliberately LOOSER
   * than Pi's full name rule on one axis: `trailing-` and `con--secutive` pass it
   * but Pi warns about them (docs/skills.md:81 forbids leading/trailing/
   * consecutive hyphens). Refusing them at the door would reject a skill that
   * does load, so instead the listing reports `invalid-name` while keeping
   * `loadable: true` — asserted in the next case.
   */
  it("accepts the mandated pattern and rejects everything else", () => {
    for (const ok of ["a", "pdf-tools", "x9", "x-", "a".repeat(64), "trailing-", "con--secutive"]) {
      expect(() => assertSkillSlug(ok), ok).not.toThrow();
    }
    for (const bad of [
      "PDF-Tools", "-leading", "a_b", "../evil", "a".repeat(65), "", "with space",
      "中文技能", "/abs/path", "skill.json", "..", ".", "a/../../b",
    ]) {
      expect(() => assertSkillSlug(bad), bad).toThrow(/SKILL_SLUG_INVALID/);
    }
    expect(() => assertSkillSlug(undefined)).toThrow(/SKILL_SLUG_INVALID/);
    expect(() => assertSkillSlug(42 as unknown)).toThrow(/SKILL_SLUG_INVALID/);
  });

  it("warns about a hyphen-shaped slug but still treats it as loadable", () => {
    const dir = persona({
      "skills/trailing-/SKILL.md": "---\nname: trailing-\ndescription: Real description.\n---\n# x\n",
    });
    const [skill] = listAgentSkills(dir).skills;
    expect(skill?.loadable).toBe(true); // Pi loads it, with a warning
    expect(skill?.issues.map((i) => i.code)).toContain("invalid-name");
    expect(runSkillPaths(dir)).toEqual([join(dir, "skills", "trailing-")]);
  });

  it("resolves a skill dir strictly inside the agent's own skills root", () => {
    const dir = persona({ "skills/pdf-tools/SKILL.md": skillMd("pdf-tools") });
    const resolved = skillDirOf(dir, "pdf-tools");
    expect(resolved).toBe(join(agentSkillsRoot(dir), "pdf-tools"));
    expect(resolved.startsWith(`${agentSkillsRoot(dir)}/`)).toBe(true);
  });
});

describe("listAgentSkills — AC8.1", () => {
  it("lists slug, name, description, path and the file manifest", () => {
    const dir = persona({
      "skills/pdf-tools/SKILL.md": skillMd("pdf-tools", "Extract text and tables from PDF files."),
      "skills/pdf-tools/scripts/extract.sh": "#!/bin/sh\necho hi\n",
      "skills/pdf-tools/references/formats.md": "# formats\n",
    });
    const listing = listAgentSkills(dir);
    expect(listing.skillsRootExists).toBe(true);
    expect(listing.skills).toHaveLength(1);
    const skill = listing.skills[0]!;
    expect(skill).toMatchObject({
      slug: "pdf-tools",
      name: "pdf-tools",
      description: "Extract text and tables from PDF files.",
      path: join(dir, "skills", "pdf-tools"),
      skillFile: join(dir, "skills", "pdf-tools", "SKILL.md"),
      loadable: true,
      verdict: "loadable",
    });
    expect(skill.files.map((f) => f.path).sort()).toEqual([
      "SKILL.md", "references/formats.md", "scripts/extract.sh",
    ]);
    expect(skill.issues).toEqual([]);
  });

  it("an agent without a skills dir is an empty listing, not an error", () => {
    const dir = persona({});
    const listing = listAgentSkills(dir);
    expect(listing.skillsRootExists).toBe(false);
    expect(listing.skills).toEqual([]);
    // A read endpoint must not create what it reads.
    expect(existsSync(join(dir, "skills"))).toBe(false);
  });

  it("a directory without SKILL.md is listed and marked inert", () => {
    const dir = persona({ "skills/broken/README.md": "# not a skill\n" });
    const [skill] = listAgentSkills(dir).skills;
    expect(skill?.loadable).toBe(false);
    expect(skill?.verdict).toBe("missing-skill-md");
    expect(skill?.issues.map((i) => i.code)).toContain("missing-skill-md");
    expect(skill?.description).toBeNull();
    expect(runSkillPaths(dir)).toEqual([]);
  });

  it("a SKILL.md with no frontmatter is listed and marked inert", () => {
    const dir = persona({ "skills/plain/SKILL.md": "# 平文本技能\n没有 frontmatter\n" });
    const [skill] = listAgentSkills(dir).skills;
    expect(skill?.loadable).toBe(false);
    expect(skill?.verdict).toBe("no-frontmatter");
    expect(skill?.issues.map((i) => i.code)).toContain("no-frontmatter");
    expect(skill?.issues[0]?.message).toContain("Pi 不会加载它");
    expect(runSkillPaths(dir)).toEqual([]);
  });

  it("a missing description is flagged as visible-but-inert, Pi's own rule", () => {
    const dir = persona({ "skills/nodesc/SKILL.md": "---\nname: nodesc\nversion: 1.0.0\n---\n\n# nodesc\n" });
    const [skill] = listAgentSkills(dir).skills;
    expect(skill?.loadable).toBe(false);
    expect(skill?.verdict).toBe("missing-description");
    expect(skill?.issues.map((i) => i.code)).toContain("missing-description");
    expect(skill?.issues[0]?.message).toContain("看得见");
    // and it is therefore never injected
    expect(runSkillPaths(dir)).toEqual([]);
  });

  it("reports a name/dir mismatch and an invalid declared name instead of hiding them", () => {
    const mismatch = persona({
      "skills/dir-name/SKILL.md": "---\nname: other-name\ndescription: Real description.\n---\n# x\n",
    });
    const [m] = listAgentSkills(mismatch).skills;
    expect(m?.loadable).toBe(true); // Pi loads it — under `other-name`
    expect(m?.name).toBe("other-name");
    expect(m?.issues.map((i) => i.code)).toContain("name-mismatch");

    const badName = persona({
      "skills/good-slug/SKILL.md": "---\nname: Bad_Name\ndescription: Real description.\n---\n# x\n",
    });
    const [b] = listAgentSkills(badName).skills;
    expect(b?.loadable).toBe(true);
    expect(b?.issues.map((i) => i.code)).toContain("invalid-name");
  });

  it("surfaces disable-model-invocation and an over-long description", () => {
    const dir = persona({
      "skills/hidden/SKILL.md":
        "---\nname: hidden\ndescription: Real description.\ndisable-model-invocation: true\n---\n# x\n",
      "skills/verbose/SKILL.md": `---\nname: verbose\ndescription: ${"x".repeat(1100)}\n---\n# y\n`,
    });
    const listing = listAgentSkills(dir);
    const hidden = listing.skills.find((s) => s.slug === "hidden");
    expect(hidden?.loadable).toBe(true);
    expect(hidden?.issues.map((i) => i.code)).toContain("model-invocation-disabled");
    const verbose = listing.skills.find((s) => s.slug === "verbose");
    expect(verbose?.issues.map((i) => i.code)).toContain("description-too-long");
    expect(verbose?.loadable).toBe(true);
  });

  it("refuses to treat a directory named outside the slug rule as a skill", () => {
    const dir = persona({
      "skills/Bad_Name/SKILL.md": skillMd("Bad_Name"),
      "skills/ok-skill/SKILL.md": skillMd("ok-skill"),
    });
    const listing = listAgentSkills(dir);
    expect(listing.skills.map((s) => s.slug)).toEqual(["ok-skill"]);
    expect(listing.warnings.map((w) => w.code)).toContain("invalid-slug-dir");
    expect(runSkillPaths(dir)).toEqual([join(dir, "skills", "ok-skill")]);
  });

  it("names loose markdown under skills/ instead of ignoring it", () => {
    const dir = persona({ "skills/notes.md": "---\nname: notes\ndescription: x\n---\n" });
    const listing = listAgentSkills(dir);
    expect(listing.skills).toEqual([]);
    expect(listing.warnings.map((w) => w.code)).toContain("loose-markdown");
  });

  it("never follows a symlinked skill dir, but reports it", () => {
    const outside = persona({ "victim/SKILL.md": skillMd("victim") });
    const dir = join(tempDir, "symlink-listing");
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "# persona\n");
    symlinkSync(join(outside, "victim"), join(dir, "skills", "linked"), "dir");

    const listing = listAgentSkills(dir);
    expect(listing.skills).toEqual([]);
    expect(listing.warnings.map((w) => w.code)).toContain("symlink-dir");
    expect(runSkillPaths(dir)).toEqual([]);
  });

  it("runSkillPaths returns only loadable dirs, sorted", () => {
    const dir = persona({
      "skills/zeta/SKILL.md": skillMd("zeta"),
      "skills/alpha/SKILL.md": skillMd("alpha"),
      "skills/mid/SKILL.md": "---\nname: mid\n---\n# mid\n",
    });
    expect(runSkillPaths(dir)).toEqual([join(dir, "skills", "alpha"), join(dir, "skills", "zeta")]);
  });
});

describe("installSkill — AC8.3", () => {
  it("installs into <agentDir>/skills/<slug>/ and leaves the rest of the dir alone", () => {
    const dir = persona({});
    const installed = installSkill({
      agentDir: dir,
      slug: "pdf-tools",
      files: [
        { path: "SKILL.md", content: skillMd("pdf-tools") },
        { path: "references/formats.md", content: "# formats\n" },
      ],
    });
    expect(installed).toMatchObject({ slug: "pdf-tools", replaced: false });
    expect(installed.path).toBe(join(dir, "skills", "pdf-tools"));
    expect(readFileSync(join(dir, "skills", "pdf-tools", "SKILL.md"), "utf8")).toContain("pdf-tools");
    expect(existsSync(join(dir, "skills", "pdf-tools", "references", "formats.md"))).toBe(true);
    // what was just installed is listed as loadable and is injected
    expect(runSkillPaths(dir)).toEqual([installed.path]);
    expect(readdirSync(dir).sort()).toEqual(["AGENTS.md", "skills"]);
  });

  it("refuses a duplicate slug unless overwrite is explicit", () => {
    const dir = persona({ "skills/pdf-tools/SKILL.md": skillMd("pdf-tools") });
    expect(codeOf(() => installSkill({
      agentDir: dir,
      slug: "pdf-tools",
      files: [{ path: "SKILL.md", content: "# replaced\n" }],
    }))).toBe("SKILL_EXISTS");
    expect(readFileSync(join(dir, "skills", "pdf-tools", "SKILL.md"), "utf8")).toContain("description");

    const replaced = installSkill({
      agentDir: dir,
      slug: "pdf-tools",
      files: [{ path: "SKILL.md", content: "# replaced\n" }],
      overwrite: true,
    });
    expect(replaced.replaced).toBe(true);
    expect(readFileSync(join(dir, "skills", "pdf-tools", "SKILL.md"), "utf8")).toBe("# replaced\n");
  });

  it("rejects an invalid slug before touching the filesystem", () => {
    const dir = persona({});
    for (const bad of ["../evil", "Bad", "a_b", "", "-x", "a/../../b", "..", "/etc"]) {
      expect(codeOf(() => installSkill({
        agentDir: dir,
        slug: bad,
        files: [{ path: "SKILL.md", content: "# x\n" }],
      })), bad).toBe("SKILL_SLUG_INVALID");
    }
    expect(existsSync(join(dir, "skills"))).toBe(false);
  });

  it("rejects a file path that would escape the skill directory", () => {
    const dir = persona({});
    for (const bad of [
      "../AGENTS.md", "references/../../escape.md", "/etc/passwd", "a//b.md",
      "..\\escape.md", "SKILL.md/../x.md", "",
    ]) {
      expect(codeOf(() => installSkill({
        agentDir: dir,
        slug: "pdf-tools",
        files: [{ path: bad, content: "# x\n" }, { path: "SKILL.md", content: "# ok\n" }],
      })), bad).toBe("SKILL_FILE_INVALID");
    }
    // nothing half-written; the persona's own AGENTS.md untouched
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("# persona");
    expect(existsSync(join(dir, "skills", "pdf-tools"))).toBe(false);
    expect(existsSync(join(dir, "escape.md"))).toBe(false);
  });

  it("normalises a redundant ./ prefix instead of treating it as an attack", () => {
    const dir = persona({});
    const installed = installSkill({
      agentDir: dir,
      slug: "pdf-tools",
      files: [{ path: "./SKILL.md", content: skillMd("pdf-tools") }],
    });
    expect(installed.files).toEqual(["SKILL.md"]);
    expect(existsSync(join(dir, "skills", "pdf-tools", "SKILL.md"))).toBe(true);
  });

  it("refuses a payload without SKILL.md — installing it would do nothing", () => {
    const dir = persona({});
    expect(codeOf(() => installSkill({
      agentDir: dir,
      slug: "pdf-tools",
      files: [{ path: "README.md", content: "# no skill here\n" }],
    }))).toBe("SKILL_FILE_INVALID");
  });

  it("requires an existing persona dir", () => {
    expect(codeOf(() => installSkill({
      agentDir: join(tempDir, "no-such-agent"),
      slug: "pdf-tools",
      files: [{ path: "SKILL.md", content: "# x\n" }],
    }))).toBe("AGENT_DIR_MISSING");
  });
});

describe("uninstallSkill — AC8.3", () => {
  it("removes exactly one skill directory and keeps the rest of the agentDir", () => {
    const dir = persona({
      "skills/pdf-tools/SKILL.md": skillMd("pdf-tools"),
      "skills/pdf-tools/scripts/extract.sh": "#!/bin/sh\n",
      "skills/other-skill/SKILL.md": skillMd("other-skill"),
    });
    const removed = uninstallSkill({ agentDir: dir, slug: "pdf-tools" });
    expect(removed.removed).toBe(join(dir, "skills", "pdf-tools"));
    expect(existsSync(join(dir, "skills", "pdf-tools"))).toBe(false);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
    expect(readdirSync(join(dir, "skills"))).toEqual(["other-skill"]);
  });

  it("a missing skill is SKILL_NOT_FOUND (API: 404), not a silent success", () => {
    const dir = persona({ "skills/pdf-tools/SKILL.md": skillMd("pdf-tools") });
    expect(codeOf(() => uninstallSkill({ agentDir: dir, slug: "not-installed" }))).toBe("SKILL_NOT_FOUND");
    // and a second removal of a real skill reports the same thing
    uninstallSkill({ agentDir: dir, slug: "pdf-tools" });
    expect(codeOf(() => uninstallSkill({ agentDir: dir, slug: "pdf-tools" }))).toBe("SKILL_NOT_FOUND");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
  });

  it("rejects an invalid slug without resolving it into a path", () => {
    const dir = persona({ "skills/pdf-tools/SKILL.md": skillMd("pdf-tools") });
    for (const bad of ["../..", "..%2fx", "../pdf-tools", "/etc", "%2e%2e"]) {
      expect(codeOf(() => uninstallSkill({ agentDir: dir, slug: bad })), bad).toBe("SKILL_SLUG_INVALID");
    }
    expect(existsSync(join(dir, "skills", "pdf-tools"))).toBe(true);
  });

  it("refuses to remove a symlinked skill dir, keeping the real target intact", () => {
    // Defence in depth: `uninstall` is documented to delete ONE directory of THIS
    // agent, so it must never resolve through a link into someone else's tree.
    const outside = persona({ "victim/SKILL.md": skillMd("victim") });
    const dir = join(tempDir, "escape-agent");
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "# persona\n");
    symlinkSync(join(outside, "victim"), join(dir, "skills", "linked"), "dir");

    expect(codeOf(() => uninstallSkill({ agentDir: dir, slug: "linked" }))).toBe("SKILL_PATH_ESCAPE");
    expect(existsSync(join(outside, "victim", "SKILL.md"))).toBe(true);
  });

  it("never removes a loose file under skills/ as if it were a skill", () => {
    const dir = persona({ "skills/pdf-tools/SKILL.md": skillMd("pdf-tools"), "skills/notes.md": "# x\n" });
    expect(codeOf(() => uninstallSkill({ agentDir: dir, slug: "notes.md" }))).toBe("SKILL_SLUG_INVALID");
    expect(existsSync(join(dir, "skills", "notes.md"))).toBe(true);
  });
});
