import { useMemo, useState } from "react";
import type { Catalog, TaskRecord } from "../api/types";
import { formatTime, statusLabel, taskHeadline } from "../lib/format";
import { StatusBadge } from "./ui";

export type ListFilter = "all" | "active" | "done" | "failed";

const FILTERS: Array<{ id: ListFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "active", label: "进行中" },
  { id: "done", label: "已完成" },
  { id: "failed", label: "异常" },
];

const matches = (task: TaskRecord, filter: ListFilter): boolean => {
  switch (filter) {
    case "all":
      return true;
    case "active":
      return task.status === "queued" || task.status === "running" || task.status === "retry_wait" || task.status === "cancelling";
    case "done":
      return task.status === "succeeded" || task.status === "blocked";
    case "failed":
      return task.status === "failed" || task.status === "cancelled";
    default:
      return true;
  }
};

export function TaskListPanel({
  tasks,
  catalog,
  selectedId,
  live,
  error,
  onSelect,
  onRefresh,
}: {
  tasks: TaskRecord[];
  catalog: Catalog;
  selectedId: string | null;
  live: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}) {
  const [filter, setFilter] = useState<ListFilter>("all");
  const memberName = useMemo(() => {
    const map = new Map(catalog.members.map((member) => [member.id, member.name]));
    return (id: string) => map.get(id) ?? id;
  }, [catalog.members]);

  const visible = tasks.filter((task) => matches(task, filter));

  return (
    <section className="card task-list-card" aria-label="任务列表">
      <header className="card-head">
        <div>
          <h2>任务列表</h2>
          <p className="card-sub">
            GET /api/tasks · {live ? "SSE 实时" : "轮询兜底"} · 共 {tasks.length} 条
          </p>
        </div>
        <div className="card-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh}>
            刷新
          </button>
        </div>
      </header>

      <div className="chip-row" role="tablist" aria-label="任务状态筛选">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={filter === item.id}
            className={`chip ${filter === item.id ? "chip-active" : ""}`}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error ? <p className="inline-error">列表加载失败：{error}</p> : null}

      <div className="task-scroll" role="list">
        {visible.length === 0 ? (
          <p className="muted pad">当前筛选下没有任务。提交新任务后会立即出现在这里。</p>
        ) : (
          visible.map((task) => (
            <button
              key={task.id}
              type="button"
              role="listitem"
              className={`task-item ${selectedId === task.id ? "task-item-active" : ""}`}
              onClick={() => onSelect(task.id)}
            >
              <div className="task-item-top">
                <StatusBadge status={task.status} />
                <span className="task-item-time">{formatTime(task.createdAt)}</span>
              </div>
              <p className="task-item-title">{taskHeadline(task)}</p>
              <div className="task-item-foot">
                <span className="mono">{memberName(task.memberId)}</span>
                <span className="task-item-batch">
                  批次 {task.batch} · 第 {task.batchAttempts} 次
                </span>
              </div>
            </button>
          ))
        )}
      </div>
      <p className="foot-note">状态文案来自 /api/tasks 快照：{statusLabel("running")} / {statusLabel("blocked")} 等 8 种。</p>
    </section>
  );
}
