import { useSyncExternalStore } from "react";
import type { AssistantRuntime, ExternalStoreAdapter, ThreadMessageLike } from "@assistant-ui/react";
import { useExternalStoreRuntime } from "@assistant-ui/react";
import type { TaskEventRow, TaskRecord } from "../api/types";
import {
  ASSISTANT_MESSAGE_ID_PREFIX,
  type ChatEntry,
  taskTranscriptFromEvents,
  transcriptCursor,
  transcriptIsRunning,
  USER_MESSAGE_ID_PREFIX,
} from "./mapping";

export interface ConversationSnapshot {
  messages: readonly ThreadMessageLike[];
  isRunning: boolean;
  isDisabled: boolean;
  isSendDisabled: boolean;
  /** 已同步进消息的最大事件行 id —— 与详情面板的 after 游标一致。 */
  lastSyncedEventId: number;
}

const EMPTY_SNAPSHOT: ConversationSnapshot = {
  messages: [],
  isRunning: false,
  isDisabled: true,
  isSendDisabled: true,
  lastSyncedEventId: 0,
};

/**
 * 任务会话存储 —— `useExternalStoreRuntime` 的数据源。
 *
 * 设计约束：
 * - 一个 Task 只对应一个 Thread。Attempt 是执行历史（详情面板的「执行记录」），
 *   不是聊天线程；每个 Attempt 的 message_update/message_end 收敛为该 Thread
 *   里的一条助手消息，而不是各自的 Thread；
 * - 消息 ID 稳定（`user-task-<id>` / `assistant-attempt-<attemptId>`），
 *   流式更新合并到同一行，只改文本与状态；
 * - Thread 只展示当前 Task 的历史，且始终禁发：不提供 setMessages/onEdit，
 *   `isSendDisabled` 恒为 true，`onNew` 抛错；发送绝不会改变后端状态；
 * - `snapshot()` 返回缓存对象引用，满足 useSyncExternalStore 的稳定性要求。
 */
export class ConversationStore {
  private current: ConversationSnapshot = EMPTY_SNAPSHOT;
  private listeners = new Set<() => void>();

  private taskId = "";
  private taskPrompt = "";
  private taskCreatedAt = 0;
  private taskStatus: TaskRecord["status"] | null = null;
  private events: TaskEventRow[] = [];
  /** 未选中任务时禁用整个对话面板。 */
  private disabled = true;

  constructor() {
    this.recompute();
  }

  /** useSyncExternalStore 的 getSnapshot：对象引用只在重算时变化。 */
  readonly snapshot = (): ConversationSnapshot => this.current;

  /** useSyncExternalStore 的 getServerSnapshot（本工作台无 SSR，返回同一对象）。 */
  readonly serverSnapshot = (): ConversationSnapshot => this.current;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private recompute(): void {
    if (!this.taskId) {
      this.current = { ...EMPTY_SNAPSHOT, isDisabled: this.disabled };
      return;
    }
    const transcript = taskTranscriptFromEvents(
      {
        id: this.taskId,
        prompt: this.taskPrompt,
        createdAt: this.taskCreatedAt,
        ...(this.taskStatus ? { status: this.taskStatus } : {}),
      },
      this.events,
    );
    this.current = {
      messages: transcript.entries.map(entryToMessageLike),
      isRunning: transcriptIsRunning(this.taskStatus),
      isDisabled: this.disabled,
      // 恒为 true：Thread 只读回放，不支持发送。
      isSendDisabled: true,
      lastSyncedEventId: transcriptCursor(this.events),
    };
  }

  /** 切换到另一个任务（或清空当前任务），丢弃旧事件。 */
  select(task: Pick<TaskRecord, "id" | "prompt" | "createdAt" | "status"> | null): void {
    const nextId = task?.id ?? "";
    if (nextId === this.taskId) {
      if (task) this.applyTaskStatus(task.status);
      return;
    }
    this.taskId = nextId;
    this.taskPrompt = task?.prompt ?? "";
    this.taskCreatedAt = task?.createdAt ?? 0;
    this.taskStatus = task?.status ?? null;
    this.events = [];
    this.recompute();
    this.emit();
  }

  /** 用 GET /api/tasks/:id 的完整历史重置当前任务。 */
  loadHistory(task: TaskRecord, events: readonly TaskEventRow[]): void {
    this.taskId = task.id;
    this.taskPrompt = task.prompt;
    this.taskCreatedAt = task.createdAt;
    this.taskStatus = task.status;
    this.events = [...events];
    this.recompute();
    this.emit();
  }

  /** 单任务 SSE `event: run`：追加事件行并重算（同一 Attempt 的文本会合并）。 */
  appendEvents(rows: readonly TaskEventRow[]): void {
    if (rows.length === 0) return;
    const known = new Set(this.events.map((row) => row.id));
    const fresh = rows.filter((row) => !known.has(row.id));
    if (fresh.length === 0) return;
    this.events = [...this.events, ...fresh];
    this.recompute();
    this.emit();
  }

  /** 单任务 SSE `event: task`：刷新状态（驱动 isRunning 与消息 status）。 */
  applyTaskStatus(status: TaskRecord["status"]): void {
    if (this.taskStatus === status) return;
    this.taskStatus = status;
    this.recompute();
    this.emit();
  }

  /** 未选中任务 / 详情加载失败时禁用输入区。 */
  setDisabled(disabled: boolean): void {
    if (this.disabled === disabled) return;
    this.disabled = disabled;
    this.recompute();
    this.emit();
  }

  /** 供 useExternalStoreRuntime 消费的适配器。 */
  adapter(snapshot: ConversationSnapshot): ExternalStoreAdapter<ThreadMessageLike> {
    return {
      messages: snapshot.messages,
      isRunning: snapshot.isRunning,
      isDisabled: snapshot.isDisabled,
      isSendDisabled: true,
      // ExternalStoreAdapter<ThreadMessageLike> 需要显式转换器；这里恒等。
      convertMessage: (message) => message,
      // 不提供 setMessages / onEdit / onDelete：Thread 对消息只读。
      // 后端状态只能经 POST /api/tasks 创建，发消息一律拒绝。
      onNew: async () => {
        throw new Error("对话面板不会创建任务：请在「新任务」面板提交，或对已完成任务使用「重试」。");
      },
    };
  }
}

function entryToMessageLike(entry: ChatEntry): ThreadMessageLike {
  const metadata = {
    custom: { attemptId: entry.attemptId, sourceEventId: entry.sourceEventId },
  };

  if (entry.role === "user") {
    return {
      id: entry.id,
      createdAt: entry.createdAt,
      role: "user",
      content: [{ type: "text", text: entry.text }],
      metadata,
    };
  }

  if (entry.status === "running") {
    return {
      id: entry.id,
      createdAt: entry.createdAt,
      role: "assistant",
      content: [],
      status: { type: "running" },
      metadata,
    };
  }

  if (entry.status === "incomplete") {
    return {
      id: entry.id,
      createdAt: entry.createdAt,
      role: "assistant",
      content: entry.text ? [{ type: "text", text: entry.text }] : [],
      status: { type: "incomplete", reason: entry.reason ?? "other" },
      metadata,
    };
  }

  return {
    id: entry.id,
    createdAt: entry.createdAt,
    role: "assistant",
    content: entry.text ? [{ type: "text", text: entry.text }] : [],
    status: { type: "complete", reason: "stop" },
    metadata,
  };
}

/** 订阅会话快照。 */
export function useConversationSnapshot(store: ConversationStore): ConversationSnapshot {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.serverSnapshot);
}

/** 由服务端事件流驱动的 external-store runtime（只读）。 */
export function useTaskThreadRuntime(store: ConversationStore): AssistantRuntime {
  const snapshot = useConversationSnapshot(store);
  return useExternalStoreRuntime(store.adapter(snapshot));
}

export { ASSISTANT_MESSAGE_ID_PREFIX, USER_MESSAGE_ID_PREFIX };
