/**
 * P9c — why an Attempt failed, as a closed set rather than prose.
 *
 * Two reasons this is a type and not a substring search over the error message:
 *
 *   1. A budget stop is not a failure. The Task should land in `blocked` (a human
 *      decision is required) instead of burning three retries and then `failed`.
 *      That decision cannot be made by pattern-matching a sentence.
 *   2. Operators need to count. "12 failures, 9 of them the runtime binary missing"
 *      is actionable; "12 failures" is not.
 *
 * So every call site that KNOWS why it is failing passes the kind explicitly.
 * `classifyRuntimeError` exists only for the one string we do not author — the
 * adapter's `result.error` — and it is deliberately narrow: an unrecognised message
 * is `runtime_error`, never a guess at a specific cause.
 */

export type FailureKind =
  /** The operator asked for it. Not a defect. */
  | "cancelled"
  /** Another worker superseded this Attempt; the Task is retried, not lost. */
  | "lease_lost"
  /** No events for the idle timeout — the runtime is wedged, not slow. */
  | "idle_timeout"
  /** Token or cost budget for the Task is exhausted. Lands in `blocked`. */
  | "budget_exceeded"
  /** The runtime process could not start at all (missing binary, bad argv). */
  | "runtime_unavailable"
  /** The runtime started and then reported a non-completed status. */
  | "runtime_error"
  /** A high-risk tool call has no recorded outcome; a human must look. */
  | "unresolved_tools"
  /** The reply did not carry the required structured result. */
  | "result_invalid"
  /** The agent itself declared `outcome: "failed"`. */
  | "agent_failed"
  /** Nothing recognised. Never silently re-labelled as something else. */
  | "unknown";

/** Kinds that must NOT be retried automatically: a human decision is required. */
const TERMINAL_FOR_AUTOMATION: ReadonlySet<FailureKind> = new Set([
  "budget_exceeded",
  "unresolved_tools",
]);

export const requiresHuman = (kind: FailureKind): boolean => TERMINAL_FOR_AUTOMATION.has(kind);

/**
 * Narrow classifier for an adapter-authored error string.
 *
 * `runtime_unavailable` matters most: a missing `pi` binary would otherwise
 * exhaust the retry budget on every Task in the queue, one 5s backoff at a time.
 */
export function classifyRuntimeError(message: string): FailureKind {
  const text = message.toLowerCase();
  if (text.includes("budget")) return "budget_exceeded";
  if (/(enoent|not found|command not found|no such file|spawn)/.test(text)) return "runtime_unavailable";
  if (/(eacces|eperm)/.test(text)) return "runtime_unavailable";
  if (/(timeout|timed out|no events for)/.test(text)) return "idle_timeout";
  return "runtime_error";
}
