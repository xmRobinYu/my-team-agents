/**
 * Issue I9 — agent 技能的查看 / 安装 / 卸载.
 *
 * AC8.1 查看: `listAgentSkills()` reads what sits in one agent's persona dir and
 * reports, per skill, whether Pi would ACTUALLY load it. That distinction is the
 * reason this module exists: a `SKILL.md` without a `description` is on disk, is
 * listed by any naive file walk, and is silently skipped by Pi
 * (docs/skills.md:85 — reproduced against the installed binary: a
 * description-less skill produced zero loaded commands either through discovery
 * or through `--skill`). "Visible but inert" is the worst failure mode, so
 * `loadable: false` plus a named reason is a first-class result here.
 *
 * The load rule itself is NOT implemented in this file: it lives in
 * `@my-team-agents/runtime-core/src/skills.ts` as `judgeSkillFiles()`, shared
 * with `runtime-pi`, so the importer, the listing endpoint and the injection
 * cannot drift apart. This module's job is the filesystem and the API shape.
 *
 * AC8.3 安装/卸载: `installSkill()` / `uninstallSkill()`. Both validate the slug
 * against Pi's naming rule and resolve the target path *before* touching the
 * filesystem, then require it to sit strictly inside this agent's skills root.
 * Every write is confined to `<agentDir>/skills/<slug>/`; no other file in the
 * persona dir is created, overwritten or removed by this module.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  PERSONA_SKILLS_DIR,
  SKILL_MAX_DESCRIPTION_LENGTH,
  SKILL_SLUG_PATTERN,
  judgeSkillFiles,
  type SkillJudgement,
} from "@my-team-agents/runtime-core";

/** Re-exported so callers of this module keep one vocabulary for the rule. */
export { SKILL_SLUG_PATTERN };

export type SkillErrorCode =
  | "SKILL_SLUG_INVALID"
  | "SKILL_PATH_ESCAPE"
  | "SKILL_FILE_INVALID"
  | "SKILL_NOT_FOUND"
  | "SKILL_EXISTS"
  | "AGENT_DIR_MISSING"
  | "WRITE_FAILED";

export class SkillError extends Error {
  readonly code: SkillErrorCode;
  /** The offending value, so an API caller can see *what* was refused. */
  readonly detail?: string;

  constructor(code: SkillErrorCode, message: string, detail?: string) {
    super(`[${code}] ${message}`);
    this.name = "SkillError";
    this.code = code;
    this.detail = detail;
  }
}

export interface SkillFileEntry {
  /** POSIX-style path relative to the skill directory. */
  path: string;
  bytes: number;
}

export type SkillIssueCode =
  | "missing-skill-md"
  | "no-frontmatter"
  | "missing-description"
  | "description-too-long"
  | "invalid-name"
  | "name-mismatch"
  /** Directory name outside the slug whitelist: never injected, never removed. */
  | "invalid-slug-dir"
  /** A stray `.md` sitting directly under `skills/`: not a skill directory. */
  | "loose-markdown"
  /** Loads, but never enters the system prompt: explicit `/skill:name` only. */
  | "model-invocation-disabled"
  /** A symlink under `skills/`: never listed, never injected, never removed. */
  | "symlink-dir";

export interface SkillIssue {
  code: SkillIssueCode;
  message: string;
}

export interface AgentSkill {
  slug: string;
  name: string;
  description: string | null;
  /** Absolute skill directory — the path handed to Pi as `--skill`. */
  path: string;
  /** Absolute `SKILL.md` path; present even when that file does not exist. */
  skillFile: string;
  files: SkillFileEntry[];
  /** True when Pi would load it: `SKILL.md` present AND a non-empty `description`. */
  loadable: boolean;
  /** Machine-readable half of the `loadable` verdict (`judgeSkillFiles`). */
  verdict: SkillJudgement["verdict"];
  issues: SkillIssue[];
}

export interface AgentSkillListing {
  agentDir: string;
  skillsRoot: string;
  /** An agent with no `skills/` directory is normal, not an error. */
  skillsRootExists: boolean;
  skills: AgentSkill[];
  /** Problems outside the per-skill list, e.g. a directory name that is not a slug. */
  warnings: SkillIssue[];
}

export interface InstallSkillInput {
  agentDir: string;
  slug: string;
  /** Files to write, paths relative to the skill dir. Must include `SKILL.md`. */
  files: Array<{ path: string; content: string }>;
  /** Default false: an existing skill directory is never silently clobbered. */
  overwrite?: boolean;
}

export interface InstalledSkill {
  slug: string;
  path: string;
  files: string[];
  /** True when an existing skill directory was replaced (`overwrite: true`). */
  replaced: boolean;
}

/** Validate a slug against the whitelist. Throws `SkillError` on anything else. */
export function assertSkillSlug(slug: unknown): string {
  if (typeof slug !== "string") {
    throw new SkillError("SKILL_SLUG_INVALID", "slug 必须是字符串", String(slug));
  }
  if (!SKILL_SLUG_PATTERN.test(slug)) {
    throw new SkillError(
      "SKILL_SLUG_INVALID",
      "slug 必须匹配 ^[a-z0-9][a-z0-9-]{0,63}$（小写字母、数字、连字符，≤64 字符，不能以 - 开头/结尾或含 --）",
      slug,
    );
  }
  return slug;
}

/** `<agentDir>/skills` — the only directory this module writes into. */
export function agentSkillsRoot(agentDir: string): string {
  return resolve(join(agentDir, PERSONA_SKILLS_DIR));
}

const isStrictlyInside = (target: string, root: string): boolean => {
  if (target === root) return false;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
};

/**
 * Resolve a skill directory and prove it stays inside this agent's skills root.
 * `resolve()` first, then a prefix check: `../../etc`, an absolute path or a
 * bare `.` all collapse to something outside the root and are refused before any
 * filesystem call — that is the path-traversal gate for both install and remove.
 */
export function skillDirOf(agentDir: string, slug: string): string {
  assertSkillSlug(slug);
  const root = agentSkillsRoot(agentDir);
  const target = resolve(root, slug);
  if (!isStrictlyInside(target, root)) {
    throw new SkillError(
      "SKILL_PATH_ESCAPE",
      `技能路径解析后越出该 agent 的 skills 根目录，已拒绝：${target} ∉ ${root}/`,
      slug,
    );
  }
  return target;
}

/**
 * Reject a payload path that would escape the skill directory. Applies to
 * install files: `../x`, `/etc/passwd`, `a/../../b` and empty segments are
 * refusals, not normalisations.
 */
const safeRelPath = (raw: unknown): string => {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new SkillError("SKILL_FILE_INVALID", "技能文件路径不能为空", String(raw));
  }
  const normalised = raw.replace(/\\/g, "/");
  if (normalised.startsWith("/") || /^[A-Za-z]:\//.test(normalised)) {
    throw new SkillError("SKILL_FILE_INVALID", `技能文件路径必须是相对路径：${raw}`, raw);
  }
  const segments = normalised.split("/");
  if (segments.some((s) => s === ".." || s === "")) {
    throw new SkillError("SKILL_FILE_INVALID", `技能文件路径含越界片段（.. 或空片段）：${raw}`, raw);
  }
  const rel = relative(".", normalised);
  if (rel === "" || rel.startsWith("..") || resolve(".", rel) !== resolve(".", normalised)) {
    throw new SkillError("SKILL_FILE_INVALID", `技能文件路径规范化后越界：${raw}`, raw);
  }
  return rel;
};

/** Translate the shared verdict into user-facing Chinese explanations. */
const issuesFor = (slug: string, judgement: SkillJudgement): SkillIssue[] => {
  const issues: SkillIssue[] = [];
  switch (judgement.verdict) {
    case "missing-skill-md":
      issues.push({
        code: "missing-skill-md",
        message: "目录内没有 SKILL.md：Pi 不会把它当作技能，安装位置正确也不会生效",
      });
      break;
    case "no-frontmatter":
      issues.push({
        code: "no-frontmatter",
        message: "SKILL.md 没有 frontmatter（或没有顶层键）：没有 description，Pi 不会加载它",
      });
      break;
    case "missing-description":
      issues.push({
        code: "missing-description",
        message: "frontmatter 缺少 description：按 Pi 规则该技能不会被加载 —— 看得见，但不会生效",
      });
      break;
    case "loadable":
      break;
  }
  if (!judgement.nameValid) {
    issues.push({
      code: "invalid-name",
      message: "name 不合规范（只允许小写字母、数字、单个连字符分隔，≤64 字符）：Pi 会告警但仍然加载",
    });
  }
  if (!judgement.nameMatchesDir) {
    issues.push({
      code: "name-mismatch",
      message: `frontmatter name=「${judgement.name}」与目录 slug=「${slug}」不一致：Pi 按 name 注册，重名时后发现的技能会被丢弃`,
    });
  }
  if (judgement.descriptionTooLong) {
    issues.push({
      code: "description-too-long",
      message: `description 超过 ${SKILL_MAX_DESCRIPTION_LENGTH} 字符上限：Pi 会告警但仍然加载`,
    });
  }
  if (judgement.disableModelInvocation) {
    issues.push({
      code: "model-invocation-disabled",
      message: "disable-model-invocation=true：不进入系统提示，只能靠 /skill:name 显式调用",
    });
  }
  return issues;
};

const MAX_LISTED_FILES = 500;

/** Recursive file manifest of a directory: relative POSIX paths + sizes. */
function listFiles(dir: string, base = dir): SkillFileEntry[] {
  const out: SkillFileEntry[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= MAX_LISTED_FILES) return out;
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      out.push(...listFiles(full, base));
      continue;
    }
    if (!stats.isFile()) continue;
    out.push({ path: relative(base, full).split(sep).join("/"), bytes: stats.size });
  }
  return out;
}

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** One directory under `skills/`, described as an `AgentSkill`. */
function describeSkill(agentDir: string, slug: string): AgentSkill {
  const path = skillDirOf(agentDir, slug);
  const skillFile = join(path, "SKILL.md");
  const files = listFiles(path);
  const judgement = judgeSkillFiles(slug, { "SKILL.md": readText(skillFile) });
  return {
    slug,
    name: judgement.name,
    description: judgement.description,
    path,
    skillFile,
    files,
    loadable: judgement.loadable,
    verdict: judgement.verdict,
    issues: issuesFor(slug, judgement),
  };
}

/**
 * AC8.1 — every skill directory of one agent, loadable or not. A missing
 * `skills/` root is an empty listing rather than an error: an agent without
 * skills is the normal case, and a read endpoint must not 404 on it.
 */
export function listAgentSkills(agentDir: string): AgentSkillListing {
  const root = agentSkillsRoot(agentDir);
  const listing: AgentSkillListing = {
    agentDir: resolve(agentDir),
    skillsRoot: root,
    skillsRootExists: existsSync(root),
    skills: [],
    warnings: [],
  };
  if (!listing.skillsRootExists) return listing;

  for (const entry of readdirSync(root).sort()) {
    const full = join(root, entry);
    let stats;
    try {
      stats = lstatSync(full);
    } catch {
      continue;
    }
    // A symlink is never followed — not for listing, not for injection, not for
    // removal. Otherwise `skills/x -> /somewhere` would let an API documented to
    // delete one skill directory destroy content outside the agent's own tree.
    if (stats.isSymbolicLink()) {
      listing.warnings.push({
        code: "symlink-dir",
        message: `skills/${entry} 是符号链接：不列出、不注入、也不会被卸载（删除操作不得越过本 agent 的目录）`,
      });
      continue;
    }
    if (stats.isDirectory()) {
      // A directory whose name is not a legal slug is reported and never
      // injected or removed: the whitelist is the contract on both sides.
      if (!SKILL_SLUG_PATTERN.test(entry)) {
        listing.warnings.push({
          code: "invalid-slug-dir",
          message: `skills/${entry}/ 的目录名不合 slug 规范（^[a-z0-9][a-z0-9-]{0,63}$），不会注入给 Pi`,
        });
        continue;
      }
      listing.skills.push(describeSkill(agentDir, entry));
      continue;
    }
    if (stats.isFile() && entry.endsWith(".md")) {
      listing.warnings.push({
        code: "loose-markdown",
        message: `skills/${entry} 是 skills 根目录下的散装 markdown：只有 <slug>/SKILL.md 形态才会被加载`,
      });
    }
  }
  return listing;
}

/**
 * AC8.2 — the paths a run should inject for one persona dir: absolute path of
 * every **loadable** skill directory, sorted for a stable command line.
 *
 * Description-less skills are excluded on purpose: Pi skips them anyway, so
 * passing them would make the spawn args claim more than they achieve. They stay
 * visible in `listAgentSkills()` with `loadable: false`.
 */
export function runSkillPaths(agentDir: string): string[] {
  return listAgentSkills(agentDir)
    .skills.filter((skill) => skill.loadable)
    .map((skill) => skill.path);
}

/**
 * AC8.3 — install. Writes only inside `<agentDir>/skills/<slug>/`, refuses an
 * existing directory unless `overwrite: true`, and validates every relative path
 * before creating anything, so a hostile payload cannot escape the skill dir.
 * Requiring `SKILL.md` is deliberate: without it the "install" would succeed and
 * do nothing, which is the failure this issue exists to eliminate.
 */
export function installSkill(input: InstallSkillInput): InstalledSkill {
  const { slug } = input;
  const path = skillDirOf(input.agentDir, slug);
  if (!existsSync(resolve(input.agentDir))) {
    throw new SkillError("AGENT_DIR_MISSING", `agentDir 不存在：${input.agentDir}`, input.agentDir);
  }
  if (input.files.length === 0) {
    throw new SkillError("SKILL_FILE_INVALID", "至少需要一个技能文件（通常是 SKILL.md）", slug);
  }
  const validated = input.files.map((file) => ({ rel: safeRelPath(file.path), content: file.content }));
  if (!validated.some((f) => f.rel === "SKILL.md")) {
    throw new SkillError(
      "SKILL_FILE_INVALID",
      "缺少 SKILL.md：没有它 Pi 不会把这个目录当技能，装上了也不会生效",
      slug,
    );
  }

  const existed = existsSync(path);
  if (existed && !input.overwrite) {
    throw new SkillError("SKILL_EXISTS", `技能已存在：${path}。要替换它请显式传 overwrite: true`, slug);
  }
  if (existed && input.overwrite) {
    // Bounded by skillDirOf() above: this is always a directory strictly inside
    // this agent's own skills root, never a shared or ancestor path.
    rmSync(path, { recursive: true, force: true });
  }

  try {
    mkdirSync(path, { recursive: true });
    for (const file of validated) {
      const target = resolve(path, file.rel);
      if (!isStrictlyInside(target, path)) {
        throw new SkillError("SKILL_FILE_INVALID", `技能文件越出技能目录：${file.rel}`, file.rel);
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, { mode: 0o644 });
    }
  } catch (err) {
    if (err instanceof SkillError) throw err;
    throw new SkillError(
      "WRITE_FAILED",
      `写入技能 ${slug} 失败：${err instanceof Error ? err.message : String(err)}`,
      slug,
    );
  }

  return { slug, path, files: validated.map((f) => f.rel), replaced: existed };
}

/**
 * AC8.3 — uninstall: remove exactly one skill directory.
 *
 * A missing skill raises `SkillError("SKILL_NOT_FOUND")`, which the API maps to
 * 404 — deliberately not an idempotent 204. Uninstall is destructive: a typo'd
 * slug that answered 204 would tell the caller a skill is gone while it is still
 * installed and still injected. 404 makes the failed intent visible.
 */
export function uninstallSkill(input: { agentDir: string; slug: string }): { removed: string } {
  const path = skillDirOf(input.agentDir, input.slug);
  if (!existsSync(path)) {
    throw new SkillError("SKILL_NOT_FOUND", `该 agent 没有安装技能「${input.slug}」：${path}`, input.slug);
  }
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new SkillError(
      "SKILL_PATH_ESCAPE",
      `技能路径不是普通目录（拒绝删除符号链接目标）：${path}`,
      input.slug,
    );
  }
  // A symlink *inside* the root still reaches outside on removal, so compare the
  // canonical path: what we delete must really live under this agent's own root.
  const canonical = realpathSync(path);
  const canonicalRoot = realpathSync(agentSkillsRoot(input.agentDir));
  if (!isStrictlyInside(canonical, canonicalRoot)) {
    throw new SkillError(
      "SKILL_PATH_ESCAPE",
      `技能目录规范化后越出该 agent 的 skills 根目录，已拒绝：${canonical}`,
      input.slug,
    );
  }
  rmSync(path, { recursive: true, force: true });
  return { removed: path };
}
