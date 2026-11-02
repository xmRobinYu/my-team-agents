/**
 * Room data hooks (I8).
 *
 * One source of truth per concern, one seam per transport:
 *
 *  - `useRoomList`   — GET /api/rooms: the room ENTITY list that seeds column 1.
 *                      Never derived from `/api/pi/threads`, because a freshly
 *                      imported room has no Task and therefore no thread — it
 *                      would be invisible until somebody mentioned an agent.
 *  - `useRoomAgents` — GET /api/rooms/:id/agents: one fetch feeding BOTH the
 *                      member panel (AC9.4) and the `@` picker (AC9.3), so the
 *                      two cannot disagree about who exists.
 *  - `useRoomFeed`   — the shared stream: I7's Pi room thread when the projection
 *                      answers (it does now), the authoritative room rows as the
 *                      fallback for a server that does not serve it yet.
 *
 * Liveness without Socket.io (Q27): the room thread is a real PiClient thread, so
 * the runtime's own SSE carries agent replies. This hook additionally polls and
 * wakes on the caller's task-snapshot `revision`, which is the fallback feed's
 * clock and the belt-and-braces path. No new endpoint, no second protocol.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchRoomAgents, fetchRoomMessages, fetchRooms } from "./api";
import { describeError } from "./errorShape";
import { fetchPiRoomSnapshot } from "./piProbe";
import { projectPiRoomMessages, turnsFromRoomMessages, type RoomTurn } from "./project";
import type { ChatRoom, RoomAgent } from "./types";

export interface LoadState<T> {
  data: T;
  loading: boolean;
  error: string | null;
  /** True when the endpoint itself is missing (404): a gap, not a breakage. */
  missing: boolean;
  reload: () => void;
}

/** GET /api/rooms. */
export function useRoomList(): LoadState<ChatRoom[]> & { rooms: ChatRoom[] } {
  const [data, setData] = useState<ChatRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchRooms()
      .then((rooms) => {
        if (cancelled) return;
        setData(rooms);
        setError(null);
        setMissing(false);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        const described = describeError(reason);
        setError(described.message);
        setMissing(described.missing);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, rooms: data, loading, error, missing, reload };
}

/** GET /api/rooms/:id/agents — the members of one room. */
export function useRoomAgents(roomId: string | null): LoadState<RoomAgent[]> & { agents: RoomAgent[] } {
  const [data, setData] = useState<RoomAgent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!roomId) {
      setData([]);
      setLoading(false);
      setError(null);
      setMissing(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchRoomAgents(roomId)
      .then((agents) => {
        if (cancelled) return;
        setData(agents);
        setError(null);
        setMissing(false);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        const described = describeError(reason);
        setError(described.message);
        setMissing(described.missing);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [roomId, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, agents: data, loading, error, missing, reload };
}

const IDLE_POLL_MS = 6_000;
const BUSY_POLL_MS = 1_500;
/** A burst of task snapshots must not become a burst of stream reads. */
const WAKE_DEBOUNCE_MS = 400;

export interface RoomFeedState {
  turns: RoomTurn[];
  loading: boolean;
  error: string | null;
  missing: boolean;
  /** Where the stream actually came from — the badge that keeps the UI honest. */
  origin: "pi-thread" | "rooms-api" | "none";
  reload: () => void;
}

/**
 * The shared stream of one room, as authored turns.
 *
 * `busy` (the room has Tasks in flight) shortens the poll; `revision` (the
 * caller's task-snapshot counter) wakes it immediately. The effect is keyed on
 * `rosterKey` rather than the array identity, so the usual ordering — stream
 * first, members a moment later — re-projects with real names instead of leaving
 * ids on screen, without refetching on every parent render.
 */
export function useRoomFeed(
  roomId: string | null,
  agents: readonly RoomAgent[],
  options?: { busy?: boolean; revision?: number },
): RoomFeedState {
  const busy = options?.busy ?? false;
  const revision = options?.revision ?? 0;
  const [turns, setTurns] = useState<RoomTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [origin, setOrigin] = useState<RoomFeedState["origin"]>("none");
  const [nonce, setNonce] = useState(0);
  const rosterKey = agents.map((agent) => agent.id).join("|");

  useEffect(() => {
    if (!roomId) {
      setTurns([]);
      setLoading(false);
      setError(null);
      setMissing(false);
      setOrigin("none");
      return;
    }
    let cancelled = false;
    setLoading(true);
    void loadRoomFeed(roomId, agents)
      .then((result) => {
        if (cancelled) return;
        setTurns(result.turns);
        setOrigin(result.origin);
        setError(null);
        setMissing(false);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        const described = describeError(reason);
        setError(described.message);
        setMissing(described.missing);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- roster identity is `rosterKey`, not array identity
  }, [roomId, nonce, rosterKey]);

  useEffect(() => {
    if (!roomId) return;
    const interval = setInterval(() => setNonce((value) => value + 1), busy ? BUSY_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(interval);
  }, [roomId, busy]);

  useEffect(() => {
    if (!roomId || revision === 0) return;
    const timer = setTimeout(() => setNonce((value) => value + 1), WAKE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [roomId, revision]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { turns, loading, error, missing, origin, reload };
}

export interface RoomFeedResult {
  turns: RoomTurn[];
  origin: "pi-thread" | "rooms-api";
}

/**
 * THE seam the components read through. `GET /api/pi/threads/room:<id>` is the
 * room thread I7 projects (Q29); the probe answers and the stream is drawn from
 * it. On a server without that projection the probe misses and the authoritative
 * room rows are used — same turns, same author model, no UI change.
 */
export async function loadRoomFeed(roomId: string, agents: readonly RoomAgent[]): Promise<RoomFeedResult> {
  const snapshot = await fetchPiRoomSnapshot(roomId);
  if (snapshot) {
    return { turns: projectPiRoomMessages(snapshot.messages, agents), origin: "pi-thread" };
  }
  const messages = await fetchRoomMessages(roomId, 500);
  return { turns: turnsFromRoomMessages(messages, agents), origin: "rooms-api" };
}
