/**
 * Room data hooks (I8) — per-room rosters and the durable Task index.
 *
 * `useRoomRosters` exists because the conversation list (AC9.1) wants to show a
 * room's size and roster without waiting for the user to open it. It reads only
 * the member endpoint, once per room, and keeps a failed roster as `null` rather
 * than laundering it into "this room has 0 agents".
 *
 * `useTaskIndex` reads the P6 task spine (`GET /api/tasks` + the existing
 * `/api/events` snapshot) and exposes what makes three UI facts cheap and honest:
 *   - "this room is working" — a group Task carries `groupId === roomId` (I3);
 *   - per-member Task counts in the panel;
 *   - which Task the P6 evidence panel should point at when a room is selected.
 * Its `revision` is what wakes the room feed on a task change, so the page holds
 * exactly one EventSource instead of one per hook.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchTasks, openTasksSnapshot } from "../api/client";
import type { TaskRecord } from "../api/types";
import { fetchRoomAgents } from "./api";
import { describeError } from "./errorShape";
import type { RoomAgent } from "./types";

export interface RosterState {
  /** roomId -> members, or null when that room's member read failed. */
  agents: Map<string, RoomAgent[] | null>;
  loading: boolean;
  reload: () => void;
}

/** Members of several rooms, in parallel, from one endpoint. */
export function useRoomRosters(roomIds: readonly string[]): RosterState {
  const [agents, setAgents] = useState<Map<string, RoomAgent[] | null>>(new Map());
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const key = roomIds.join("|");
  const idsRef = useRef<readonly string[]>(roomIds);
  idsRef.current = roomIds;

  useEffect(() => {
    if (key === "") {
      setAgents(new Map());
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void Promise.all(
      roomIds.map(async (roomId) => {
        try {
          return [roomId, await fetchRoomAgents(roomId)] as const;
        } catch (error: unknown) {
          // "unknown" and "empty" are different answers: a room whose members
          // cannot be read must not be reported as a room with nobody in it.
          console.warn(`成员读取失败 ${roomId}:`, describeError(error).message);
          return [roomId, null] as const;
        }
      }),
    )
      .then((entries) => {
        if (cancelled) return;
        setAgents(new Map(entries));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the roster signature string
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { agents, loading, reload };
}

const ACTIVE = new Set(["queued", "running", "retry_wait", "cancelling"]);

export interface TaskIndex {
  tasks: TaskRecord[];
  /** `/api/events` connected. */
  live: boolean;
  /** Bumped by every snapshot: the room feed's wake signal. */
  revision: number;
  /** Tasks belonging to one room, newest first. */
  forRoom: (roomId: string) => TaskRecord[];
  /** Any Task by id (a single-agent thread id IS its Task id). */
  byId: (taskId: string) => TaskRecord | undefined;
}

/** The durable Task spine, kept fresh by the existing global SSE snapshot. */
export function useTaskIndex(): TaskIndex {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [live, setLive] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchTasks()
      .then((value) => {
        if (!cancelled) setTasks(value);
      })
      .catch(() => {
        /* the snapshot supplies them */
      });
    const stream = openTasksSnapshot((value) => {
      setTasks(value);
      setRevision((current) => current + 1);
    });
    const unsubscribe = stream.subscribeStatus(setLive);
    return () => {
      cancelled = true;
      unsubscribe();
      stream.close();
    };
  }, []);

  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const forRoom = useCallback(
    (roomId: string) =>
      tasks.filter((task) => task.groupId === roomId).sort((a, b) => b.updatedAt - a.updatedAt),
    [tasks],
  );

  return { tasks, live, revision, forRoom, byId: (taskId: string) => byId.get(taskId) };
}

/** Whether work is in flight: one room's Tasks, or the whole store for a room-less view. */
export function indexIsBusy(index: TaskIndex, roomId: string | null): boolean {
  return roomId === null
    ? index.tasks.some((task) => ACTIVE.has(task.status))
    : index.forRoom(roomId).some((task) => ACTIVE.has(task.status));
}

/** Per-member Task counts for the member panel (total, and still in flight). */
export function taskCountsByMember(tasks: readonly TaskRecord[]): Map<string, { total: number; active: number }> {
  const counts = new Map<string, { total: number; active: number }>();
  for (const task of tasks) {
    const current = counts.get(task.memberId) ?? { total: 0, active: 0 };
    counts.set(task.memberId, {
      total: current.total + 1,
      active: current.active + (ACTIVE.has(task.status) ? 1 : 0),
    });
  }
  return counts;
}
