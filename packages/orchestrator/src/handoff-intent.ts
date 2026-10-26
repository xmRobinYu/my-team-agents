/**
 * Structured handoff intent.
 *
 * Design rule inherited from teamagentx: handoff intent is DECLARED by the agent
 * through a tool call, never regex-scraped from prose. Prose parsing was tried
 * upstream and abandoned precisely because it is unreliable — a model that
 * happens to write "@bob please look at this" in a sentence is not dispatching.
 *
 * The agent emits a JSON tool call; we validate it into a HandoffIntent. Anything
 * malformed is surfaced as an issue and ignored, never guessed at.
 */

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
 * Only `tool_execution_start` carrying HANDOFF_TOOL_NAME counts; a mention in
 * emitted text is deliberately ignored.
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
