/**
 * Workbench: the teamagentx-shaped three-column group chat (I8 / AC9.1–AC9.4).
 *
 * Runtime: unchanged. `usePiRuntime` + `createPiHttpClient` still own the thread
 * list and the single-agent conversation (Q27: the UI never drives Pi; `/api/pi`
 * projects the durable store). No Socket.io, no browser-side Pi connection. With
 * I7 wired, `GET /api/pi/threads` answers BOTH projections — rooms as
 * `room:<roomId>`, single-agent Tasks as bare Task ids — and the id prefix is the
 * only thing that tells them apart (`PiThreadMetadata` has no `kind` field), so
 * the UI classifies conversations through `rooms/threadId.ts`.
 *
 * Two components, not one: `App` builds the runtime and provides it; `Workbench`
 * reads it. `useAuiState` cannot be called in the same component that renders
 * `AssistantRuntimeProvider` (the provider is not yet in scope during that
 * render), and a group workbench whose thread list is invisible is not a group
 * workbench — so the split is structural, not stylistic. It was caught only by
 * running the real page in a browser.
 *
 * Columns (AC9.1):
 *   1. `ConversationList` — rooms (`GET /api/rooms`) ∪ the Pi thread list, each
 *                           row labelled by kind;
 *   2. `GroupChatArea`    — the authored shared stream and the `@` composer
 *                           (`TaskThreadArea` when a single-agent thread is picked);
 *   3. `MemberPanel`      — the room's agents with role / coordinator / emoji /
 *                           colour, click-to-mention.
 *
 * Where `TaskDetailPanel` went: still column 3, stacked **below** the member
 * panel, still driven by `/api/tasks/:id`. It is P6 forensics (attempts, leases,
 * handoffs, usage) that neither the PiClient contract nor `/api/rooms` models, so
 * it shares the rail instead of replacing it — that is what makes "who actually
 * ran, and what did it cost" inspectable from a group. For a room it points at
 * that room's newest Task and the note above it says so, because a Task-scoped
 * panel must never imply it describes the whole room. Collapsible, not deleted.
 *
 * Selection is one state object and it decides everything downstream: which
 * roster to fetch, which feed to read, which Task the evidence panel points at,
 * and whether the composer is a mention trigger or a Pi prompt.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { AssistantRuntimeProvider, useAuiState } from "@assistant-ui/react";
import type { AssistantRuntime } from "@assistant-ui/react";
import { createPiHttpClient, usePiRuntime } from "@assistant-ui/react-pi";
import { fetchHealth, type HealthInfo } from "../api/client";
import { useTaskActions, useTaskDetail } from "../hooks/useTaskApi";
import { TaskDetailPanel } from "./TaskDetailPanel";
import { Alert } from "./ui";
import { ConversationList, type ConversationKind, type ThreadRow } from "./rooms/ConversationList";
import { GroupChatArea } from "./rooms/GroupChatArea";
import { MemberPanel } from "./rooms/MemberPanel";
import { TaskThreadArea } from "./rooms/TaskThreadArea";
import { MentionProvider } from "./rooms/MentionBus";
import type { ComposerHandle } from "./rooms/RoomComposer";
import { useRoomAgents, useRoomFeed, useRoomList } from "../rooms/hooks";
import { indexIsBusy, taskCountsByMember, useRoomRosters, useTaskIndex } from "../rooms/useRoomRosters";
import { parseRoomThreadId, roomThreadId } from "../rooms/threadId";
import type { RoomAgent } from "../rooms/types";

const piThreadIdOf = (item: { remoteId?: string; externalId?: string }): string | null =>
  item.externalId ?? item.remoteId ?? null;

interface Selection {
  kind: ConversationKind;
  roomId: string | null;
  threadId: string | null;
}

export function App() {
  const client = useMemo(() => createPiHttpClient({ baseUrl: "/api/pi" }), []);
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(undefined);
  /**
   * A Pi send that the runtime refused (it throws on any 4xx). The single-agent
   * case is I7's 409 `FOLLOW_UP_NOT_SUPPORTED`; the group composer has its own
   * channel, so this is the Task thread's only path to the user — showing it is
   * what keeps a refused send from becoming a silently swallowed input.
   */
  const [sendError, setSendError] = useState<string | null>(null);

  const runtime = usePiRuntime({
    client,
    onThreadIdChange: setActiveThreadId,
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error("pi runtime error", error);
      setSendError(message);
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Workbench
        runtime={runtime}
        activeThreadId={activeThreadId}
        sendError={sendError}
        onSendError={setSendError}
      />
    </AssistantRuntimeProvider>
  );
}

function Workbench({
  runtime,
  activeThreadId,
  sendError,
  onSendError,
}: {
  runtime: AssistantRuntime;
  activeThreadId: string | undefined;
  sendError: string | null;
  onSendError: (message: string | null) => void;
}) {
  /** The mounted group composer; the member panel mentions through it. */
  const composerHandle = useRef<ComposerHandle | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  const rooms = useRoomList();
  const roomIds = useMemo(() => rooms.rooms.map((room) => room.id), [rooms.rooms]);
  const rosters = useRoomRosters(roomIds);
  const taskIndex = useTaskIndex();

  /** The room in view, or the room behind a `room:`-namespaced thread. */
  const activeRoomId = useMemo(() => {
    if (selection?.kind === "room" && selection.roomId) return selection.roomId;
    return activeThreadId ? parseRoomThreadId(activeThreadId) : null;
  }, [selection, activeThreadId]);

  const agentState = useRoomAgents(activeRoomId);
  const room = rooms.rooms.find((candidate) => candidate.id === activeRoomId) ?? null;
  const agents: RoomAgent[] = useMemo(() => {
    if (agentState.agents.length > 0) return agentState.agents;
    return rosters.agents.get(activeRoomId ?? "") ?? [];
  }, [agentState.agents, rosters.agents, activeRoomId]);

  const busy = indexIsBusy(taskIndex, activeRoomId);
  const feed = useRoomFeed(activeRoomId, agents, { busy, revision: taskIndex.revision });

  const roomAgentsMap = useMemo(() => {
    const map = new Map<string, readonly RoomAgent[]>();
    for (const [roomId, list] of rosters.agents) if (list) map.set(roomId, list);
    if (activeRoomId && agents.length > 0) map.set(activeRoomId, agents);
    return map;
  }, [rosters.agents, activeRoomId, agents]);

  // The thread list comes from the runtime — which is why this component must sit
  // INSIDE AssistantRuntimeProvider, while App sits outside it.
  const threadItems = useAuiState((state) => state.threads.threadItems);
  const taskThreads = useMemo<ThreadRow[]>(
    () =>
      threadItems
        .map((item) => {
          const id = piThreadIdOf(item);
          if (id === null) return null;
          const status = item.custom?.status;
          return {
            id,
            title: item.title,
            status: typeof status === "string" ? status : undefined,
            lastMessageAt: item.lastMessageAt,
          };
        })
        .filter((item): item is ThreadRow => item !== null),
    [threadItems],
  );

  // Which rooms the runtime can actually switch to. With I7 wired every room is
  // here; without it, none is — and the group view still works off /api/rooms.
  const roomThreadIds = useMemo(
    () => new Set(taskThreads.filter((thread) => parseRoomThreadId(thread.id) !== null).map((thread) => thread.id)),
    [taskThreads],
  );

  // Follow the runtime when a thread is opened through the runtime itself.
  useEffect(() => {
    if (!activeThreadId) return;
    const roomId = parseRoomThreadId(activeThreadId);
    setSelection((current) => {
      if (roomId !== null) {
        return current?.kind === "room" && current.roomId === roomId
          ? current
          : { kind: "room", roomId, threadId: activeThreadId };
      }
      return current?.kind === "task" && current.threadId === activeThreadId
        ? current
        : { kind: "task", roomId: null, threadId: activeThreadId };
    });
  }, [activeThreadId]);

  const selectedKey =
    selection === null ? null : selection.kind === "room" ? `room:${selection.roomId}` : selection.threadId;

  const selectRow = useCallback(
    (kind: ConversationKind, id: string) => {
      onSendError(null);
      if (kind === "room") {
        const asThread = roomThreadId(id);
        const isThread = roomThreadIds.has(asThread);
        setSelection({ kind: "room", roomId: id, threadId: isThread ? asThread : null });
        if (isThread) void runtime.threads.switchToThread(asThread).catch(() => undefined);
        return;
      }
      setSelection({ kind: "task", roomId: null, threadId: id });
      void runtime.threads.switchToThread(id).catch(() => undefined);
    },
    [onSendError, roomThreadIds, runtime],
  );

  const newThread = useCallback(() => {
    onSendError(null);
    setSelection({ kind: "task", roomId: null, threadId: null });
    void runtime.threads.switchToNewThread().catch(() => undefined);
  }, [onSendError, runtime]);

  /**
   * P6 evidence: a single-agent thread IS its Task (Task == Thread); for a room
   * the panel points at that room's newest Task — the run the stream waits on.
   */
  const newestRoomTaskId = activeRoomId ? (taskIndex.forRoom(activeRoomId)[0]?.id ?? null) : null;
  const detailId =
    selection?.kind === "task"
      ? (selection.threadId ?? null)
      : activeRoomId
        ? newestRoomTaskId
        : (activeThreadId ?? null);
  const detailState = useTaskDetail(detailId);
  const actions = useTaskActions(detailState.reload);
  const memberCounts = useMemo(() => taskCountsByMember(taskIndex.tasks), [taskIndex.tasks]);

  useEffect(() => {
    let cancelled = false;
    fetchHealth()
      .then((info) => {
        if (!cancelled) setHealth(info);
      })
      .catch((error: unknown) => {
        if (!cancelled) setHealthError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelectTask = useCallback((_id: string) => {
    // Chain navigation inside the evidence panel stays read-only: the panel
    // describes one Task, and switching conversations is the list's job.
  }, []);

  const modeLabel = health
    ? `开发模式 · ${health.auth === "loopback-only" ? "仅回环地址" : health.auth} · 无租户隔离`
    : healthError
      ? `未连接后端（${healthError}）`
      : "正在探测后端…";

  return (
    <MentionProvider handle={composerHandle as RefObject<ComposerHandle | null>}>
      <div className="shell">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              MTA
            </span>
            <div>
              <h1>my-team-agents 工作台</h1>
              <p className="brand-sub">三栏群聊 · react-pi · 服务端权威 · Q29 一个群 = 一个线程</p>
            </div>
          </div>
          <div className="topbar-flags">
            <span className={`flag ${health ? "flag-ok" : "flag-warn"}`}>{modeLabel}</span>
            <span className={`flag ${busy ? "flag-warn" : "flag-neutral"}`} data-testid="busy-flag">
              {busy ? "有 agent 在执行" : "空闲"}
            </span>
            <span className="flag flag-neutral">
              <button
                type="button"
                className="link-btn"
                onClick={() => setLeftOpen((open) => !open)}
                data-testid="toggle-left"
              >
                {leftOpen ? "收起会话列表" : "展开会话列表"}
              </button>
            </span>
            <span className="flag flag-neutral">
              <button
                type="button"
                className="link-btn"
                onClick={() => setRightOpen((open) => !open)}
                data-testid="toggle-right"
              >
                {rightOpen ? "收起成员/取证" : "展开成员/取证"}
              </button>
            </span>
          </div>
        </header>

        {healthError ? (
          <Alert tone="warning" onDismiss={() => setHealthError(null)}>
            后端不可用（{healthError}）：群列表、成员与消息流各自显示自己的失败原因，界面仍可折叠。
          </Alert>
        ) : null}

        <div
          className={`layout${leftOpen ? "" : " layout-left-collapsed"}${rightOpen ? "" : " layout-right-collapsed"}`}
          data-testid="layout"
          data-left={leftOpen ? "open" : "collapsed"}
          data-right={rightOpen ? "open" : "collapsed"}
        >
          <aside className="col-left" data-testid="col-left" hidden={!leftOpen}>
            <ConversationList
              rooms={rooms.rooms}
              roomAgents={roomAgentsMap}
              taskThreads={taskThreads}
              selectedKey={selectedKey}
              onSelect={selectRow}
              onNewThread={newThread}
              roomsLoading={rooms.loading}
              roomsError={rooms.error}
              onReloadRooms={rooms.reload}
            />
          </aside>

          <main className="col-center" data-testid="col-center">
            {activeRoomId && room ? (
              <GroupChatArea
                composerHandle={composerHandle}
                roomId={room.id}
                roomName={room.name}
                roomDescription={room.description}
                agents={agents}
                agentsLoading={agentState.loading}
                agentsError={agentState.error}
                turns={feed.turns}
                feedLoading={feed.loading}
                feedError={feed.error}
                feedOrigin={feed.origin}
                busy={busy}
                onReloadFeed={feed.reload}
              />
            ) : (
              <TaskThreadArea
                title={
                  selection?.kind === "task" && selection.threadId
                    ? `单 agent 会话 ${selection.threadId.slice(0, 18)}…`
                    : "单 agent 会话"
                }
                sendError={sendError}
              />
            )}
          </main>

          <aside className="col-right" data-testid="col-right" hidden={!rightOpen}>
            <MemberPanel
              room={room}
              agents={agents}
              loading={agentState.loading}
              error={agentState.error}
              taskCounts={memberCounts}
            />
            <div className="evidence-block">
              <p className="inline-note" data-testid="evidence-note">
                以下面板读 <span className="mono">GET /api/tasks/:id</span>（P6 取证：Attempt 历史、租约、交接链、用量），
                不属于 PRD 三栏。
                {activeRoomId
                  ? `当前指向本群最近的 Task：${newestRoomTaskId ? newestRoomTaskId.slice(0, 20) : "（还没有任务）"}`
                  : "当前指向所选会话的 Task。"}
              </p>
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
            </div>
          </aside>
        </div>

        <footer className="footer">
          <span>
            会话列表 = <span className="mono">GET /api/rooms</span> ∪{" "}
            <span className="mono">/api/pi/threads</span>；消息流 ={" "}
            <span className="mono">
              {feed.origin === "pi-thread"
                ? "/api/pi/threads/room:<id>"
                : activeRoomId
                  ? "/api/rooms/:id/messages"
                  : "/api/pi（单 agent）"}
            </span>
          </span>
          <span>
            {rooms.rooms.length} 个群 · {taskThreads.length} 个线程 · {taskIndex.tasks.length} 个任务
            {taskIndex.live ? " · SSE 已连接" : " · SSE 未连接（轮询兜底）"}
          </span>
        </footer>
      </div>
    </MentionProvider>
  );
}
