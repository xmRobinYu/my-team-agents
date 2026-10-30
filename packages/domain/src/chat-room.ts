/**
 * ChatRoom — the entity that carries a shared message stream, its rules, and
 * its own set of agents.
 *
 * Deliberately distinct from `Group`: a Group is a collaboration *view* over a
 * project, and a view cannot hold messages, members or rules (Q33).
 */

/** Who produced a message in the shared stream. */
export type AuthorKind = "user" | "agent" | "system";

export interface ChatRoom {
  id: string;
  projectId: string;
  name: string;
  description: string;
  /** Markdown room rules imported from the template package. */
  rules: string;
  /** Agent that must wrap up when the round cap is hit (Q30). Nullable: not every package declares one. */
  coordinatorAgentId: string | null;
  /** Hard cap on agent triggers per user turn (Q29/Q30). */
  maxRounds: number;
  createdAt: number;
}

export interface RoomAgent {
  id: string;
  roomId: string;
  name: string;
  role: string;
  /** Full role prompt, including the template's YAML frontmatter. */
  prompt: string;
  /** Isolated persona directory: cwd + skills + AGENTS.md (Q29). */
  agentDir: string;
  model: string | null;
  thinkingMode: string | null;
  emoji: string | null;
  color: string | null;
  isCoordinator: boolean;
  createdAt: number;
}

export interface RoomMessage {
  id: string;
  roomId: string;
  /** Monotonic per room; defines display order in the shared stream. */
  seq: number;
  authorKind: AuthorKind;
  /** Set when authorKind === "agent". */
  authorAgentId: string | null;
  content: string;
  /** Task that produced this message, when it came from an execution. */
  taskId: string | null;
  createdAt: number;
}

/**
 * Mutable flow-control state for a room. Persisted, never in memory (Q28/Q29):
 * upstream teamagentx keeps this in an in-memory Map and accepts losing it on
 * restart; we do not inherit that.
 */
export interface RoomState {
  roomId: string;
  /** Agent triggers since the last user message. One trigger = one round (Q30). */
  roundCount: number;
  /** Agent ids already triggered in the current user turn, in order. Drives loop detection. */
  chain: string[];
  terminated: boolean;
  updatedAt: number;
}

export const DEFAULT_MAX_ROUNDS = 5;

/** Termination marker emitted by the coordinator (Q29). */
export const TERMINATION_MARKER = "[讨论结束]";

export const EMPTY_ROOM_STATE = (roomId: string, updatedAt = 0): RoomState => ({
  roomId,
  roundCount: 0,
  chain: [],
  terminated: false,
  updatedAt,
});
