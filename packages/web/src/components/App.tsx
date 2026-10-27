import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchHealth, type HealthInfo } from "../api/client";
import type { CreateTaskBody, TaskRecord } from "../api/types";
import { ConversationStore } from "../chat/conversation-store";
import { useCatalog, useTaskList } from "../hooks/useWorkbenchData";
import { useTaskActions, useTaskDetail, useTaskSubmit } from "../hooks/useTaskApi";
import { formatTime } from "../lib/format";
import { NewTaskPanel } from "./NewTaskPanel";
import { TaskDetailPanel } from "./TaskDetailPanel";
import { TaskListPanel } from "./TaskListPanel";
import { TaskThread } from "./TaskThread";
import { Alert } from "./ui";

const STORAGE_KEY = "mta.workbench.selectedTask";

const readStoredSelection = (): string | null => {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

export function App() {
  const catalogState = useCatalog();
  const taskList = useTaskList();
  const [selectedId, setSelectedId] = useState<string | null>(readStoredSelection);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const detailState = useTaskDetail(selectedId);
  const submitState = useTaskSubmit();
  const actions = useTaskActions(detailState.reload);

  // 会话 store：一个 Task = 一个 Thread；切任务时整体替换快照。
  const storeRef = useRef<ConversationStore | null>(null);
  if (!storeRef.current) storeRef.current = new ConversationStore();
  const store = storeRef.current;

  const selectedTask = useMemo<TaskRecord | null>(() => {
    if (!selectedId) return null;
    const fromDetail = detailState.detail?.task;
    if (fromDetail && fromDetail.id === selectedId) return fromDetail;
    return taskList.byId.get(selectedId) ?? null;
  }, [selectedId, detailState.detail, taskList.byId]);

  // 目录/任务就绪的首次自动选择。
  useEffect(() => {
    if (selectedId) return;
    const first = taskList.tasks[0];
    if (first) setSelectedId(first.id);
  }, [selectedId, taskList.tasks]);

  // 记住选择。
  useEffect(() => {
    try {
      if (selectedId) window.localStorage.setItem(STORAGE_KEY, selectedId);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* 隐私模式：忽略持久化失败 */
    }
  }, [selectedId]);

  // 健康检查：页眉展示开发模式 / 回环 / 非团队隔离。
  useEffect(() => {
    let cancelled = false;
    fetchHealth()
      .then((value) => {
        if (!cancelled) setHealth(value);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setHealthError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 会话数据源：详情（初始 GET + 单任务 SSE 增量）。详情尚未到达时先用
  // 列表里的任务元数据占位，避免对话区空白；详情属于别的任务时忽略。
  useEffect(() => {
    const detail = detailState.detail;
    if (detail && detail.task.id === selectedId) {
      store.loadHistory(detail.task, detail.events);
      store.setDisabled(false);
      return;
    }
    store.select(selectedTask);
    store.setDisabled(!selectedTask);
  }, [detailState.detail, selectedId, selectedTask, store]);

  // 选中的任务已不存在（列表刷新后 404）时清掉失效选择。
  useEffect(() => {
    if (!selectedId || detailState.loading) return;
    const missing = detailState.error !== null && !detailState.detail && !taskList.byId.has(selectedId);
    if (missing) setSelectedId(null);
  }, [selectedId, detailState.error, detailState.detail, detailState.loading, taskList.byId]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const { submit } = submitState;
  const refreshTasks = taskList.refresh;

  const handleSubmit = useCallback(
    async (body: Omit<CreateTaskBody, "idempotencyKey">) => {
      const created = await submit(body);
      if (created) {
        // 选中新任务会触发 useTaskDetail 的首次拉取与 SSE；这里只需刷新列表。
        setSelectedId(created.id);
        refreshTasks();
      }
      return created;
    },
    [submit, refreshTasks],
  );

  const liveLabel = taskList.live ? "SSE 已连接" : "SSE 重连中 · 轮询兜底";
  const modeLabel = health
    ? `开发模式 · ${health.auth === "loopback-only" ? "仅回环地址" : health.auth} · 无租户隔离`
    : healthError
      ? "未连接后端（/api/health 不可用）"
      : "正在探测后端…";

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            MTA
          </span>
          <div>
            <h1>团队智能体工作台</h1>
            <p className="brand-sub">my-team-agents · 本地开发面板</p>
          </div>
        </div>
        <div className="topbar-flags">
          <span className="flag flag-warn" title="本服务只绑定 127.0.0.1，不是生产部署形态">
            {modeLabel}
          </span>
          <span className={`flag ${taskList.live ? "flag-ok" : "flag-neutral"}`}>{liveLabel}</span>
          {catalogState.fromApi ? (
            <span className="flag flag-ok">目录已接入 /api/catalog</span>
          ) : (
            <span className="flag flag-neutral">内置默认目录</span>
          )}
        </div>
      </header>

      <div className="notice-strip">
        <strong>开发模式声明</strong>
        <span>仅监听 127.0.0.1，无登录、无组织权限模型、无租户隔离；请勿在此界面处理敏感数据。</span>
        <span className="mono">目录：{catalogState.catalog.projects[0]?.id ?? "default"} · 成员：{catalogState.fromApi ? "来自 API" : "mock-agent"}</span>
      </div>

      {taskList.error ? (
        <Alert tone="warning" onDismiss={taskList.refresh}>
          任务列表暂不可用：{taskList.error}
        </Alert>
      ) : null}

      <main className="layout">
        <aside className="col-left">
          <NewTaskPanel
            catalog={catalogState.catalog}
            submitting={submitState.running}
            error={submitState.error}
            fromApi={catalogState.fromApi}
            onSubmit={handleSubmit}
          />
          <TaskListPanel
            tasks={taskList.tasks}
            catalog={catalogState.catalog}
            selectedId={selectedId}
            live={taskList.live}
            error={taskList.error}
            onSelect={handleSelect}
            onRefresh={taskList.refresh}
          />
        </aside>

        <section className="col-center" aria-label="任务对话">
          <div className="thread-card">
            <header className="thread-head">
              <div>
                <h2>{selectedTask ? "任务对话" : "对话"}</h2>
                <p className="card-sub">
                  {selectedTask
                    ? `Task ${selectedTask.id.slice(0, 12)} · ${formatTime(selectedTask.createdAt)} · assistant-ui Thread`
                    : "选择任务后回放 message_update / message_end"}
                </p>
              </div>
              <span className="channel-hint mono">GET /api/tasks/:id/stream · after={detailState.cursor}</span>
            </header>
            <TaskThread store={store} task={selectedTask} enabled={Boolean(selectedId)} />
          </div>
        </section>

        <aside className="col-right">
          <TaskDetailPanel
            detail={detailState.detail}
            loading={detailState.loading}
            error={detailState.error}
            live={detailState.live}
            cursor={detailState.cursor}
            actionPending={actions.pending}
            actionError={actions.error}
            onCancel={(id) => {
              void actions.cancel(id).then((ok) => {
                if (ok) detailState.reload();
              });
            }}
            onRetry={(id) => {
              void actions.retry(id).then((ok) => {
                if (ok) detailState.reload();
              });
            }}
            onConfirm={(id, body) => {
              void actions.confirm(id, body).then((ok) => {
                if (ok) detailState.reload();
              });
            }}
            onSelectTask={handleSelect}
            onReload={detailState.reload}
          />
        </aside>
      </main>

      <footer className="footer">
        <span>POST /api/tasks · GET /api/tasks · GET /api/tasks/:id · GET /api/events (SSE) · GET /api/tasks/:id/stream (SSE)</span>
        <span className="mono">
          {health ? `version ${health.version} · workerRecovery=${String(health.workerRecovery)}` : "—"}
        </span>
      </footer>
    </div>
  );
}
