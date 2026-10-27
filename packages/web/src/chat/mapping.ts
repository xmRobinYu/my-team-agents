import type { CanonicalEvent, TaskEventRow, TaskRecord } from "../api/types";

/** 任务原始 prompt 收敛成的用户消息 ID 前缀。 */
export const USER_MESSAGE_ID_PREFIX = "user-task-";
/** 每个 Attempt 的助手消息 ID 前缀（一个 Attempt = 一条助手消息，不是一个线程）。 */
export const ASSISTANT_MESSAGE_ID_PREFIX = "assistant-attempt-";

export type ChatEntryStatus = "complete" | "running" | "incomplete";

export interface ChatEntry {
  id: string;
  role: "user" | "assistant";
  createdAt: Date;
  text: string;
  status: ChatEntryStatus;
  /** status === "incomplete" 时的原因，映射为 assistant-ui 的 message status reason。 */
  reason?: "cancelled" | "error" | "other";
  attemptId: string;
  /** 该消息最后一条来源事件的行 id —— SSE 续传游标由它推出。 */
  sourceEventId: number;
}

export interface TranscriptTask {
  id: string;
  prompt: string;
  createdAt: number;
  status?: TaskRecord["status"];
}

export interface TaskTranscript {
  /** 会话条目：先 user，之后每个 Attempt 一条 assistant（按首个事件顺序）。 */
  entries: ChatEntry[];
  /** 已收敛出文本的 Attempt 数。 */
  settledAttempts: number;
  /** 仍无文本、以 running 占位呈现的 Attempt 数。 */
  pendingAttempts: number;
}

const STOPPED_STATUSES: TaskRecord["status"][] = ["failed", "cancelling", "cancelled"];

/**
 * 合并流式文本。
 *
 * 契约上 `message_update.text` 是增量、`message_end.text` 是最终全文，
 * 但不同 runtime 上报的 update 既可能是 delta，也可能是累积全文：
 * 累积式（新文本以已有文本开头）直接替换，否则按增量拼接。
 * `message_end` 一律以最终文本为准。
 */
export function mergeText(current: string, incoming: string, final: boolean): string {
  if (final) return incoming;
  if (!current) return incoming;
  return incoming.startsWith(current) ? incoming : current + incoming;
}

interface AttemptBucket {
  attemptId: string;
  firstEventId: number;
  lastEventId: number;
  text: string;
  ended: boolean;
  createdAt: Date;
}

const timestampOf = (event: CanonicalEvent, fallback: number): Date => {
  const parsed = Date.parse(event.timestamp);
  return new Date(Number.isNaN(parsed) ? fallback : parsed);
};

function bucketize(rows: readonly TaskEventRow[], taskCreatedAt: number): AttemptBucket[] {
  const buckets = new Map<string, AttemptBucket>();
  for (const row of rows) {
    const event: CanonicalEvent = row.event;
    let bucket = buckets.get(row.attemptId);
    if (!bucket) {
      bucket = {
        attemptId: row.attemptId,
        firstEventId: row.id,
        lastEventId: row.id,
        text: "",
        ended: false,
        createdAt: timestampOf(event, taskCreatedAt),
      };
      buckets.set(row.attemptId, bucket);
    }
    bucket.lastEventId = Math.max(bucket.lastEventId, row.id);
    if (event.type === "message_update" && typeof event.text === "string") {
      bucket.text = mergeText(bucket.text, event.text, false);
    } else if (event.type === "message_end") {
      if (typeof event.text === "string") bucket.text = mergeText(bucket.text, event.text, true);
      bucket.ended = true;
    }
  }
  return [...buckets.values()].sort((a, b) => a.firstEventId - b.firstEventId);
}

/**
 * 把任务的规范化事件流折叠成**一条**会话（纯函数，无 DOM 依赖）。
 *
 * 关键约束：Attempt 是执行历史，不是聊天线程。整张 Task 只对应一个 Thread；
 * 每个 Attempt 的 message_* 事件收敛为该 Thread 里的一条助手消息；
 * 任务 prompt 收敛为唯一的用户消息。
 */
export function taskTranscriptFromEvents(
  task: TranscriptTask,
  rows: readonly TaskEventRow[],
): TaskTranscript {
  const buckets = bucketize(rows, task.createdAt);
  const status = task.status ?? "running";
  const stopped = STOPPED_STATUSES.includes(status);

  const entries: ChatEntry[] = [
    {
      id: `${USER_MESSAGE_ID_PREFIX}${task.id}`,
      role: "user",
      createdAt: new Date(task.createdAt || Date.now()),
      text: task.prompt,
      status: "complete",
      attemptId: "",
      sourceEventId: 0,
    },
  ];

  let settledAttempts = 0;
  let pendingAttempts = 0;

  for (const bucket of buckets) {
    if (bucket.text.trim()) {
      settledAttempts += 1;
      const cutOff = stopped && !bucket.ended;
      entries.push({
        id: `${ASSISTANT_MESSAGE_ID_PREFIX}${bucket.attemptId}`,
        role: "assistant",
        createdAt: bucket.createdAt,
        text: bucket.text,
        status: cutOff ? "incomplete" : "complete",
        ...(cutOff
          ? { reason: status === "failed" ? ("error" as const) : ("cancelled" as const) }
          : {}),
        attemptId: bucket.attemptId,
        sourceEventId: bucket.lastEventId,
      });
      continue;
    }
    // 无文本的 Attempt：仅当任务仍在推进时以「运行中」占位呈现。
    if (!transcriptIsRunning(status)) continue;
    pendingAttempts += 1;
    entries.push({
      // 与收束后的消息同 id：流式增量只改文本/状态，不会换行重挂。
      id: `${ASSISTANT_MESSAGE_ID_PREFIX}${bucket.attemptId}`,
      role: "assistant",
      createdAt: bucket.createdAt,
      text: "",
      status: "running",
      attemptId: bucket.attemptId,
      sourceEventId: bucket.lastEventId,
    });
  }

  // 尚无任何 Attempt 事件但任务已排队/运行：给一个占位，避免 Thread 空白。
  if (buckets.length === 0 && (status === "queued" || status === "running" || status === "retry_wait")) {
    pendingAttempts += 1;
    entries.push({
      id: `${ASSISTANT_MESSAGE_ID_PREFIX}pending`,
      role: "assistant",
      createdAt: new Date(task.createdAt || Date.now()),
      text: "",
      status: "running",
      attemptId: "",
      sourceEventId: 0,
    });
  }

  return { entries, settledAttempts, pendingAttempts };
}

/**
 * 会话是否仍在运行：驱动 external store 的 `isRunning`。
 * blocked（等待人工确认）不算运行中，但同样不允许再发送。
 */
export function transcriptIsRunning(status: TaskRecord["status"] | null | undefined): boolean {
  return status === "queued" || status === "running" || status === "retry_wait" || status === "cancelling";
}

/** 已收敛出的最大事件行 id —— 重连单任务 SSE 时的 after 游标。 */
export function transcriptCursor(rows: readonly TaskEventRow[], fallback = 0): number {
  return rows.reduce((max, row) => Math.max(max, row.id), fallback);
}

/**
 * 仅折叠「有文本」的 Attempt 文本，供增量同步判断哪些消息需要更新。
 */
export function assistantMessageDeltas(
  rows: readonly TaskEventRow[],
): Array<{ attemptId: string; text: string; lastEventId: number }> {
  return bucketize(rows, 0)
    .filter((bucket) => bucket.text.trim().length > 0)
    .map((bucket) => ({
      attemptId: bucket.attemptId,
      text: bucket.text,
      lastEventId: bucket.lastEventId,
    }));
}
