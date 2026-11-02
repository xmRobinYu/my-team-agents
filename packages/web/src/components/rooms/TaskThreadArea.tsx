/**
 * Single-agent thread area (the P7a workbench, kept intact).
 *
 * AC9.1's middle column shows this only when the selected conversation is a Task
 * thread. It stays on `usePiRuntime` primitives — `Task == Thread` is still the
 * P7a projection, and a group must not quietly replace it.
 *
 * The one behaviour I7 added that the UI must respect: a Task thread accepts
 * **only its first message**. A follow-up answers 409 `FOLLOW_UP_NOT_SUPPORTED`
 * and react-pi throws on a 4xx, so rather than let a user discover that by
 * pressing send, the composer is disabled once the thread has any message, with
 * the reason stated in its own words: start a new conversation, or go to a group
 * and @ a member (multi-turn is the room thread's job). The failure is still
 * surfaced if it arrives — a disabled field is a courtesy, not a gate that can be
 * bypassed by a stale render.
 */

import { ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import type { EmptyMessagePartProps } from "@assistant-ui/react";
import { Alert } from "../ui";

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
      </div>
      <div className="msg-bubble">
        <MessagePrimitive.Parts components={{ Empty: AssistantEmptyPart }} />
        <MessagePrimitive.Error>
          <p className="msg-error">该次执行未正常结束，详情见「执行记录」面板。</p>
        </MessagePrimitive.Error>
      </div>
    </MessagePrimitive.Root>
  );
}

// Memo-stable: must live at module scope (see ThreadPrimitive.Messages docs).
function renderMessage({ message }: { message: { role: string } }) {
  return message.role === "user" ? <UserMessage /> : <AssistantMessage />;
}

const FOLLOW_UP_HINT = "该单 agent 会话只接受第一条消息：不支持追问（服务端会返回 409 FOLLOW_UP_NOT_SUPPORTED）。请新建会话，或在左侧选一个群用 @ 继续讨论。";

export function TaskThreadArea({ title, sendError }: { title: string; sendError: string | null }) {
  // A Task thread has exactly one accepted turn, so "has any message" is the
  // condition under which the next send is guaranteed to be refused.
  const hasMessages = useAuiState((state) => state.thread.messages.length > 0);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const followUpBlocked = hasMessages;

  return (
    <section className="card thread-card" data-testid="task-thread">
      <header className="thread-head">
        <div>
          <h2>{title}</h2>
          <p className="card-sub">单 agent 会话 · Task == Thread（/api/pi）· 一轮一条消息</p>
        </div>
        <span className="channel-hint">{isRunning ? "执行中 · SSE" : "服务端权威 · SSE"}</span>
      </header>

      {sendError ? (
        <div className="thread-alert">
          <Alert tone="danger">{sendError}</Alert>
        </div>
      ) : null}

      <ThreadPrimitive.Root className="thread">
        <ThreadPrimitive.Viewport className="thread-viewport" autoScroll turnAnchor="bottom">
          <ThreadPrimitive.Empty>
            <div className="empty-thread">新建任务或选择一个单 agent 会话，输入需求后回车。</div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages>{renderMessage}</ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>

        <div className="composer-block">
          {followUpBlocked ? (
            <p className="inline-note" data-testid="follow-up-note" role="status">
              {FOLLOW_UP_HINT}
            </p>
          ) : null}
          <ComposerPrimitive.Root className="composer">
            <ComposerPrimitive.Input
              className="composer-input"
              placeholder={
                followUpBlocked
                  ? "该会话不支持追问：请新建会话或使用群聊 @"
                  : "描述任务（Enter 发送）；单 agent 会话只接受第一条消息"
              }
              autoFocus
              disabled={followUpBlocked}
              data-testid="task-composer-input"
            />
            <ComposerPrimitive.Send className="btn btn-primary" disabled={followUpBlocked}>
              发送
            </ComposerPrimitive.Send>
          </ComposerPrimitive.Root>
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel className="btn btn-ghost">取消执行</ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </div>
      </ThreadPrimitive.Root>
    </section>
  );
}
