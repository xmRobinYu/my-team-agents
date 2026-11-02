/**
 * Persona-scoped Pi session directory — D3 (P8/I10).
 *
 * `agentDir` only reached Pi as the spawn `cwd` (Q38/I3). Pi stores sessions in
 * `<agent dir>/sessions`, the global `~/.pi/agent/sessions`, *grouped by* working
 * directory — grouping is a naming convention, not an access boundary. Acceptance
 * measured the consequence: a real model used `read`/`bash` to pull the full
 * transcript of other rooms and other roles out of that shared tree. A prompt-level
 * prohibition cannot fix that, because it is a permissions fact, not a persuasion
 * problem. Full sandboxing is P7b and explicitly out of V1 scope.
 *
 * The narrowing available in V1: point Pi's session storage INSIDE the persona dir
 * with `--session-dir`. Measured against the installed `pi` 1.4.0 binary:
 *   - `--session-dir <dir>` is honoured in RPC mode, creates the directory itself
 *     (it did not exist before the run), and every session file lands in it flat.
 *   - Nothing is written under `PI_CODING_AGENT_DIR/sessions` any more.
 *   - Combined with `--session <path>` it does NOT conflict: the file reopens with
 *     its history (`get_state.messageCount` grew 3 -> 5 and `get_messages` returned
 *     both user turns), which is what keeps Q18 resume intact — see the doc note on
 *     `docs/cli.md`: `--session-dir` overrides *storage and lookup*, and an absolute
 *     `--session <path>` is opened by path.
 *
 * Precedence is documented AND measured with both set at once: with
 * `PI_CODING_AGENT_SESSION_DIR=<dirA>` plus `--session-dir <dirB>`, the transcript
 * appeared only under dirB and dirA stayed empty — `--session-dir` beats the env var
 * and the agent-dir default (docs/cli.md:96-97, environment-variables.md:82,
 * sessions.md:50). Line 21's "opened by path" was measured the same way: an absolute
 * `--session <path>` living OUTSIDE `--session-dir` reopened and appended to THAT file.
 *
 * Runs without an `agentDir` — the generic workspace runs and every `runtime-cli`
 * adapter — are left completely untouched: no flag, same argv as before.
 */

import { join, resolve } from "node:path";

/** Where a persona keeps its own Pi sessions, relative to its directory. */
export const PERSONA_SESSION_DIR_NAME = join(".pi", "sessions");

/** Absolute session directory for one persona dir (the value passed to Pi). */
export function piSessionDirForAgent(agentDir: string): string {
  return join(resolve(agentDir), PERSONA_SESSION_DIR_NAME);
}

/**
 * argv fragment isolating this run's sessions. Empty when the run has no persona
 * dir, so a workspace-only Task keeps byte-identical args (pinned by a test).
 */
export function piSessionDirArgs(agentDir: string | undefined): string[] {
  if (!agentDir) return [];
  return ["--session-dir", piSessionDirForAgent(agentDir)];
}
