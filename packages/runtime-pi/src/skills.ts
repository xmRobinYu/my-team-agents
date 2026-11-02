/**
 * Persona-skill injection for Pi — the AC8.2 execution half.
 *
 * Both the layout rule and the "will Pi load this?" test come from
 * `@my-team-agents/runtime-core/src/skills.ts`, the one package the writer
 * (orchestrator) and this runtime already share, so the importer, the listing
 * endpoint and this command line cannot drift apart. Defect 1 was exactly that
 * drift: the importer picked a path Pi never scanned.
 *
 * Why explicit `--skill` rather than a discovery path — all four cases were run
 * against the installed `pi` 1.4.0 binary (see the I9 report for the transcript):
 *   - `<agentDir>/skills/<slug>/SKILL.md`, no flag            -> NOT loaded.
 *     `<agent-dir>/skills/` is a discovery root only for
 *     `PI_CODING_AGENT_DIR` (docs/configuration.md:22); a persona dir is not.
 *   - `<agentDir>/.pi/skills/<slug>/` with `--approve`        -> loaded.
 *   - `<agentDir>/.pi/skills/<slug>/` with `--no-approve`     -> NOT loaded:
 *     project-local resources are trust-gated (docs/security.md), so skills
 *     would vanish for any run that declines trust — `scripts/pi-smoke-*.mjs`
 *     builds an adapter with `approveProjectResources: false`, for instance.
 *   - `--skill <agentDir>/skills/<slug>`                      -> loaded under
 *     BOTH trust settings (docs/cli.md:200-201, repeatable; a directory is
 *     resolved through the same SKILL.md discovery rules).
 * So: keep the importer's landing path, inject it explicitly. One mechanism,
 * no dependence on cwd discovery, no trust coupling.
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PERSONA_SKILLS_DIR, isValidSkillSlug, judgeSkillFiles } from "@my-team-agents/runtime-core";

/** Layout constant, re-exported under the Pi-side name. */
export { PERSONA_SKILLS_DIR as PI_SKILLS_DIR_NAME };

/**
 * Absolute paths of the loadable skill directories inside one persona dir,
 * sorted so the command line is reproducible.
 *
 * Returns `[]` when there is no persona dir, no `skills/` root, or nothing in it
 * that Pi could load — the ordinary case for a Task with no skills. `PiAdapter`
 * appends nothing in that situation, so such a run's args stay byte-identical to
 * before this feature existed (pinned by a regression test).
 *
 * Skipped, for the same reasons the orchestrator's listing skips them:
 *  - a directory name outside the slug whitelist (Pi would refuse the name);
 *  - a symlink (`lstat`, never followed — an injection must not read a tree that
 *    lives outside this persona dir);
 *  - anything failing the load rule: no `SKILL.md`, or no non-empty
 *    `description`. Pi ignores those anyway, so naming them would make the
 *    command line claim an effect it does not have; they surface in
 *    `listAgentSkills()` with `loadable: false` instead.
 */
export function piSkillDirs(agentDir: string | undefined): string[] {
  if (!agentDir) return [];
  const root = join(resolve(agentDir), PERSONA_SKILLS_DIR);
  if (!existsSync(root)) return [];

  let entries: string[];
  try {
    entries = readdirSync(root).sort();
  } catch {
    return [];
  }

  const dirs: string[] = [];
  for (const entry of entries) {
    if (!isValidSkillSlug(entry)) continue;
    const full = join(root, entry);
    let stats;
    try {
      stats = lstatSync(full);
    } catch {
      continue;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
    const skillFile = join(full, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    let text: string;
    try {
      text = readFileSync(skillFile, "utf8");
    } catch {
      continue;
    }
    if (judgeSkillFiles(entry, { "SKILL.md": text }).loadable) dirs.push(full);
  }
  return dirs;
}
