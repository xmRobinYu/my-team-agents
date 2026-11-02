/**
 * Conversation list (AC9.1, column 1) — rooms and single-agent threads side by
 * side, and visibly different kinds.
 *
 * Why the two sources are merged here instead of filtering the Pi thread list:
 * `/api/rooms` is the room ENTITY list — it answers "there is a group called
 * 全栈软件研发 with 5 members" even when the group has never produced a Task, and
 * a group with no Task is exactly the state right after an import (I1–I6 ship
 * that state today). A thread list cannot represent a thing that has no thread,
 * so building the roster from `/api/pi/threads` would make a freshly imported room
 * invisible until someone mentioned an agent.
 *
 * Once I7 projects a ChatRoom as a Pi thread (`room:<id>`, see
 * `rooms/threadId.ts`), the room row and that thread are the same conversation:
 * `buildConversationRows` folds a `room:`-namespaced thread into its room row
 * instead of listing it twice, and the caller only offers the runtime switch for
 * rooms that really do have a thread.
 */

import { useMemo } from "react";
import { authorFromAgent } from "../../rooms/author";
import { parseRoomThreadId } from "../../rooms/threadId";
import type { ChatRoom, RoomAgent } from "../../rooms/types";
import { RoomAvatarStack } from "./RoomAvatar";

export type ConversationKind = "room" | "task";

/**
 * A Pi thread as the UI sees it, normalised from a runtime thread-list item.
 * Fields are required-but-undefined rather than optional so a type predicate over
 * a mapped array stays assignable.
 */
export interface ThreadRow {
  id: string;
  title: string | undefined;
  status: string | undefined;
  lastMessageAt: Date | undefined;
}

export interface ConversationRow {
  key: string;
  kind: ConversationKind;
  /** Room id for a group; Pi thread id for a single-agent task. */
  id: string;
  title: string;
  subtitle: string;
  agents: readonly RoomAgent[];
  status: string | undefined;
}

/** Merge the two sources: rooms first (newest import on top), then stray threads. */
export function buildConversationRows(
  rooms: readonly ChatRoom[],
  roomAgents: ReadonlyMap<string, readonly RoomAgent[]>,
  threads: readonly ThreadRow[],
): ConversationRow[] {
  const roomRows: ConversationRow[] = [...rooms]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((room) => {
      const agents = roomAgents.get(room.id) ?? [];
      const roster =
        agents.length === 0
          ? room.description.trim() === ""
            ? "还没有成员（导入团队包后这里会列出 agent）"
            : room.description.trim()
          : `${agents.length} 个 agent · ${agents
              .map((agent) => agent.name)
              .slice(0, 3)
              .join("、")}${agents.length > 3 ? "…" : ""}`;
      return {
        key: `room:${room.id}`,
        kind: "room" as ConversationKind,
        id: room.id,
        title: room.name,
        subtitle: roster,
        agents,
        status: undefined,
      };
    });

  const covered = new Set(roomRows.map((row) => `room:${row.id}`));
  const threadRows: ConversationRow[] = threads
    .filter((thread) => !covered.has(thread.id))
    .map((thread) => {
      const roomId = parseRoomThreadId(thread.id);
      return {
        key: thread.id,
        kind: (roomId === null ? "task" : "room") as ConversationKind,
        id: thread.id,
        title: thread.title && thread.title.trim() !== "" ? thread.title : "（未命名会话）",
        subtitle: roomId === null ? "单 agent 任务 · Task == Thread" : `群聊线程（I7 投影）· ${roomId}`,
        agents: [],
        status: thread.status,
      };
    });

  return [...roomRows, ...threadRows];
}

export function useConversationRows(
  rooms: readonly ChatRoom[],
  roomAgents: ReadonlyMap<string, readonly RoomAgent[]>,
  threads: readonly ThreadRow[],
): ConversationRow[] {
  return useMemo(() => buildConversationRows(rooms, roomAgents, threads), [rooms, roomAgents, threads]);
}

export interface ConversationListProps {
  rooms: readonly ChatRoom[];
  roomAgents: ReadonlyMap<string, readonly RoomAgent[]>;
  taskThreads: readonly ThreadRow[];
  selectedKey: string | null;
  /** `(kind, id)`: a room id or a Pi thread id — the caller decides what to open. */
  onSelect: (kind: ConversationKind, id: string) => void;
  onNewThread: () => void;
  roomsLoading: boolean;
  roomsError: string | null;
  onReloadRooms: () => void;
}

export function ConversationList({
  rooms,
  roomAgents,
  taskThreads,
  selectedKey,
  onSelect,
  onNewThread,
  roomsLoading,
  roomsError,
  onReloadRooms,
}: ConversationListProps) {
  const rows = useConversationRows(rooms, roomAgents, taskThreads);
  const roomCount = rows.filter((row) => row.kind === "room").length;
  const taskCount = rows.filter((row) => row.kind === "task").length;

  return (
    <section className="card conversation-panel" data-testid="conversation-list">
      <header className="card-head">
        <div>
          <h2>会话</h2>
          <p className="card-sub">
            群 {roomCount} · 单 agent {taskCount}
          </p>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={onNewThread} data-testid="new-thread">
          新建任务
        </button>
      </header>

      {roomsError ? (
        <div className="inline-error">
          群列表读取失败：{roomsError}{" "}
          <button type="button" className="link-btn" onClick={onReloadRooms}>
            重试
          </button>
        </div>
      ) : null}

      <div className="task-scroll conversation-scroll" data-testid="conversation-rows">
        {rows.length === 0 ? (
          <p className="empty-hint pad">
            {roomsLoading
              ? "载入群列表中…"
              : "还没有群，也没有任务线程。导入一个团队模板包（POST /api/rooms/import）后，群会出现在这里。"}
          </p>
        ) : (
          rows.map((row) => (
            <button
              key={row.key}
              type="button"
              className={`task-item conversation-item${row.key === selectedKey ? " task-item-active" : ""}`}
              onClick={() => onSelect(row.kind, row.id)}
              data-testid={`conversation-${row.kind}-${row.id}`}
              data-kind={row.kind}
            >
              <span className="conversation-item-top">
                <span className={`kind-badge kind-badge-${row.kind}`} data-testid={`kind-badge-${row.kind}`}>
                  {row.kind === "room" ? "群聊" : "单 agent"}
                </span>
                {row.kind === "room" && row.agents.length > 0 ? (
                  <RoomAvatarStack authors={row.agents.map((agent) => authorFromAgent(agent))} limit={4} />
                ) : row.status ? (
                  <span className="badge badge-neutral">{row.status}</span>
                ) : null}
              </span>
              <span className="task-item-title">{row.title}</span>
              <span className="conversation-item-sub muted">{row.subtitle}</span>
            </button>
          ))
        )}
      </div>

      <div className="foot-note">
        群来自 <span className="mono">GET /api/rooms</span>（I7 接线后仍走这一行，线程 id 为{" "}
        <span className="mono">room:&lt;id&gt;</span>）；单 agent 会话是 <span className="mono">/api/pi/threads</span>{" "}
        投影的 Task 线程。
      </div>
    </section>
  );
}
