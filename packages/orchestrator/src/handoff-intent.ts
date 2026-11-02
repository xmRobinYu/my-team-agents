/**
 * Structured handoff intent — the PRIMARY dispatch path.
 *
 * Design rule inherited from teamagentx: handoff intent is DECLARED by the agent
 * through a tool call, never regex-scraped from prose. Prose parsing was tried
 * upstream and abandoned precisely because it is unreliable — a model that
 * happens to write "@bob please look at this" in a sentence is not dispatching.
 *
 * That reasoning still holds, and it is why this module stays tool-only. Q34
 * narrows it rather than overturning it: because our rooms run in auto mode
 * (Q34), a `@name` inside an agent's OWN reply is recognised as a SECONDARY,
 * explicitly-degraded path. The two are not equal:
 *  - `handoff_to` is authoritative — it carries a reason, a work package and a
 *    real tool-call id, and it wins whenever both paths name the same target
 *    (Q35/AC3.3: dedup keeps THIS path's reason, not the mention's);
 *  - `@name` is a fallback for models that write prose instead of calling the
 *    tool. It resolves only against the room's declared members (`mention.ts`),
 *    and it is subject to exactly the same guardrails as the structured path —
 *    the P6 handoff guardrails (fanout/depth/budget/revisit) here, and the I6
 *    flow guards (`room-guards.ts`) after. Anything else would let a model
 *    escape its round budget by switching from a tool call to a character.
 * The mention half therefore does not live here: this file parses the tool call
 * and owns the dedup rule that makes the precedence machine-checked.
 *
 * The agent emits a JSON tool call; we validate it into a HandoffIntent. Anything
 * malformed is surfaced as an issue and ignored, never guessed at.
 */

/**
 * Which path produced a dispatch. `handoff_to` is primary, `mention` is the
 * degraded secondary one (Q34); the rank is what `dedupeByOrigin` resolves a
 * collision with, so precedence never depends on list order.
 */
export type DispatchOrigin = "handoff_to" | "mention";

/** The minimum shape `dedupeByOrigin` needs; `ResolvedHandoff` satisfies it. */
export interface DispatchTarget {
  toMemberId: string;
  origin: DispatchOrigin;
}

const ORIGIN_RANK: Record<DispatchOrigin, number> = { handoff_to: 0, mention: 1 };

/**
 * Collapse repeated targets inside ONE source message (Q35 / AC3.3): a target is
 * enqueued at most once, and the surviving record is the `handoff_to` one.
 *
 * This runs BEFORE the flow guards, and that placement is the whole point.
 * `evaluateTrigger` refuses a target already in this turn's chain as `LOOP`; if
 * two paths (or two `handoff_to` calls) named the same agent and both reached the
 * guard, the second would be reported as a loop — a lie, since the truth is
 * "deduplicated", and a false LOOP also burns a system message the user cannot
 * act on. Folding by `toMemberId` first keeps `LOOP` meaning exactly A→B→A.
 *
 * Pure and order-stable: first occurrence wins within one origin.
 */
export function dedupeByOrigin<T extends DispatchTarget>(items: readonly T[]): T[] {
  const winner = new Map<string, { at: number; item: T }>();
  items.forEach((item, at) => {
    const current = winner.get(item.toMemberId);
    if (!current || ORIGIN_RANK[item.origin] < ORIGIN_RANK[current.item.origin]) {
      winner.set(item.toMemberId, { at, item });
    }
  });
  return [...winner.values()].sort((a, b) => a.at - b.at).map((entry) => entry.item);
}

export interface HandoffIntent {
  /** Member ids to dispatch to. Empty is invalid. */
  toMemberIds: string[];
  reason: string;
}

export interface HandoffParseResult {
  intents: HandoffIntent[];
  issues: string[];
}

/** The tool name agents must use to declare a handoff. */
export const HANDOFF_TOOL_NAME = "handoff_to";

const MAX_REASON_LENGTH = 2000;

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/**
 * Validate one declared handoff payload.
 * Unknown extra keys are tolerated (forward compatibility); missing/ill-typed
 * required keys are not.
 */
export function parseHandoffArgs(args: unknown): HandoffParseResult {
  const issues: string[] = [];
  if (typeof args !== "object" || args === null) {
    return { intents: [], issues: ["handoff args must be an object"] };
  }
  const obj = args as Record<string, unknown>;

  const targets = asStringArray(obj.toMemberIds ?? obj.to);
  if (!targets || targets.length === 0) {
    issues.push("handoff requires a non-empty toMemberIds array");
    return { intents: [], issues };
  }

  if (targets.length !== new Set(targets).size) {
    issues.push("duplicate targets in one handoff are collapsed");
  }

  let reason = typeof obj.reason === "string" ? obj.reason : "";
  if (!reason.trim()) {
    issues.push("handoff missing reason");
    reason = "";
  }
  if (reason.length > MAX_REASON_LENGTH) {
    reason = reason.slice(0, MAX_REASON_LENGTH);
    issues.push("reason truncated");
  }

  return { intents: [{ toMemberIds: [...new Set(targets)], reason }], issues };
}

/**
 * Extract declared handoffs from a run's tool events.
 * Only `tool_execution_start` carrying HANDOFF_TOOL_NAME counts: this function
 * never reads emitted text — the `@name` secondary path is resolved by
 * `mention.ts` against the room's members and joined with these intents by the
 * worker, which then applies `dedupeByOrigin` (Q34/Q35).
 */
export function extractHandoffs(
  events: Iterable<{ type: string; toolName?: string; args?: unknown }>,
): HandoffParseResult {
  const intents: HandoffIntent[] = [];
  const issues: string[] = [];
  for (const ev of events) {
    if (ev.type !== "tool_execution_start") continue;
    if (ev.toolName !== HANDOFF_TOOL_NAME) continue;
    const parsed = parseHandoffArgs(ev.args);
    intents.push(...parsed.intents);
    issues.push(...parsed.issues);
  }
  return { intents, issues };
}
