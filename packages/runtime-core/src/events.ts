/**
 * Runtime event contract — the spine of the skeleton.
 *
 * Canonical event names mirror Pi's JSON event stream (packages/coding-agent/docs/json.md):
 *   agent_start | agent_end | agent_settled | turn_start | turn_end
 *   message_start | message_update | message_end
 *   tool_execution_start | tool_execution_update | tool_execution_end
 *   queue_update | compaction_start | compaction_end
 *   auto_retry_start | auto_retry_end | summarization_retry_*
 *   entry_appended | session_info_changed | thinking_level_changed
 *   bash_execution_update
 *
 * Non-Pi runtimes (claude/codex/dsh CLI adapters) normalize INTO these names.
 * Unknown upstream event names are reported as `unknown` and never dropped silently.
 * RPC control frames (`response`, `extension_ui_request`) are protocol records,
 * not session events, and are filtered by the Pi adapter.
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
  | "compaction_end"
  | "auto_retry_start"
  | "auto_retry_end"
  | "summarization_retry_scheduled"
  | "summarization_retry_attempt_start"
  | "summarization_retry_finished"
  | "entry_appended"
  | "session_info_changed"
  | "thinking_level_changed"
  | "bash_execution_update"
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
  /**
   * Tool arguments as declared by the agent. The structured-handoff path reads
   * these; without them handoff intent could not be recovered from the stream
   * and we would be back to parsing prose.
   */
  args?: unknown;
  /** Cumulative usage at the time of the event (Pi reports it on message_update/message_end). */
  usage?: Usage;
  model?: string;
  provider?: string;
  isError?: boolean;
  error?: string;
}
