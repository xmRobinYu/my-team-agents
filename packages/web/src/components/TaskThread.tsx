import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import type { EmptyMessagePartProps } from "@assistant-ui/react";
import type { TaskRecord } from "../api/types";
import type { ConversationStore } from "../chat/conversation-store";
import { useTaskThreadRuntime } from "../chat/conversation-store";
import { statusLabel } from "../lib/format";

/**
 * 对话面板（assistant-ui）。
 *
 * 使用的 assistant-ui API（@assistant-ui/react 0.15.31）：
 * - `useExternalStoreRuntime`（经 useTaskThreadRuntime 包装）：服务端
 *   message_update / message_end 映射为 user/assistant 消息；
 * - `AssistantRuntimeProvider`：注入 runtime；
 * - `ThreadPrimitive.Root / Viewport / Messages`：消息列表（0.15.31 无 `Thread`
 *   复合导出，用 primitives 等效实现）；
 * - `MessagePrimitive.Root / Parts / Error`：单条消息；
 * - `ComposerPrimitive.Root / Input / Send`：输入区（恒禁发）；
 * - `useAuiState`：读取当前消息的 metadata（attemptId）。
 *
 * Thread 只展示**当前 Task** 的历史；切任务即换 store 快照。
 * 输入区不可发送，因此不会创建任务、不会改变后端状态。
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

function AttemptTag() {
  const attemptId = useAuiState((state) => {
    const custom = state.message.metadata.custom as { attemptId?: unknown } | undefined;
    return typeof custom?.attemptId === "string" ? custom.attemptId : "";
  });
  if (!attemptId) return null;
  return (
    <span className="msg-attempt" title={`执行记录 ${attemptId}`}>
      attempt {attemptId.slice(0, 8)}
    </span>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="msg msg-user">
      <div className="msg-bubble">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="msg msg-assistant">
      <div className="msg-meta">
        <span className="msg-author">执行体</span>
        <AttemptTag />
      </div>
      <div className="msg-bubble">
        <MessagePrimitive.Parts components={{ Empty: AssistantEmptyPart }} />
        <MessagePrimitive.Error>
          <p className="msg-error">该次执行未正常结束，详情见右侧「执行记录」。</p>
        </MessagePrimitive.Error>
      </div>
    </MessagePrimitive.Root>
  );
}

/**
 * Messages 的 children 以引用相等做 memo，因此必须放在模块作用域，
 * 否则每次父组件渲染都会让整列表重挂。
 */
function renderMessage({ message }: { message: { role: string } }) {
  return message.role === "user" ? <UserMessage /> : <AssistantMessage />;
}

export function TaskThread({
  store,
  task,
  enabled,
}: {
  store: ConversationStore;
  task: TaskRecord | null;
  enabled: boolean;
}) {
  const runtime = useTaskThreadRuntime(store);
  const placeholder = !task
    ? "请选择左侧任务"
    : `当前任务${statusLabel(task.status)}；新需求请用左侧「新任务」面板`;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="thread">
        <ThreadPrimitive.Viewport className="thread-viewport" autoScroll turnAnchor="bottom">
          <ThreadPrimitive.Messages>{renderMessage}</ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>

        <div className="composer-block">
          <ComposerPrimitive.Root className="composer" aria-label="任务对话输入区（只读）">
            <ComposerPrimitive.Input
              className="composer-input"
              placeholder={placeholder}
              rows={2}
              disabled={!enabled || !task}
              submitMode="none"
              aria-label="对话输入区：只读，不创建任务"
            />
            <div className="composer-row">
              <span className="composer-hint">
                对话面板只回放当前 Task 的 message 事件，发送已禁用：新任务请用左侧「新任务」面板。
              </span>
              <ComposerPrimitive.Send className="btn btn-primary btn-sm">
                发送（已禁用）
              </ComposerPrimitive.Send>
            </div>
          </ComposerPrimitive.Root>
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
