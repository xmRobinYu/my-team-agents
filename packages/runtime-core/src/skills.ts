/**
 * The persona-skill convention — the shared surface between the layer that
 * WRITES skills (orchestrator: template import, install) and the runtime that
 * LOADS them (`runtime-pi`: `--skill` injection) plus the layer that LISTS them.
 *
 * It lives in `runtime-core` because that is the only package both sides already
 * depend on: orchestrator → runtime-core, runtime-pi → runtime-core. Putting it
 * anywhere else would either duplicate the rule (two implementations that can
 * drift, which is precisely how I9's defect 1 happened — the importer picked a
 * path, Pi scanned others) or invert the dependency graph.
 *
 * Two facts, both verified against the installed `pi` 1.4.0 binary and its
 * package docs, that this module encodes:
 *
 *  1. `<agentDir>/skills/<slug>/SKILL.md` is NOT on Pi's discovery path. The
 *     project locations are `.pi/skills/` and `.agents/skills/`
 *     (docs/configuration.md:35, docs/skills.md:61); `<agent-dir>/skills/`
 *     belongs to `PI_CODING_AGENT_DIR` (docs/configuration.md:22), which a
 *     persona dir deliberately is not. So a skill only reaches Pi through the
 *     explicit `--skill <path>` flag (docs/cli.md:200-201, repeatable).
 *  2. A `SKILL.md` without a non-empty `description` is never loaded
 *     (docs/skills.md:85; `dist/core/skills.js` `loadSkillFromFile`). Passing
 *     such a directory to `--skill` is a no-op. "Installed but inert" must be
 *     visible, which is why the verdict below names the reason instead of
 *     silently dropping it.
 */

/** Directory name holding an agent's skills, relative to its persona dir. */
export const PERSONA_SKILLS_DIR = "skills";

/**
 * Pi / Agent Skills naming rule: lowercase letters, digits, hyphens; no leading,
 * trailing or consecutive hyphen; at most 64 characters (docs/skills.md:81).
 * A slug outside it can never be a skill name, so it must never be a path either.
 */
export const SKILL_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Description ceiling from the Agent Skills spec (docs/skills.md:81). */
export const SKILL_MAX_DESCRIPTION_LENGTH = 1024;

export const isValidSkillSlug = (slug: unknown): slug is string =>
  typeof slug === "string" && SKILL_SLUG_PATTERN.test(slug);

/**
 * Minimal YAML frontmatter reader: top-level `key: scalar` only. Nested maps are
 * skipped rather than guessed. Deliberately narrow — Pi's own loader only needs
 * `name` / `description` / a few flags to decide whether a skill exists.
 */
export function readSkillFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/^\uFEFF/, "").replace(/^\r?\n/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return out;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.trim() === "---") break;
    if (/^\s/.test(line)) continue; // nested value belonging to the previous key
    const kv = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const value = (kv[2] ?? "").trim().replace(/^["'](.*)["']$/, "$1");
    if (key && value) out[key] = value;
  }
  return out;
}

/** Why a skill directory would not be loaded, in Pi's own terms. */
export type SkillLoadVerdict = "loadable" | "missing-skill-md" | "no-frontmatter" | "missing-description";

export interface SkillJudgement {
  verdict: SkillLoadVerdict;
  /** True only when Pi loads the skill: `verdict === "loadable"`. */
  loadable: boolean;
  /** `name` from frontmatter, else the directory name (Pi's fallback). */
  name: string;
  description: string | null;
  /** Present-but-invalid fields are reported, not hidden: Pi warns, still loads. */
  nameValid: boolean;
  nameMatchesDir: boolean;
  descriptionTooLong: boolean;
  disableModelInvocation: boolean;
}

/**
 * Judge one skill directory from its file map (`relative path -> text`). Pure:
 * the same function answers for a directory on disk and for a skill still inside
 * a template zip, so an import-time warning and a later listing can never
 * disagree about whether a skill will take effect.
 */
export function judgeSkillFiles(
  slug: string,
  files: Record<string, string | undefined>,
): SkillJudgement {
  const skillMd = files["SKILL.md"];
  const base = {
    name: slug,
    description: null as string | null,
    nameValid: true,
    nameMatchesDir: true,
    descriptionTooLong: false,
    disableModelInvocation: false,
  };
  if (skillMd === undefined) {
    return { ...base, verdict: "missing-skill-md", loadable: false };
  }

  const fm = readSkillFrontmatter(skillMd);
  if (!/^---\r?\n/.test(skillMd.replace(/^\uFEFF/, "").replace(/^\r?\n/, "")) || Object.keys(fm).length === 0) {
    return { ...base, verdict: "no-frontmatter", loadable: false };
  }

  const name = fm["name"] ?? slug;
  const description = fm["description"] ?? null;
  const detail = {
    name,
    description,
    nameValid: skillNameValid(name),
    nameMatchesDir: name === slug,
    descriptionTooLong: description !== null && description.length > SKILL_MAX_DESCRIPTION_LENGTH,
    disableModelInvocation: /^(true|yes|1)$/i.test(fm["disable-model-invocation"] ?? ""),
  };
  if (description === null || description.trim() === "") {
    return { ...detail, verdict: "missing-description", loadable: false };
  }
  return { ...detail, verdict: "loadable", loadable: true };
}

/** Pi's name rule, applied to the declared `name` rather than the directory. */
export function skillNameValid(name: string): boolean {
  return name.length <= 64
    && /^[a-z0-9-]+$/.test(name)
    && !name.startsWith("-")
    && !name.endsWith("-")
    && !name.includes("--");
}
