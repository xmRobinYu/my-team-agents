import type { TaskRecord, TaskStatus, TaskEventRow, UsageRecord } from "../api/types";

const STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "排队中",
  running: "执行中",
  retry_wait: "等待重试",
  blocked: "待确认",
  succeeded: "已完成",
  failed: "失败",
  cancelling: "取消中",
  cancelled: "已取消",
};

export const statusLabel = (status: TaskStatus): string => STATUS_LABELS[status] ?? status;

export type StatusTone = "neutral" | "active" | "success" | "warning" | "danger";

export const statusTone = (status: TaskStatus): StatusTone => {
  switch (status) {
    case "queued":
    case "retry_wait":
      return "neutral";
    case "running":
    case "cancelling":
      return "active";
    case "succeeded":
      return "success";
    case "blocked":
      return "warning";
    case "failed":
    case "cancelled":
      return "danger";
    default:
      return "neutral";
  }
};

export const isTerminal = (status: TaskStatus): boolean =>
  status === "succeeded" || status === "failed" || status === "cancelled";

export const canCancel = (status: TaskStatus): boolean =>
  status === "queued" || status === "running" || status === "retry_wait" || status === "blocked";

export const canRetry = (status: TaskStatus): boolean =>
  status === "failed" || status === "cancelled" || status === "blocked";

export const canConfirm = (status: TaskStatus): boolean => status === "blocked";

export function formatTime(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatClock(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

export function formatDuration(from: number, to: number | null | undefined): string {
  if (!Number.isFinite(from)) return "—";
  const end = Number.isFinite(to ?? NaN) ? (to as number) : Date.now();
  const ms = Math.max(0, end - from);
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes} 分 ${rest} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("zh-CN");
}

export function formatCost(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

export function usageTotals(usage: UsageRecord[]): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
} {
  return usage.reduce(
    (acc, row) => ({
      input: acc.input + row.input,
      output: acc.output + row.output,
      cacheRead: acc.cacheRead + row.cacheRead,
      cacheWrite: acc.cacheWrite + row.cacheWrite,
      totalTokens: acc.totalTokens + row.totalTokens,
      totalCost: acc.totalCost + row.totalCost,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0 },
  );
}

/** 任务在列表中的一句话摘要 —— 首行、截断，避免撑破侧栏。 */
export function taskHeadline(task: Pick<TaskRecord, "prompt">): string {
  const firstLine = task.prompt.split("\n").find((line) => line.trim().length > 0) ?? "";
  const trimmed = firstLine.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed || "（无提示词）";
}

/** 事件行的可读摘要，用于事件流表格（不渲染原始 JSON 大块）。 */
export function eventSummary(row: TaskEventRow): string {
  const event = row.event;
  switch (event.type) {
    case "message_update":
      return `增量文本 · ${event.text?.length ?? 0} 字符`;
    case "message_end":
      return `消息完成 · ${event.text?.length ?? 0} 字符`;
    case "tool_execution_start":
      return `调用工具 ${event.toolName ?? "(未命名)"}`;
    case "tool_execution_end":
      return `工具结束 ${event.toolName ?? "(未命名)"}${event.isError ? " · 出错" : ""}`;
    case "error":
      return `错误 · ${event.error ?? "未知错误"}`;
    case "unknown":
      return `未知事件 · ${event.rawType ?? "未标记"}`;
    default:
      return event.rawType ? `${event.type} (${event.rawType})` : event.type;
  }
}

/** 交接记录的时间/字段是 snake_case（outbox 原始行），这里集中取值。 */
export function handoffField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return value === null || value === undefined ? "—" : String(value);
}

/** 事件类型 → 事件流时间线配色。 */
export function eventTone(type: string): "run" | "tool" | "message" | "error" | "lifecycle" {
  if (type === "error") return "error";
  if (type.startsWith("tool_execution")) return "tool";
  if (type.startsWith("message_")) return "message";
  if (type === "agent_start" || type === "agent_end" || type === "agent_settled") return "lifecycle";
  return "run";
}
