import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadListPrimitive,
  ThreadListItemPrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { createPiHttpClient, usePiRuntime } from "@assistant-ui/react-pi";
import type { EmptyMessagePartProps } from "@assistant-ui/react";
import { fetchHealth, type HealthInfo } from "../api/client";
import { useTaskActions, useTaskDetail } from "../hooks/useTaskApi";
import { TaskDetailPanel } from "./TaskDetailPanel";
import { Alert } from "./ui";

/**
 * Workbench driven by `@assistant-ui/react-pi`.
 *
 * `usePiRuntime` owns the thread list, the active thread, the message stream
 * and send/cancel. Every call goes through `createPiHttpClient` to our
 * `/api/pi` routes, which project the durable Task/Attempt/Event store — the
 * UI never drives Pi directly, and P6 (queue, lease, retry, recovery) stays
 * authoritative on the server.
 *
 * The detail panel still reads `/api/tasks/:id`: attempts, usage, handoffs and
 * chain are P6 evidence the PiClient contract does not model.
 */

function AssistantEmptyPart({ status }: EmptyMessagePartProps) {
  if (status.type !== "running") return null;
  return (
    <span className="msg-thinking">
      <span className="pulse-dot" aria-hidden="true" />
      正在执行…
    </span>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="msg msg-user">
      <div className="msg-bubble"><MessagePrimitive.Parts /></div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="msg msg-assistant">
      <div className="msg-meta"><span className="msg-author">执行体</span></div>
      <div className="msg-bubble">
        <MessagePrimitive.Parts components={{ Empty: AssistantEmptyPart }} />
        <MessagePrimitive.Error>
          <p className="msg-error">该次执行未正常结束，详情见右侧「执行记录」。</p>
        </MessagePrimitive.Error>
      </div>
    </MessagePrimitive.Root>
  );
}

// Memo-stable: must live at module scope (see ThreadPrimitive.Messages docs).
function renderMessage({ message }: { message: { role: string } }) {
  return message.role === "user" ? <UserMessage /> : <AssistantMessage />;
}

function ThreadListItem() {
  return (
    <ThreadListItemPrimitive.Root className="thread-item">
      <ThreadListItemPrimitive.Trigger className="thread-item-trigger">
        <ThreadListItemPrimitive.Title />
      </ThreadListItemPrimitive.Trigger>
      <ThreadListItemPrimitive.Delete className="thread-item-delete" aria-label="删除会话">×</ThreadListItemPrimitive.Delete>
    </ThreadListItemPrimitive.Root>
  );
}

export function App() {
  const client = useMemo(() => createPiHttpClient({ baseUrl: "/api/pi" }), []);
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(undefined);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const runtime = usePiRuntime({
    client,
    onThreadIdChange: setActiveThreadId,
    onError: (error) => console.error("pi runtime error", error),
  });

  // P6 evidence panel: attempts/usage/handoffs for the active Task (== thread).
  const detailState = useTaskDetail(activeThreadId ?? null);
  const actions = useTaskActions(detailState.reload);

  useEffect(() => {
    let cancelled = false;
    fetchHealth()
      .then((info) => { if (!cancelled) setHealth(info); })
      .catch((error: unknown) => { if (!cancelled) setHealthError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, []);

  const handleSelectTask = useCallback((_id: string) => {
    // Chain navigation inside the detail panel stays read-only here; selecting
    // another thread is done via the left list. No-op kept for panel parity.
  }, []);

  const modeLabel = health
    ? `开发模式 · ${health.auth === "loopback-only" ? "仅回环地址" : health.auth} · 无租户隔离`
    : healthError
      ? "未连接后端（/api/health 不可用）"
      : "正在探测后端…";

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="shell">
        <header className="topbar">
          <div>
            <h1>my-team-agents 工作台</h1>
            <p className="subtitle">react-pi · PiClient 适配 · 服务端权威</p>
          </div>
          <div className="mode-badge">{modeLabel}</div>
        </header>

        <div className="layout">
          <aside className="col-left">
            <div className="panel">
              <div className="panel-head">
                <h2>会话</h2>
                <ThreadListPrimitive.New className="btn btn-primary btn-sm">新会话</ThreadListPrimitive.New>
              </div>
              <ThreadListPrimitive.Root className="thread-list">
                <ThreadListPrimitive.Items>{() => <ThreadListItem />}</ThreadListPrimitive.Items>
              </ThreadListPrimitive.Root>
            </div>
          </aside>

          <main className="col-center">
            <ThreadPrimitive.Root className="thread">
              <ThreadPrimitive.Viewport className="thread-viewport" autoScroll turnAnchor="bottom">
                <ThreadPrimitive.Empty>
                  <div className="empty-thread">选择或新建会话，输入需求后回车。</div>
                </ThreadPrimitive.Empty>
                <ThreadPrimitive.Messages>{renderMessage}</ThreadPrimitive.Messages>
              </ThreadPrimitive.Viewport>
              <div className="composer-block">
                <ComposerPrimitive.Root className="composer">
                  <ComposerPrimitive.Input
                    className="composer-input"
                    placeholder="描述任务；执行中发送会进入 steer 队列"
                    autoFocus
                  />
                  <ComposerPrimitive.Send className="btn btn-primary">发送</ComposerPrimitive.Send>
                </ComposerPrimitive.Root>
                <ThreadPrimitive.If running>
                  <ComposerPrimitive.Cancel className="btn btn-ghost">取消执行</ComposerPrimitive.Cancel>
                </ThreadPrimitive.If>
              </div>
            </ThreadPrimitive.Root>
          </main>

          <aside className="col-right">
            <TaskDetailPanel
              detail={detailState.detail}
              loading={detailState.loading}
              error={detailState.error}
              live={detailState.live}
              cursor={detailState.cursor}
              actionPending={actions.pending}
              actionError={actions.error}
              onCancel={actions.cancel}
              onRetry={actions.retry}
              onConfirm={actions.confirm}
              onSelectTask={handleSelectTask}
              onReload={detailState.reload}
            />
          </aside>
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}
