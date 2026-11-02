/**
 * ChatRoom → Pi thread projection (I7, Q29: "一个群 = 一个 thread").
 *
 * The room's shared message stream (`room_messages`, ordered by `seq`) becomes
 * the thread's transcript; the room's Tasks become the thread's *status*, never
 * extra transcript messages. Two rules drive every decision below:
 *
 *  1. **Attribution is load-bearing** (AC2.2 / AC9.2). `PiAgentMessage.role`
 *     cannot say "the architect 高见远 said this", so every non-user message is
 *     carried as `role: "custom"` — the one contract-native message role with a
 *     free-form metadata channel (`PiCustomMessage.details`,
 *     `@assistant-ui/react-pi/src/types.ts:132-140`). react-pi forwards it to
 *     the UI: `runtime/messageProjection.ts:384-401` projects a displayed
 *     `custom` message into a `data` part named `pi-custom-message` carrying
 *     `{ customType, details }` plus the text parts.
 *  2. **Only committed words are shown.** An agent's reply enters the stream in
 *     the same transaction as its Task's success (Q39). A group thread therefore
 *     shows the stream plus `status: "running"`, and deliberately does NOT relay
 *     a running Task's raw `message_update` text: that text is a draft (it can
 *     be a JSON envelope) which the committed `result.summary` later replaces
 *     with different words. Rendering it would put an attributed statement in
 *     the chat that the agent never finished saying.
 *
 * Pure by construction: state in, Pi shapes out — no database, no clock, no
 * model. That is what lets `pi-room-thread.test.ts` assert the exact fields the
 * real client validates (`client/validation.ts`), which silently *drops* a
 * malformed message instead of reporting it.
 */

import type { PiAgentMessage, PiThreadMetadata, PiThreadSnapshot } from "@assistant-ui/react-pi";
import type { TaskRecord, TaskStatus } from "@my-team-agents/orchestrator";

/**
 * Structural views of the domain entities. The server package does not declare
 * `@my-team-agents/domain` as a dependency (it reaches rooms through
 * `RoomStore`), so this projection names the *shape* it consumes rather than
 * adding a workspace dependency for a type import. `RoomStore`'s real return
 * types satisfy these structurally.
 */
export interface RoomView {
  id: string;
  projectId: string;
  name: string;
  description: string;
  createdAt: number;
}

export interface RoomAgentView {
  id: string;
  name: string;
  role: string;
  emoji: string | null;
  color: string | null;
  isCoordinator: boolean;
}

export type RoomAuthorKind = "user" | "agent" | "system";

export interface RoomMessageView {
  id: string;
  roomId: string;
  /** Monotonic per room — the display order (never timestamps). */
  seq: number;
  authorKind: RoomAuthorKind;
  authorAgentId: string | null;
  content: string;
  taskId: string | null;
  createdAt: number;
}

/** `details` payload carried by every non-user projected room message. */
export interface RoomMessageDetails {
  authorKind: RoomAuthorKind;
  messageId: string;
  seq: number;
  agentId: string | null;
  name: string;
  role: string;
  emoji: string | null;
  color: string | null;
  isCoordinator: boolean;
  taskId: string | null;
}

/** `customType` values this projection emits. The UI switches on these (I8). */
export const ROOM_AGENT_CUSTOM_TYPE = "room-agent";
export const ROOM_SYSTEM_CUSTOM_TYPE = "room-system";

const USER_DISPLAY_NAME = "用户";
const SYSTEM_DISPLAY_NAME = "系统";

/** Same active set as the Task projection: queued work is still in flight. */
const RUNNING: ReadonlySet<TaskStatus> = new Set(["queued", "running", "retry_wait", "cancelling"]);

/**
 * A room thread is `running` while ANY of the room's Tasks is active — the round
 * is in flight until its Task reaches a terminal status. It is `failed` only
 * when nothing is active and the most recently updated Task ended `failed` or
 * `blocked` (mirroring the single-Task mapping, so a red thread always names a
 * real failed execution). Everything else — including `terminated` — is `idle`.
 *
 * Deliberately NOT consulted: `roundCount`, `chain`, `maxRounds`, `terminated`.
 * A room's flow state bounds *future* triggers; it says nothing about whether
 * work is in flight now, and reporting it as thread status would be a guess.
 * `terminated` still reaches the UI where it belongs: as the system message the
 * guard writes into the stream (I6/Q40).
 */
export function roomThreadStatus(tasks: readonly TaskRecord[]): PiThreadMetadata["status"] {
  if (tasks.some((task) => RUNNING.has(task.status))) return "running";
  const latest = latestTask(tasks);
  if (latest && (latest.status === "failed" || latest.status === "blocked")) return "failed";
  return "idle";
}

/** The room Task whose work is in flight; used for `runningRunId`. */
export function roomActiveTask(tasks: readonly TaskRecord[]): TaskRecord | undefined {
  return tasks.find((task) => RUNNING.has(task.status));
}

const byUpdatedDesc = (a: TaskRecord, b: TaskRecord): number => b.updatedAt - a.updatedAt;

function latestTask(tasks: readonly TaskRecord[]): TaskRecord | undefined {
  return [...tasks].sort(byUpdatedDesc)[0];
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Author identity for one room message. An `agent` message whose persona is gone
 * keeps its `agentId` and says so in `name` — dropping the identity, or passing
 * it off as the system, would rewrite history (same rule as `authorLabel` in
 * `room-trigger.ts`, which prefers the raw id over nothing).
 */
export function roomMessageDetails(
  message: RoomMessageView,
  agents: readonly RoomAgentView[],
): RoomMessageDetails {
  if (message.authorKind === "agent") {
    const agentId = message.authorAgentId;
    const agent = agentId ? agents.find((candidate) => candidate.id === agentId) : undefined;
    return {
      authorKind: "agent",
      messageId: message.id,
      seq: message.seq,
      agentId,
      name: agent?.name ?? agentId ?? "未知成员",
      role: agent?.role ?? "",
      emoji: agent?.emoji ?? null,
      color: agent?.color ?? null,
      isCoordinator: agent?.isCoordinator ?? false,
      taskId: message.taskId,
    };
  }
  const system = message.authorKind === "system";
  return {
    authorKind: system ? "system" : "user",
    messageId: message.id,
    seq: message.seq,
    agentId: null,
    name: system ? SYSTEM_DISPLAY_NAME : USER_DISPLAY_NAME,
    role: "",
    emoji: null,
    color: null,
    isCoordinator: false,
    taskId: message.taskId,
  };
}

/**
 * One room message as a `PiAgentMessage`.
 *
 * - `user` → native `role: "user"`. It must stay native: react-pi confirms the
 *   composer's optimistic copy with `userContentKey`, which returns a key ONLY for
 *   `role: "user"` messages and `null` otherwise (`ThreadController.ts:382-391`,
 *   read from the installed source; not exercised by a test here, unlike the
 *   `details`/`display` behaviour below which is). Echoing the user turn as
 *   `custom` could therefore never be confirmed, so the optimistic copy would
 *   stack up next to the real message.
 * - `agent` / `system` → `role: "custom"`: within the roles this projection can
 *   emit for plain authored prose, it is the one carrying a free-form `details`
 *   that reaches the UI (`pi-thread.test.ts` asserts the rendered data part, and
 *   `pi-room-client.test.ts` asserts it through the real client).
 *   `display: true` is load-bearing: `display: false` is skipped entirely by the
 *   projector (`messageProjection.ts:387`), so the message would sit in the
 *   transcript and never render.
 *
 * The text is NEVER prefixed with the author's name — the identity lives in
 * `details`, and smuggling it into the body would make the transcript claim an
 * agent said its own name, then double up once the UI renders the avatar.
 */
export function roomMessageToPiMessage(
  message: RoomMessageView,
  agents: readonly RoomAgentView[],
): PiAgentMessage {
  if (message.authorKind === "user") {
    return { role: "user", content: message.content, timestamp: message.createdAt };
  }
  const details = roomMessageDetails(message, agents);
  return {
    role: "custom",
    customType: message.authorKind === "system" ? ROOM_SYSTEM_CUSTOM_TYPE : ROOM_AGENT_CUSTOM_TYPE,
    content: [{ type: "text", text: message.content }],
    display: true,
    details,
    timestamp: message.createdAt,
  };
}

/** The whole shared stream, ordered by `seq` — never by timestamp. */
export function roomToMessages(
  messages: readonly RoomMessageView[],
  agents: readonly RoomAgentView[],
): PiAgentMessage[] {
  return [...messages]
    .sort((a, b) => a.seq - b.seq)
    .map((message) => roomMessageToPiMessage(message, agents));
}

export interface RoomThreadInput {
  /** Projected thread id (`room:<id>`), NOT the raw room id. */
  threadId: string;
  room: RoomView;
  /** The room's members; resolve an agent message's identity from these. */
  agents?: readonly RoomAgentView[];
  messages: readonly RoomMessageView[];
  tasks: readonly TaskRecord[];
  /** Persisted thread flag (`archived` is a contract field). */
  archived?: boolean;
  /** Thread-local rename; falls back to the room name. */
  title?: string | null;
  /** Workspace the room's Tasks run against — the project's, not a persona dir. */
  workspacePath: string;
  /** Flow-state timestamp, folded into `updatedAt` only — never into status. */
  stateUpdatedAt?: number;
  /** Thread sequence this snapshot reflects. */
  seq?: number;
}

export function roomToThreadMetadata(input: RoomThreadInput): PiThreadMetadata {
  const { room, messages, tasks } = input;
  const status = roomThreadStatus(tasks);
  const active = status === "running" ? roomActiveTask(tasks) : undefined;
  const updatedAt = Math.max(
    room.createdAt,
    input.stateUpdatedAt ?? 0,
    ...messages.map((message) => message.createdAt),
    ...tasks.map((task) => task.updatedAt),
  );
  return {
    id: input.threadId,
    title: input.title?.trim() || room.name,
    workspacePath: input.workspacePath,
    archived: input.archived ?? false,
    status,
    // The in-flight Attempt of the active room Task, when there is one. Absent
    // rather than invented: a room is not itself a run.
    ...(active?.activeAttemptId ? { runningRunId: active.activeAttemptId } : {}),
    messageCount: messages.length,
    createdAt: iso(room.createdAt),
    updatedAt: iso(updatedAt),
  };
}

export function roomToSnapshot(input: RoomThreadInput): PiThreadSnapshot {
  const agents = input.agents ?? [];
  const messages = roomToMessages(input.messages, agents);
  const failures = input.tasks
    .filter((task) => task.status === "failed" && task.error)
    .sort(byUpdatedDesc);
  return {
    metadata: roomToThreadMetadata(input),
    messages,
    ...(input.seq === undefined ? {} : { seq: input.seq }),
    // Newest failure first: `lastError` is one slot, and the most recent failure
    // is the one the UI would otherwise never learn about.
    ...(failures.length > 0 ? { lastError: failures[0]!.error ?? undefined } : {}),
  };
}
