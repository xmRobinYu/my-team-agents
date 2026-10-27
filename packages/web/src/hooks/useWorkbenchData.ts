import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchCatalog,
  fetchTasks,
  openTasksSnapshot,
} from "../api/client";
import type { Catalog, TaskRecord } from "../api/types";

/**
 * GET /api/catalog 未实现（或响应结构不完整）时的默认目录。
 *
 * 浏览器拿不到服务端 cwd，所以 workspacePath 留空并由「新任务」面板
 * 提示填写（后端要求非空字符串）。默认值对齐 server 的开发目录：
 * default 租户 / default 项目 / mock-agent。
 * 代码留有 API 接入：一旦 /api/catalog 可用即被覆盖。
 */
export const FALLBACK_CATALOG: Catalog = {
  tenants: [{ id: "default", name: "默认租户（本地）" }],
  projects: [{ id: "default", name: "default 项目", workspacePath: "" }],
  members: [{ id: "mock-agent", name: "Mock 执行体", runtime: "mock", projectId: "default" }],
  notice: "目录接口不可用，使用内置默认：default / default 项目、mock-agent。",
};

export interface CatalogState {
  catalog: Catalog;
  /** 目录来自 /api/catalog（true）还是内置默认（false）。 */
  fromApi: boolean;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useCatalog(): CatalogState {
  const [catalog, setCatalog] = useState<Catalog>(FALLBACK_CATALOG);
  const [fromApi, setFromApi] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchCatalog()
      .then((value) => {
        if (cancelled) return;
        if (!Array.isArray(value?.tenants) || !Array.isArray(value?.projects) || !Array.isArray(value?.members)) {
          throw new Error("目录响应结构不完整");
        }
        setCatalog(value);
        setFromApi(true);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setCatalog(FALLBACK_CATALOG);
        setFromApi(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { catalog, fromApi, loading, error, reload };
}

export interface TaskListState {
  tasks: TaskRecord[];
  byId: Map<string, TaskRecord>;
  /** SSE 是否连通；断线时退回轮询。 */
  live: boolean;
  /** 数据来源标记，用于状态条文案。 */
  source: "sse" | "polling" | "loading";
  error: string | null;
  refresh: () => void;
}

const POLL_INTERVAL_MS = 4_000;

/**
 * 任务列表：优先 GET /api/events（SSE，event: tasks 为 Task[] 快照），
 * 断线时由 EventSource 自动重连；同时保留轮询兜底，
 * 保证 SSE 不可用（代理吞掉长连接等）时列表仍能更新。
 */
export function useTaskList(): TaskListState {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const sseArrived = useRef(false);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  // 一次性快照 + 轮询兜底。
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchTasks()
        .then((value) => {
          if (cancelled) return;
          setError(null);
          // SSE 已经给过更新时，轮询只在列表变短时覆盖（避免回退闪烁）。
          setTasks((current) => (sseArrived.current && value.length < current.length ? current : value));
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          setError(reason instanceof Error ? reason.message : String(reason));
        });
    };
    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [nonce]);

  // 优先 SSE。
  useEffect(() => {
    const stream = openTasksSnapshot((snapshot) => {
      sseArrived.current = true;
      setTasks(snapshot);
      setError(null);
    });
    const unsubscribe = stream.subscribeStatus(setLive);
    return () => {
      unsubscribe();
      stream.close();
    };
  }, []);

  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const source: TaskListState["source"] = live ? "sse" : tasks.length === 0 && error ? "loading" : "polling";

  return { tasks, byId, live, source, error, refresh };
}
