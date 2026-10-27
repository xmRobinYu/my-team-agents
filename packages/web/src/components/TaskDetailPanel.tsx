import { useMemo, useState } from "react";
import type { ConfirmBody, TaskDetail, TaskEventRow, TaskRecord } from "../api/types";
import {
  canCancel,
  canConfirm,
  canRetry,
  eventSummary,
  eventTone,
  formatClock,
  formatCost,
  formatDuration,
  formatTime,
  formatTokens,
  handoffField,
  statusLabel,
  usageTotals,
} from "../lib/format";
import { Alert, Badge, Card, EmptyState, Field, Spinner, StatusBadge } from "./ui";

export type DetailTab = "overview" | "events" | "attempts" | "chain" | "usage";

const TABS: Array<{ id: DetailTab; label: string; hint: string }> = [
  { id: "overview", label: "概览", hint: "状态、结果与错误" },
  { id: "events", label: "事件流", hint: "规范化运行时事件" },
  { id: "attempts", label: "执行记录", hint: "Attempt 历史" },
  { id: "chain", label: "交接链", hint: "父子任务与 outbox" },
  { id: "usage", label: "用量", hint: "token 与成本" },
];

const ATTEMPT_LABELS: Record<string, string> = {
  leased: "已派发",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  orphaned: "已失联",
  cancelled: "已取消",
};

const attemptTone = (status: string): "neutral" | "active" | "success" | "warning" | "danger" => {
  if (status === "completed") return "success";
  if (status === "running" || status === "leased") return "active";
  if (status === "orphaned") return "warning";
  if (status === "failed" || status === "cancelled") return "danger";
  return "neutral";
};

/** GET /api/tasks/:id 返回的 {task,attempts,events,chain,chainTasks,handoffs,usage}。 */
export function TaskDetailPanel({
  detail,
  loading,
  error,
  live,
  cursor,
  actionPending,
  actionError,
  onCancel,
  onRetry,
  onConfirm,
  onSelectTask,
  onReload,
}: {
  detail: TaskDetail | null;
  loading: boolean;
  error: string | null;
  live: boolean;
  cursor: number;
  actionPending: string | null;
  actionError: string | null;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onConfirm: (id: string, body: ConfirmBody) => void;
  onSelectTask: (id: string) => void;
  onReload: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>("overview");
  const [confirmNote, setConfirmNote] = useState("");
  const [confirmAction, setConfirmAction] = useState<ConfirmBody["action"]>("retry");
  const [eventLimit, setEventLimit] = useState(40);

  const task = detail?.task ?? null;
  const totals = useMemo(() => (detail ? usageTotals(detail.usage) : null), [detail]);

  if (loading) {
    return (
      <Card title="任务详情" subtitle="GET /api/tasks/:id">
        <Spinner label="载入任务快照…" />
      </Card>
    );
  }

  if (error && !detail) {
    return (
      <Card title="任务详情" subtitle="GET /api/tasks/:id">
        <Alert tone="danger" onDismiss={onReload}>
          详情加载失败：{error}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onReload}>
            重试
          </button>
        </Alert>
      </Card>
    );
  }

  if (!task) {
    return (
      <Card title="任务详情" subtitle="GET /api/tasks/:id">
        <EmptyState
          title="尚未选择任务"
          hint="在左侧列表选择一个任务；详情包含 Attempt 历史、事件流、交接父子链与 token/成本。"
        />
      </Card>
    );
  }

  const blocked = task.status === "blocked";

  return (
    <Card
      title={
        <span className="detail-title">
          <StatusBadge status={task.status} />
          <span className="mono detail-id" title={task.id}>
            {task.id}
          </span>
        </span>
      }
      subtitle={
        <span className="detail-sub">
          {live ? "SSE 增量推送中" : "SSE 未连接 · 依赖轮询"} · 游标 #{cursor} · 更新于 {formatTime(task.updatedAt)}
        </span>
      }
      actions={
        <div className="action-row">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onReload}
            title="重新拉取 GET /api/tasks/:id"
          >
            刷新
          </button>
          {canCancel(task.status) ? (
            <button
              type="button"
              className="btn btn-warn btn-sm"
              disabled={actionPending !== null}
              onClick={() => onCancel(task.id)}
            >
              {actionPending === "cancel" ? <Spinner /> : null} 取消
            </button>
          ) : null}
          {canRetry(task.status) ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={actionPending !== null}
              onClick={() => onRetry(task.id)}
            >
              {actionPending === "retry" ? <Spinner /> : null} 重试
            </button>
          ) : null}
        </div>
      }
    >
      {actionError ? (
        <Alert tone="danger" onDismiss={onReload}>
          操作失败：{actionError}
        </Alert>
      ) : null}

      <div className="tabbar" role="tablist" aria-label="详情视图">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            title={item.hint}
            className={`tab ${tab === item.id ? "tab-active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {item.id === "events" && detail ? (
              <span className="tab-count">{detail.events.length}</span>
            ) : null}
            {item.id === "attempts" && detail ? (
              <span className="tab-count">{detail.attempts.length}</span>
            ) : null}
            {item.id === "chain" && detail ? (
              <span className="tab-count">{detail.chainTasks.length}</span>
            ) : null}
            {item.id === "usage" && detail ? (
              <span className="tab-count">{detail.usage.length}</span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <div className="stack">
          <dl className="field-grid">
            <Field label="租户 / 项目 / 成员" value={`${task.tenantId} · ${task.projectId} · ${task.memberId}`} mono />
            <Field label="工作目录" value={task.workspacePath} mono title={task.workspacePath} />
            <Field label="模型" value={task.model ?? "（runtime 默认）"} mono />
            <Field label="批次 / 尝试" value={`批次 ${task.batch} · 第 ${task.batchAttempts} 次尝试`} />
            <Field label="深度 / 链" value={`depth ${task.depth} · ${task.chainId}`} mono />
            <Field label="父任务" value={task.parentTaskId ?? "—"} mono />
          </dl>

          <div className="prompt-block">
            <p className="block-label">任务提示词</p>
            <pre className="prompt-body">{task.prompt}</pre>
          </div>

          {task.result ? (
            <div className="result-block">
              <p className="block-label">
                结构化结果 <Badge tone={task.result.outcome === "success" ? "success" : task.result.outcome === "partial" ? "warning" : "danger"}>{task.result.outcome}</Badge>
              </p>
              <p className="result-summary">{task.result.summary}</p>
              {task.result.artifacts.length > 0 ? (
                <ul className="artifacts">
                  {task.result.artifacts.map((artifact) => (
                    <li key={artifact.path} className="mono">
                      {artifact.path}
                      {artifact.description ? <span className="muted"> — {artifact.description}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {task.result.remainingRisks.length > 0 ? (
                <ul className="risks">
                  {task.result.remainingRisks.map((risk) => (
                    <li key={risk}>{risk}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {task.error ? (
            <Alert tone="danger">
              <strong>错误</strong>
              <pre className="error-body">{task.error}</pre>
            </Alert>
          ) : null}

          {blocked ? (
            <div className="confirm-block">
              <p className="block-label">人工确认（POST /api/tasks/:id/confirm）</p>
              <p className="hint">
                任务停在 blocked：可能存在未记录结果的高风险工具调用。填写确认后任务重新入队。
              </p>
              <textarea
                rows={3}
                value={confirmNote}
                placeholder="说明你已核对的副作用，例如：已确认写文件范围符合预期"
                onChange={(event) => setConfirmNote(event.target.value)}
              />
              <div className="form-actions">
                <select
                  value={confirmAction}
                  onChange={(event) => setConfirmAction(event.target.value as ConfirmBody["action"])}
                  aria-label="确认后动作"
                >
                  <option value="retry">确认后重新执行（retry）</option>
                  <option value="completed">确认后视为完成（completed）</option>
                </select>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={confirmNote.trim().length === 0 || actionPending !== null}
                  onClick={() => {
                    onConfirm(task.id, { note: confirmNote.trim(), action: confirmAction });
                    setConfirmNote("");
                  }}
                >
                  {actionPending === "confirm" ? <Spinner /> : null} 提交确认
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === "events" && detail ? (
        <div className="stack">
          <div className="event-toolbar">
            <span className="hint">
              event: run · id 为事件序号 · 按时间倒序展示（最新在前）
            </span>
            <div className="event-toolbar-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setEventLimit((value) => value + 60)}
                disabled={eventLimit >= detail.events.length}
              >
                显示更多
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEventLimit(40)}>
                收起
              </button>
            </div>
          </div>
          {detail.events.length === 0 ? (
            <EmptyState title="暂无事件" hint="任务被 worker 领取后，runtime 的规范化事件会实时写入这里。" />
          ) : (
            <ol className="event-list">
              {[...detail.events]
                .slice(-eventLimit)
                .reverse()
                .map((row: TaskEventRow) => (
                  <li key={row.id} className={`event-item event-${eventTone(row.event.type)}`}>
                    <div className="event-head">
                      <span className="event-seq mono">#{row.id}</span>
                      <code className="event-type">{row.event.type}</code>
                      {row.event.rawType ? (
                        <span className="event-raw mono" title="上游原始事件名">
                          {row.event.rawType}
                        </span>
                      ) : null}
                      <span className="event-time">{formatClock(row.event.timestamp)}</span>
                    </div>
                    <p className="event-summary">{eventSummary(row)}</p>
                    <p className="event-attempt mono">
                      attempt {row.attemptId.slice(0, 12)} · 序号 {row.sequence}
                    </p>
                  </li>
                ))}
            </ol>
          )}
        </div>
      ) : null}

      {tab === "attempts" && detail ? (
        <div className="stack">
          <p className="hint">
            Attempt 是执行历史，不是独立聊天线程；上方「对话」面板始终只回放当前 Task 的消息。
          </p>
          {detail.attempts.length === 0 ? (
            <EmptyState title="尚无 Attempt" hint="任务尚未被 worker 领取。" />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>序号</th>
                  <th>状态</th>
                  <th>批次</th>
                  <th>fencing</th>
                  <th>worker</th>
                  <th>耗时</th>
                  <th>错误</th>
                </tr>
              </thead>
              <tbody>
                {detail.attempts.map((attempt) => (
                  <tr key={attempt.id}>
                    <td className="mono">#{attempt.sequence}</td>
                    <td>
                      <Badge tone={attemptTone(attempt.status)}>
                        {ATTEMPT_LABELS[attempt.status] ?? attempt.status}
                      </Badge>
                    </td>
                    <td>{attempt.batch}</td>
                    <td className="mono">{attempt.fencingToken}</td>
                    <td className="mono ellipsis" title={attempt.workerId}>
                      {attempt.workerId}
                    </td>
                    <td>{formatDuration(attempt.createdAt, attempt.updatedAt)}</td>
                    <td className={attempt.error ? "cell-error" : "muted"}>
                      {attempt.error ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      {tab === "chain" && detail ? (
        <div className="stack">
          <dl className="field-grid">
            <Field label="链预算已用" value={detail.chain.budgetUsed} />
            <Field
              label="链取消请求"
              value={detail.chain.cancelRequested ? "已请求" : "无"}
            />
            <Field
              label="访问计数"
              value={
                Object.keys(detail.chain.visitCounts).length === 0
                  ? "—"
                  : Object.entries(detail.chain.visitCounts)
                      .map(([key, value]) => `${key}:${value}`)
                      .join(" · ")
              }
              mono
            />
          </dl>

          <div>
            <p className="block-label">链上任务（{detail.chainTasks.length}）</p>
            {detail.chainTasks.length === 0 ? (
              <EmptyState title="链上仅此任务" />
            ) : (
              <ul className="chain-list">
                {detail.chainTasks.map((chainTask: TaskRecord) => (
                  <li key={chainTask.id}>
                    <button
                      type="button"
                      className={`chain-item ${chainTask.id === task.id ? "chain-item-current" : ""}`}
                      onClick={() => onSelectTask(chainTask.id)}
                      title={chainTask.prompt}
                    >
                      <span className="mono chain-indent">{"·".repeat(chainTask.depth)}</span>
                      <StatusBadge status={chainTask.status} />
                      <span className="chain-prompt">{chainTask.prompt.slice(0, 60)}</span>
                      <span className="mono chain-id">{chainTask.id.slice(0, 12)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <p className="block-label">交接 outbox（{detail.handoffs.length}）</p>
            {detail.handoffs.length === 0 ? (
              <EmptyState title="无交接记录" hint="执行体通过 handoff_to 工具声明交接，而非从文本猜测。" />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>目标成员</th>
                    <th>子任务</th>
                    <th>原因</th>
                    <th>状态</th>
                    <th>创建</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.handoffs.map((record, index) => {
                    const childId = handoffField(record, "child_task_id");
                    return (
                      <tr key={`${childId}-${index}`}>
                        <td className="mono">{handoffField(record, "target_member_id")}</td>
                        <td>
                          <button
                            type="button"
                            className="link-btn mono"
                            onClick={() => onSelectTask(childId)}
                            disabled={!childId || childId === "—"}
                          >
                            {childId.slice(0, 16)}
                          </button>
                        </td>
                        <td className="ellipsis" title={handoffField(record, "reason")}>
                          {handoffField(record, "reason")}
                        </td>
                        <td>{handoffField(record, "status")}</td>
                        <td>{formatTime(Number(handoffField(record, "created_at")) || null)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          <p className="foot-note">
            父任务 {task.parentTaskId ?? "无"}；状态文案：{statusLabel(task.status)}。
          </p>
        </div>
      ) : null}

      {tab === "usage" && detail ? (
        <div className="stack">
          {totals ? (
            <dl className="stat-grid">
              <Stat label="输入 token" value={formatTokens(totals.input)} />
              <Stat label="输出 token" value={formatTokens(totals.output)} />
              <Stat label="缓存读 / 写" value={`${formatTokens(totals.cacheRead)} / ${formatTokens(totals.cacheWrite)}`} />
              <Stat label="总 token" value={formatTokens(totals.totalTokens)} accent />
              <Stat label="总成本" value={formatCost(totals.totalCost)} accent />
            </dl>
          ) : null}
          {detail.usage.length === 0 ? (
            <EmptyState
              title="无用量记录"
              hint="runtime 在 message_update / message_end 上报 usage 后，这里按 attempt+provider+model 聚合。"
            />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Attempt</th>
                  <th>Provider</th>
                  <th>Model</th>
                  <th className="num">输入</th>
                  <th className="num">输出</th>
                  <th className="num">缓存读</th>
                  <th className="num">缓存写</th>
                  <th className="num">总 token</th>
                  <th className="num">成本</th>
                </tr>
              </thead>
              <tbody>
                {detail.usage.map((row) => (
                  <tr key={`${row.attemptId}-${row.provider}-${row.model}`}>
                    <td className="mono ellipsis" title={row.attemptId}>
                      {row.attemptId.slice(0, 12)}
                    </td>
                    <td>{row.provider}</td>
                    <td className="mono">{row.model}</td>
                    <td className="num">{formatTokens(row.input)}</td>
                    <td className="num">{formatTokens(row.output)}</td>
                    <td className="num">{formatTokens(row.cacheRead)}</td>
                    <td className="num">{formatTokens(row.cacheWrite)}</td>
                    <td className="num">{formatTokens(row.totalTokens)}</td>
                    <td className="num">{formatCost(row.totalCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`stat ${accent ? "stat-accent" : ""}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
