import type {
  Catalog,
  ConfirmBody,
  CreateTaskBody,
  TaskDetail,
  TaskEventRow,
  TaskRecord,
} from "./types";

export interface HealthInfo {
  ok: boolean;
  mode: string;
  version: string;
  auth: string;
  workerRecovery: boolean;
}

/** GET /api/health —— 用于在页眉展示运行模式（开发模式 / 回环 / 无租户隔离）。 */
export function fetchHealth(): Promise<HealthInfo> {
  return request<HealthInfo>("/api/health");
}

/**
 * 后端 API 客户端。
 *
 * 所有请求都走相对路径 `/api/*`：
 * - 开发态由 Vite proxy 转发到 127.0.0.1:3210（见 vite.config.ts）；
 * - 生产态由 packages/server 的 fastify-static 直接同源托管。
 * 因此工作台不需要任何构建期后端地址配置。
 */

const jsonHeaders = { "Content-Type": "application/json" } as const;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body?.error === "string") detail = body.error;
    } catch {
      /* 非 JSON 错误体，保留状态行 */
    }
    throw new Error(`请求失败：${detail}`);
  }
  return (await response.json()) as T;
}

/** 目录（租户/项目/成员）。后端未实现时由调用方回退到默认目录。 */
export function fetchCatalog(): Promise<Catalog> {
  return request<Catalog>("/api/catalog");
}

export function fetchTasks(): Promise<TaskRecord[]> {
  return request<TaskRecord[]>("/api/tasks");
}

export function fetchTaskDetail(id: string): Promise<TaskDetail> {
  return request<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`);
}

export function createTask(body: CreateTaskBody): Promise<TaskRecord> {
  return request<TaskRecord>("/api/tasks", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
}

export function cancelTask(id: string): Promise<unknown> {
  return request<unknown>(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

export function retryTask(id: string): Promise<unknown> {
  return request<unknown>(`/api/tasks/${encodeURIComponent(id)}/retry`, { method: "POST" });
}

/** confirm 目前按 {note, action} 提交；服务端 v1 仅消费 note。 */
export function confirmTask(id: string, body: ConfirmBody): Promise<unknown> {
  return request<unknown>(`/api/tasks/${encodeURIComponent(id)}/confirm`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
}

export type TasksSnapshotHandler = (tasks: TaskRecord[]) => void;

/**
 * GET /api/events — 全局任务快照 SSE。
 * 契约：`event: tasks`，`data` 为 Task[]。EventSource 自带断线重连，
 * 这里只负责把快照递给调用方，并暴露连接状态供 UI 展示。
 */
export function openTasksSnapshot(onSnapshot: TasksSnapshotHandler): {
  close: () => void;
  subscribeStatus: (listener: (connected: boolean) => void) => () => void;
} {
  if (typeof EventSource === "undefined") {
    // 非浏览器环境（纯映射测试）没有 EventSource：退化为一次性拉取。
    void fetchTasks().then(onSnapshot).catch(() => {});
    return {
      close: () => {},
      subscribeStatus: () => () => {},
    };
  }
  const source = new EventSource("/api/events");
  const statusListeners = new Set<(connected: boolean) => void>();
  const emit = (connected: boolean) => {
    for (const listener of statusListeners) listener(connected);
  };
  source.addEventListener("tasks", (event) => {
    try {
      onSnapshot(JSON.parse((event as MessageEvent<string>).data) as TaskRecord[]);
    } catch {
      /* 快照解析失败：保留下一次快照重试 */
    }
  });
  source.onopen = () => emit(true);
  source.onerror = () => emit(false);
  return {
    close: () => source.close(),
    subscribeStatus: (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
  };
}

export type RunEventEntry = TaskEventRow;
export type TaskUpdateHandler = (task: TaskRecord) => void;
export type RunEventHandler = (entry: RunEventEntry) => void;

/**
 * GET /api/tasks/:id/stream?after=N — 单任务 SSE。
 * 契约：`id` 为事件序号，`event: run` 的 data 为事件记录行，
 * `event: task` 的 data 为最新 TaskRecord。EventSource 会以最后的
 * `id:` 作为 after 游标自动重连，实现断点续传。
 */
export function openTaskStream(
  taskId: string,
  after: number,
  handlers: { onRunEvent: RunEventHandler; onTask: TaskUpdateHandler },
): { close: () => void; subscribeStatus: (listener: (connected: boolean) => void) => () => void } {
  if (typeof EventSource === "undefined") {
    return {
      close: () => {},
      subscribeStatus: () => () => {},
    };
  }
  const source = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/stream?after=${after}`);
  const statusListeners = new Set<(connected: boolean) => void>();
  const emit = (connected: boolean) => {
    for (const listener of statusListeners) listener(connected);
  };
  source.addEventListener("run", (event) => {
    try {
      handlers.onRunEvent(JSON.parse((event as MessageEvent<string>).data) as RunEventEntry);
    } catch {
      /* 忽略坏帧 */
    }
  });
  source.addEventListener("task", (event) => {
    try {
      handlers.onTask(JSON.parse((event as MessageEvent<string>).data) as TaskRecord);
    } catch {
      /* 忽略坏帧 */
    }
  });
  source.onopen = () => emit(true);
  source.onerror = () => emit(false);
  return {
    close: () => source.close(),
    subscribeStatus: (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
  };
}
