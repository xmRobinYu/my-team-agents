/**
 * P8 patch carried forward — persona-scoped `--thinking`, resolved per run.
 *
 * Extracted from `durable-worker.ts` verbatim, including the reasoning, when the
 * file-size ratchet refused to let the P9d gate grow that file. The rule the
 * ratchet enforces (debt may not grow) is what forced this: the alternative was
 * raising the baseline, which is exactly the move the ratchet exists to prevent.
 */

import type { RunSpec } from "@my-team-agents/runtime-core";
import type { TaskRecord } from "./execution-store.js";
import type { RoomStore } from "./room-store.js";

const THINKING_LEVELS = new Set<NonNullable<RunSpec["thinking"]>>(
  ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
);

/**
 * The level a run should ask for, derived from the ROSTER on every run rather than
 * stored on the Task.
 *
 * Values are CLAMPED to Pi's documented set. `thinking_mode` is free text (`TEXT`)
 * and comes from model-authored templates, so passing it through verbatim would put
 * an attacker/template-controlled string onto a command line. An unrecognised value
 * is dropped — the run keeps the adapter default rather than failing, because a bad
 * thinking level must not cost a whole execution.
 */
export function personaThinking(
  rooms: RoomStore | undefined,
  task: TaskRecord,
  memberId: string,
): { thinking?: NonNullable<RunSpec["thinking"]> } {
  if (!rooms || !task.groupId) return {};
  const raw = rooms.getAgent(memberId)?.thinkingMode?.trim().toLowerCase();
  if (!raw) return {};
  if (!THINKING_LEVELS.has(raw as NonNullable<RunSpec["thinking"]>)) return {};
  return { thinking: raw as NonNullable<RunSpec["thinking"]> };
}
