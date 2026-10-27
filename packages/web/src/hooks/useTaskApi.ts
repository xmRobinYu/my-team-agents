import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelTask,
  confirmTask,
  createTask,
  fetchTaskDetail,
  openTaskStream,
  retryTask,
} from "../api/client";
import type {
  ConfirmBody,
  CreateTaskBody,
  TaskDetail,
  TaskEventRow,
  TaskRecord,
} from "../api/types";

const DETAIL_POLL_MS = 4_000;

export interface TaskDetailState {
  detail: TaskDetail | null;
  loading: boolean;
  error: string | null;
  /** 单任务 SSE 是否连通（断线由 EventSource 自动重连）。 */
  live: boolean;
  /** 当前已持有的最大事件行 id —— 仅用于展示。 */
  cursor: number;
  reload: () => void;
}

/**
 * 单任务详情：
 * 1. GET /api/tasks/:id 一次拿全量 {task,attempts,events,chain,chainTasks,handoffs,usage}；
 * 2. GET /api/tasks/:id/stream?after=N 追加 `event: run` 事件、刷新 `event: task` 状态；
 * 3. SSE 断线期间按 4s 轮询兜底；
 * 4. 任务进入终态后重拉一次全量，补齐 attempts / usage / handoffs（SSE 不推这些）。
 */
export function useTaskDetail(taskId: string | null): TaskDetailState {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [nonce, setNonce] = useState(0);
  /** 每次全量装载后递增：重建 SSE 连接（after 用当时的游标）。 */
  const [streamEpoch, setStreamEpoch] = useState(0);
  const afterRef = useRef(0);
  const terminalReloaded = useRef<string | null>(null);
  /** 上一次装载的任务 id：只有切换任务才清空旧快照，reload 保留现值避免闪烁。 */
  const loadedTaskId = useRef<string | null>(null);

  const reload = useCallback(() => {
    terminalReloaded.current = null;
    setNonce((value) => value + 1);
  }, []);

  // 全量快照。
  useEffect(() => {
    if (!taskId) {
      setDetail(null);
      setLoading(false);
      setError(null);
      afterRef.current = 0;
      loadedTaskId.current = null;
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    if (loadedTaskId.current !== taskId) {
      setDetail(null);
      afterRef.current = 0;
      terminalReloaded.current = null;
    }

    fetchTaskDetail(taskId)
      .then((value) => {
        if (cancelled) return;
        loadedTaskId.current = taskId;
        setDetail(value);
        afterRef.current = value.events.reduce((max, row) => Math.max(max, row.id), 0);
        setStreamEpoch((epoch) => epoch + 1);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [taskId, nonce]);

  // 单任务 SSE。
  useEffect(() => {
    if (!taskId || streamEpoch === 0) return;
    const stream = openTaskStream(taskId, afterRef.current, {
      onRunEvent: (entry: TaskEventRow) => {
        setDetail((current) => {
          if (!current || current.task.id !== taskId) return current;
          if (current.events.some((row) => row.id === entry.id)) return current;
          return { ...current, events: [...current.events, entry] };
        });
      },
      onTask: (task: TaskRecord) => {
        setDetail((current) => (current ? { ...current, task } : current));
      },
    });
    const unsubscribe = stream.subscribeStatus(setLive);
    return () => {
      unsubscribe();
      stream.close();
    };
  }, [taskId, streamEpoch]);

  // SSE 断开时的轮询兜底。
  useEffect(() => {
    if (!taskId || live) return;
    const timer = setInterval(() => {
      fetchTaskDetail(taskId)
        .then((value) => {
          setDetail(value);
          afterRef.current = value.events.reduce((max, row) => Math.max(max, row.id), 0);
        })
        .catch(() => {
          /* 轮询失败保留现有快照 */
        });
    }, DETAIL_POLL_MS);
    return () => clearInterval(timer);
  }, [taskId, live]);

  // 终态后补一次全量（attempts/usage/handoffs 不在 SSE 里）。
  const status = detail?.task.status;
  useEffect(() => {
    if (!taskId || !status) return;
    const terminal = status === "succeeded" || status === "failed" || status === "cancelled";
    if (!terminal) return;
    if (terminalReloaded.current === taskId) return;
    terminalReloaded.current = taskId;
    setNonce((value) => value + 1);
  }, [taskId, status]);

  const cursor = detail ? detail.events.reduce((max, row) => Math.max(max, row.id), 0) : 0;

  return { detail, loading, error, live, cursor, reload };
}

export interface SubmitState {
  running: boolean;
  error: string | null;
  resetError: () => void;
  /** 提交一张任务草稿；双击/重复调用复用同一请求。 */
  submit: (body: Omit<CreateTaskBody, "idempotencyKey">) => Promise<TaskRecord | null>;
}

/** FNV-1a 32 位：把草稿内容压成稳定短串，用于派生 idempotencyKey。 */
function contentHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * POST /api/tasks 提交器。
 *
 * 防双击三层：
 * 1. `busy` 期间重复调用直接返回 null（按钮同时 disabled）；
 * 2. key 由「草稿内容 + epoch」确定：双击落到同一 key，inflight 表复用同一
 *    个 Promise，绝不发出第二个 POST；
 * 3. 成功后 epoch 递增，之后同样内容再提交会得到新 key（视为新任务）；
 *    失败时 epoch 不变，重试沿用原 key，交给服务端 idempotency_key 去重。
 */
export function useTaskSubmit(): SubmitState {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(new Map<string, Promise<TaskRecord>>());
  const epoch = useRef(0);
  const busy = useRef(false);

  const resetError = useCallback(() => setError(null), []);

  const submit = useCallback<SubmitState["submit"]>(async (body) => {
    if (busy.current) return null;
    const payload = [
      body.tenantId,
      body.projectId,
      body.memberId,
      body.workspacePath,
      body.prompt,
    ].join("\u0000");
    const key = `web-${contentHash(payload)}-e${epoch.current}`;

    const existing = inflight.current.get(key);
    if (existing) return existing.catch(() => null);

    busy.current = true;
    setRunning(true);
    setError(null);

    const request = createTask({ ...body, idempotencyKey: key });
    inflight.current.set(key, request);

    try {
      const task = await request;
      epoch.current += 1;
      return task;
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return null;
    } finally {
      inflight.current.delete(key);
      busy.current = false;
      setRunning(false);
    }
  }, []);

  return { running, error, submit, resetError };
}

export interface TaskActionsState {
  pending: string | null;
  error: string | null;
  cancel: (id: string) => Promise<boolean>;
  retry: (id: string) => Promise<boolean>;
  confirm: (id: string, body: ConfirmBody) => Promise<boolean>;
  clearError: () => void;
}

/** 任务控制：POST /cancel、/retry、/confirm（confirm body 为 {note, action}）。 */
export function useTaskActions(onDone: (id: string) => void): TaskActionsState {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const run = useCallback(
    async (action: "cancel" | "retry" | "confirm", id: string, body?: ConfirmBody) => {
      if (pending) return false;
      setPending(action);
      setError(null);
      try {
        if (action === "cancel") await cancelTask(id);
        else if (action === "retry") await retryTask(id);
        else await confirmTask(id, body ?? { note: "", action: "retry" });
        onDoneRef.current(id);
        return true;
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : String(reason));
        return false;
      } finally {
        setPending(null);
      }
    },
    [pending],
  );

  const cancel = useCallback((id: string) => run("cancel", id), [run]);
  const retry = useCallback((id: string) => run("retry", id), [run]);
  const confirm = useCallback((id: string, body: ConfirmBody) => run("confirm", id, body), [run]);
  const clearError = useCallback(() => setError(null), []);

  return { pending, error, cancel, retry, confirm, clearError };
}
