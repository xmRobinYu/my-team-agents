/**
 * Runtime event contract — the spine of the skeleton.
 *
 * Canonical event names mirror Pi's JSON event stream (packages/coding-agent/docs/json.md):
 *   agent_start | agent_end | agent_settled | turn_start | turn_end
 *   message_start | message_update | message_end
 *   tool_execution_start | tool_execution_update | tool_execution_end
 *   queue_update | compaction_start | auto_retry_start | auto_retry_end
 *
 * Non-Pi runtimes (claude/codex/dsh CLI adapters) normalize INTO these names.
 * Unknown upstream event names are reported as `unknown` and never dropped silently.
 */

export type CanonicalEventType =
  | "agent_start"
  | "agent_end"
  | "agent_settled"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "queue_update"
  | "compaction_start"
  | "auto_retry_start"
  | "auto_retry_end"
  | "error"
  | "unknown";

/** Usage shape matches Pi `session-format.md` usage entries. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface CanonicalEvent {
  type: CanonicalEventType;
  /** Present when the upstream runtime supplied a name this contract does not know. */
  rawType?: string;
  runId: string;
  timestamp: string;
  /** Text delta for message_update; final content for message_end. */
  text?: string;
  toolName?: string;
  toolCallId?: string;
  /** Cumulative usage at the time of the event (Pi reports it on message_update/message_end). */
  usage?: Usage;
  model?: string;
  provider?: string;
  isError?: boolean;
  error?: string;
}
