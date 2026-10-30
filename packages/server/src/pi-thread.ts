/**
 * Pi Thread projection — adapts the durable Task/Attempt/Event spine to the
 * transport-agnostic `PiClient` contract from `@assistant-ui/react-pi`.
 *
 * A Task maps 1:1 to a Pi Thread. We deliberately do NOT use
 * `createPiNodeClient`: that supervisor owns the Pi process and would bypass
 * our durable queue, leases, retries and recovery (P6). This projection keeps
 * the server authoritative — the UI reads Task state through the PiClient
 * contract instead of driving Pi directly.
 */

import type {
  PiAgentMessage,
  PiClientEvent,
  PiThreadMetadata,
  PiThreadSnapshot,
} from "@assistant-ui/react-pi";
import type { TaskRecord, TaskStatus } from "@my-team-agents/orchestrator";
import type { CanonicalEvent } from "@my-team-agents/runtime-core";

export interface TaskEventRow {
  id: number;
  attemptId: string;
  sequence: number;
  event: CanonicalEvent;
}

const RUNNING: ReadonlySet<TaskStatus> = new Set(["queued", "running", "retry_wait", "cancelling"]);

function threadStatus(status: TaskStatus): PiThreadMetadata["status"] {
  if (RUNNING.has(status)) return "running";
  if (status === "failed" || status === "blocked") return "failed";
  return "idle";
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Pi usage is required on assistant messages; zero-fill when a run reported none. */
function emptyUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function taskToThreadMetadata(task: TaskRecord, messageCount = 0): PiThreadMetadata {
  return {
    id: task.id,
    title: task.prompt.slice(0, 80),
    workspacePath: task.workspacePath,
    archived: false,
    status: threadStatus(task.status),
    retryActive: task.status === "retry_wait",
    runningRunId: task.activeAttemptId ?? undefined,
    ...(task.sessionFile ? { sessionFile: task.sessionFile } : {}),
    messageCount,
    createdAt: iso(task.createdAt),
    updatedAt: iso(task.updatedAt),
  };
}

/**
 * Rebuild the Pi transcript from persisted canonical events.
 *
 * Assistant messages are keyed by Attempt: streaming `message_update` deltas
 * fold into one message per Attempt, and `message_end` replaces it with the
 * authoritative text. The original task prompt is the first user message.
 */
export function taskToMessages(task: TaskRecord, events: readonly TaskEventRow[]): PiAgentMessage[] {
  const messages: PiAgentMessage[] = [
    { role: "user", content: task.prompt, timestamp: task.createdAt },
  ];
  // attemptId -> index in `messages` of that Attempt's assistant message.
  const assistantIndex = new Map<string, number>();

  for (const row of events) {
    const ev = row.event;
    if (ev.type === "message_update" || ev.type === "message_end") {
      const text = ev.text ?? "";
      const existing = assistantIndex.get(row.attemptId);
      if (existing !== undefined) {
        const prev = messages[existing] as Extract<PiAgentMessage, { role: "assistant" }>;
        // message_update carries deltas; message_end carries authoritative text.
        const content = ev.type === "message_end"
          ? text
          : `${prev.content.map((c) => (c.type === "text" ? c.text : "")).join("")}${text}`;
        messages[existing] = {
          ...prev,
          content: [{ type: "text", text: content }],
          stopReason: ev.type === "message_end" ? "stop" : prev.stopReason,
          ...(ev.usage ? { usage: ev.usage } : {}),
        };
      } else {
        assistantIndex.set(row.attemptId, messages.length);
        messages.push({
          role: "assistant",
          content: [{ type: "text", text }],
          api: "openai-completions",
          provider: ev.provider ?? "unknown",
          model: ev.model ?? task.model ?? "unknown",
          usage: ev.usage ?? emptyUsage(),
          stopReason: ev.type === "message_end" ? "stop" : "toolUse",
          timestamp: Date.parse(ev.timestamp) || task.updatedAt,
        });
      }
    }
  }
  return messages;
}

export function taskToSnapshot(task: TaskRecord, events: readonly TaskEventRow[]): PiThreadSnapshot {
  const messages = taskToMessages(task, events);
  const lastSeq = events.length > 0 ? events[events.length - 1]!.id : 0;
  return {
    metadata: taskToThreadMetadata(task, messages.length),
    messages,
    seq: lastSeq,
    ...(task.error ? { lastError: task.error } : {}),
  };
}

/**
 * Translate a persisted canonical event into a PiClientEvent.
 *
 * `message_update` must carry Pi's nested `assistantMessageEvent` (text_delta),
 * because react-pi's reducer streams from that field, not from a flat `text`.
 * Events the Pi contract does not model (usage-only frames, internal markers)
 * return null and are skipped rather than mis-shaped.
 */
export function toPiClientEvent(
  taskId: string,
  row: TaskEventRow,
  history: readonly TaskEventRow[] = [],
): PiClientEvent | null {
  const ev = row.event;
  const base = { threadId: taskId, seq: row.id };
  // Rebuild this Attempt's assistant message as of `row`, so message_* frames
  // carry the full PiAgentMessage the reducer requires (not a bare delta).
  const messageFor = (): PiAgentMessage | null => {
    const upto = [...history.filter((r) => r.attemptId === row.attemptId && r.id <= row.id), row];
    const text = upto
      .filter((r) => r.event.type === "message_update" || r.event.type === "message_end")
      .map((r) => r.event.text ?? "")
      .join("");
    const last = upto[upto.length - 1]?.event ?? ev;
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: last.provider ?? "unknown",
      model: last.model ?? "unknown",
      usage: last.usage ?? emptyUsage(),
      stopReason: "stop",
      timestamp: Date.parse(last.timestamp) || Date.now(),
    };
  };
  switch (ev.type) {
    case "agent_start":
      return { ...base, type: "agent_start" };
    case "turn_start":
      return { ...base, type: "turn_start", turnIndex: 0 };
    case "turn_end":
      return { ...base, type: "turn_end", turnIndex: 0 };
    case "agent_end":
      return { ...base, type: "agent_end", willRetry: false };
    case "agent_settled":
      return { ...base, type: "agent_settled" };
    case "message_start": {
      const message = messageFor();
      return message ? { ...base, type: "message_start", message } : null;
    }
    case "message_end": {
      const message = messageFor();
      return message ? { ...base, type: "message_end", message } : null;
    }
    case "message_update": {
      const message = messageFor();
      return message
        ? {
            ...base,
            type: "message_update",
            message,
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: ev.text ?? "",
              partial: message as Extract<PiAgentMessage, { role: "assistant" }>,
            },
          }
        : null;
    }
    case "queue_update":
      return { ...base, type: "queue_update", steering: [], followUp: [] };
    case "compaction_start":
      return { ...base, type: "compaction_start", reason: "threshold" };
    case "compaction_end":
      return { ...base, type: "compaction_end", aborted: false, willRetry: false };
    default:
      // Tool execution and unknown frames are not part of the transcript delta
      // contract we advertise; the snapshot carries their effect. Skipping is
      // deliberate: a mis-shaped frame would corrupt the client's reducer.
      return null;
  }
}
