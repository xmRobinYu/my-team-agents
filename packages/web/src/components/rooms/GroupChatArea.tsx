/**
 * Group chat area (AC9.1 column 2, AC9.2 authored stream, AC9.3 `@` input).
 *
 * The stream is drawn from `RoomTurn`s — the author model in `rooms/project.ts` —
 * never from a message `role`, and the composer writes through the room's Pi
 * thread (`POST /api/pi/threads/room:<id>/messages`, i.e. `postRoomMessage` behind
 * it). The single-agent path lives in `TaskThreadArea`; the two never share a send
 * path, because a room turn is a mention trigger that queues Tasks while a thread
 * turn is a Pi prompt.
 *
 * What the stream shows after a send: I7's 201 body carries the thread snapshot,
 * so that snapshot is adopted immediately (the user sees their own committed row
 * and the room goes `running` without waiting for the next SSE frame). When the
 * server answers without one, the committed row is echoed instead, and both are
 * reconciled against the polled/`turns` stream by `seq` — which is why a duplicate
 * can never appear.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { RoomSendResult } from "../../rooms/api";
import type { RoomAgent } from "../../rooms/types";
import { turnsFromPiSnapshot, turnsFromRoomMessages, type RoomTurn } from "../../rooms/project";
import { roomThreadId } from "../../rooms/threadId";
import { RoomMessageItem } from "./RoomMessageItem";
import { RoomComposer, type ComposerHandle } from "./RoomComposer";
import { alertBlockedText } from "./blockedNotice";

export interface GroupChatAreaProps {
  /** The composer registers itself here so the member panel can mention through it. */
  composerHandle: RefObject<ComposerHandle | null>;
  roomId: string;
  roomName: string;
  roomDescription: string;
  agents: readonly RoomAgent[];
  agentsLoading: boolean;
  agentsError: string | null;
  turns: RoomTurn[];
  feedLoading: boolean;
  feedError: string | null;
  feedOrigin: "pi-thread" | "rooms-api" | "none";
  /** Any of this room's Tasks are in flight (drives the "working" strip). */
  busy: boolean;
  onReloadFeed: () => void;
}

/**
 * Merge the authoritative stream with locally-held rows. Order is `seq` — never
 * insertion order, never timestamps. A locally adopted snapshot replaces the
 * projection entirely until the next feed read catches up, and the feed's own rows
 * then win because they carry the same keys.
 */
function mergeTurns(base: readonly RoomTurn[], adopted: readonly RoomTurn[], pending: readonly RoomTurn[]): RoomTurn[] {
  const source = adopted.length > 0 ? adopted : base;
  const bySeq = new Map<number, RoomTurn>();
  const extras: RoomTurn[] = [];
  for (const turn of [...source, ...base]) {
    if (turn.seq === null) extras.push(turn);
    else bySeq.set(turn.seq, turn);
  }
  for (const turn of pending) {
    if (turn.seq === null) continue;
    bySeq.set(turn.seq, turn);
  }
  const known = new Set([...bySeq.keys(), ...extras.filter((turn) => turn.seq !== null).map((turn) => turn.seq as number)]);
  for (const turn of extras) if (!known.has(turn.seq as number)) bySeq.set(turn.seq as number, turn);
  return [...bySeq.values()].sort((a, b) => (a.seq ?? -1) - (b.seq ?? -1));
}

export function GroupChatArea({
  composerHandle,
  roomId,
  roomName,
  roomDescription,
  agents,
  agentsLoading,
  agentsError,
  turns,
  feedLoading,
  feedError,
  feedOrigin,
  busy,
  onReloadFeed,
}: GroupChatAreaProps) {
  const [pending, setPending] = useState<RoomTurn[]>([]);
  const [adopted, setAdopted] = useState<RoomTurn[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const visible = useMemo(() => mergeTurns(turns, adopted, pending), [turns, adopted, pending]);

  // Once the refetch carries what we adopted/echoed, drop the local copies: they
  // exist only to cover the gap between "committed" and "seen".
  useEffect(() => {
    if (adopted.length === 0 && pending.length === 0) return;
    const settled = new Set(turns.filter((turn) => turn.seq !== null).map((turn) => turn.seq as number));
    if (adopted.length > 0 && adopted.every((turn) => turn.seq !== null && settled.has(turn.seq))) setAdopted([]);
    if (pending.length > 0) {
      const still = pending.filter((turn) => turn.seq === null || !settled.has(turn.seq));
      if (still.length !== pending.length) setPending(still);
    }
  }, [turns, adopted, pending]);

  // Keep the newest turn in view, without stealing scroll from a user who has
  // scrolled up to read history.
  const lastKey = visible.length > 0 ? visible[visible.length - 1]!.key : "";
  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (distance < 160) node.scrollTop = node.scrollHeight;
  }, [lastKey, visible.length]);

  /**
   * The composer already POSTed to the room's Pi thread. Its 201 body carries the
   * committed row, the Tasks, the guard blocks and — I7 — the thread snapshot
   * right after the commit, so adopt the snapshot when present. Re-posting would
   * append a SECOND message and queue a second round of Tasks.
   */
  const handleCommitted = (result: RoomSendResult) => {
    const fromSnapshot = turnsFromPiSnapshot(result.snapshot, agents);
    if (fromSnapshot) {
      setAdopted(fromSnapshot);
    } else {
      const echoed = turnsFromRoomMessages([result.message], agents);
      setPending((current) =>
        current.some((turn) => turn.key === result.message.id) ? current : [...current, ...echoed],
      );
    }
    setNotice(alertBlockedText(result.blocked, (id) => agents.find((agent) => agent.id === id)?.name ?? id));
    onReloadFeed();
  };

  return (
    <section className="card thread-card room-card" data-testid="group-chat">
      <header className="thread-head room-head">
        <div className="room-head-main">
          <h2 data-testid="room-title">{roomName}</h2>
          <p className="card-sub" data-testid="room-subtitle">
            {roomDescription.trim() === "" ? "（无群简介）" : roomDescription.trim()}
          </p>
        </div>
        <div className="room-head-badges">
          <span
            className={`badge ${feedOrigin === "pi-thread" ? "badge-active" : "badge-neutral"}`}
            title={
              feedOrigin === "pi-thread"
                ? "消息流来自 I7 的 Pi 线程投影 GET /api/pi/threads/room:<id>"
                : "该服务端未投影群线程：消息流读自权威源 GET /api/rooms/:id/messages"
            }
            data-testid="feed-origin"
          >
            {feedOrigin === "pi-thread" ? "Pi 线程投影" : "群消息流（rooms API）"}
          </span>
          <span
            className="badge badge-neutral mono"
            title="该群投影成的 Pi 线程 id（Q29：一个群 = 一个线程）"
            data-testid="room-thread-id"
          >
            {roomThreadId(roomId)}
          </span>
          {busy ? <span className="badge badge-active" data-testid="room-busy">agent 执行中</span> : null}
        </div>
      </header>

      <div className="thread-viewport room-viewport" ref={viewportRef} data-testid="room-viewport">
        {feedError ? <p className="inline-error">消息流读取失败：{feedError}</p> : null}
        {notice ? (
          <p className="inline-note" data-testid="guard-notice" role="status">
            {notice}
          </p>
        ) : null}
        {agentsError ? <p className="inline-note">成员读取失败：{agentsError}（输入框暂时无法校验 @）</p> : null}

        {visible.length === 0 ? (
          <div className="empty-thread">
            {feedLoading || agentsLoading ? "载入群消息中…" : "还没有消息。用下方输入框 @ 一个成员开始讨论。"}
          </div>
        ) : (
          visible.map((turn) => <RoomMessageItem key={turn.key} turn={turn} />)
        )}
      </div>

      <RoomComposer
        ref={composerHandle}
        roomId={roomId}
        agents={agents}
        onCommitted={handleCommitted}
        disabled={agents.length === 0 && !agentsLoading}
        disabledReason={agentsError ? "成员加载失败，先修复后使用 @" : "本群还没有成员，@ 无法解析"}
        draftKey={roomId}
      />
    </section>
  );
}
