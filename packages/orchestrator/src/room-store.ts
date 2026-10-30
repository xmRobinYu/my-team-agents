/**
 * Persistence for ChatRooms: rooms, their agents, the shared message stream,
 * and the flow-control state.
 *
 * Lives beside `ExecutionStore` on the same SQLite file so room state and task
 * state commit under one database. Flow state is persisted on purpose: upstream
 * teamagentx keeps rounds/chain/terminated in an in-memory Map and accepts
 * losing them on restart (its AC3.4); we do not (Q28/Q29).
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { DEFAULT_MAX_ROUNDS, EMPTY_ROOM_STATE } from "@my-team-agents/domain";
import type { AuthorKind, ChatRoom, RoomAgent, RoomMessage, RoomState } from "@my-team-agents/domain";

export interface CreateRoomInput {
  projectId: string;
  name: string;
  description?: string;
  rules?: string;
  coordinatorAgentId?: string | null;
  maxRounds?: number;
}

export interface CreateRoomAgentInput {
  roomId: string;
  name: string;
  role?: string;
  prompt: string;
  agentDir: string;
  model?: string | null;
  thinkingMode?: string | null;
  emoji?: string | null;
  color?: string | null;
  isCoordinator?: boolean;
}

export interface AppendMessageInput {
  roomId: string;
  authorKind: AuthorKind;
  authorAgentId?: string | null;
  content: string;
  taskId?: string | null;
}

interface Row {
  [key: string]: string | number | null | bigint;
}

const asRows = (v: unknown): Row[] => v as Row[];
const asRow = (v: unknown): Row | undefined => v as Row | undefined;
const text = (v: string | number | bigint | null | undefined) =>
  v === null || v === undefined ? null : String(v);
const num = (v: string | number | bigint | null | undefined) =>
  v === null || v === undefined ? 0 : Number(v);
const json = <T>(v: unknown, fallback: T): T => {
  try { return JSON.parse(String(v)) as T; } catch { return fallback; }
};

export class RoomStore {
  readonly db: DatabaseSync;

  private readonly ownsDb: boolean;

  constructor(dbOrFilename: DatabaseSync | string = ":memory:") {
    this.ownsDb = typeof dbOrFilename === "string";
    this.db = this.ownsDb
      ? new DatabaseSync(dbOrFilename as string)
      : (dbOrFilename as DatabaseSync);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_rooms (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        rules TEXT NOT NULL DEFAULT '',
        coordinator_agent_id TEXT,
        max_rounds INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_ROUNDS},
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_agents (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL DEFAULT '',
        agent_dir TEXT NOT NULL,
        model TEXT,
        thinking_mode TEXT,
        emoji TEXT,
        color TEXT,
        is_coordinator INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS room_agents_room ON room_agents(room_id);
      CREATE TABLE IF NOT EXISTS room_messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        author_kind TEXT NOT NULL,
        author_agent_id TEXT,
        content TEXT NOT NULL,
        task_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS room_messages_seq ON room_messages(room_id, seq);
      CREATE TABLE IF NOT EXISTS room_state (
        room_id TEXT PRIMARY KEY REFERENCES chat_rooms(id) ON DELETE CASCADE,
        round_count INTEGER NOT NULL DEFAULT 0,
        chain TEXT NOT NULL DEFAULT '[]',
        terminated INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  /** Only closes a database this instance opened; a shared handle stays open. */
  close(): void {
    if (this.ownsDb) this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const out = fn(); this.db.exec("COMMIT"); return out; }
    catch (err) { this.db.exec("ROLLBACK"); throw err; }
  }

  private one(sql: string, ...args: Array<string | number | null>): Row | undefined {
    return asRow(this.db.prepare(sql).get(...args));
  }

  private all(sql: string, ...args: Array<string | number | null>): Row[] {
    return asRows(this.db.prepare(sql).all(...args));
  }

  private run(sql: string, ...args: Array<string | number | null>): void {
    this.db.prepare(sql).run(...args);
  }

  private roomFrom(row: Row | undefined): ChatRoom | null {
    if (!row) return null;
    return {
      id: text(row.id)!,
      projectId: text(row.project_id)!,
      name: text(row.name)!,
      description: text(row.description) ?? "",
      rules: text(row.rules) ?? "",
      coordinatorAgentId: text(row.coordinator_agent_id),
      maxRounds: num(row.max_rounds) || DEFAULT_MAX_ROUNDS,
      createdAt: num(row.created_at),
    };
  }

  private agentFrom(row: Row): RoomAgent {
    return {
      id: text(row.id)!,
      roomId: text(row.room_id)!,
      name: text(row.name)!,
      role: text(row.role) ?? "",
      prompt: text(row.prompt) ?? "",
      agentDir: text(row.agent_dir)!,
      model: text(row.model),
      thinkingMode: text(row.thinking_mode),
      emoji: text(row.emoji),
      color: text(row.color),
      isCoordinator: num(row.is_coordinator) === 1,
      createdAt: num(row.created_at),
    };
  }

  private messageFrom(row: Row): RoomMessage {
    return {
      id: text(row.id)!,
      roomId: text(row.room_id)!,
      seq: num(row.seq),
      authorKind: text(row.author_kind) as AuthorKind,
      authorAgentId: text(row.author_agent_id),
      content: text(row.content)!,
      taskId: text(row.task_id),
      createdAt: num(row.created_at),
    };
  }

  private stateFrom(row: Row | undefined, roomId: string): RoomState {
    if (!row) return EMPTY_ROOM_STATE(roomId);
    return {
      roomId,
      roundCount: num(row.round_count),
      chain: json<string[]>(row.chain, []),
      terminated: num(row.terminated) === 1,
      updatedAt: num(row.updated_at),
    };
  }

  createRoom(input: CreateRoomInput, now = Date.now()): ChatRoom {
    const id = `room-${randomUUID()}`;
    this.run(`INSERT INTO chat_rooms(
      id,project_id,name,description,rules,coordinator_agent_id,max_rounds,created_at
    ) VALUES(?,?,?,?,?,?,?,?)`,
      id, input.projectId, input.name, input.description ?? "", input.rules ?? "",
      input.coordinatorAgentId ?? null, input.maxRounds ?? DEFAULT_MAX_ROUNDS, now);
    this.run("INSERT OR IGNORE INTO room_state(room_id,updated_at) VALUES(?,?)", id, now);
    return this.getRoom(id)!;
  }

  getRoom(id: string): ChatRoom | null {
    return this.roomFrom(this.one("SELECT * FROM chat_rooms WHERE id = ?", id));
  }

  listRooms(): ChatRoom[] {
    return this.all("SELECT * FROM chat_rooms ORDER BY created_at DESC").map((r) => this.roomFrom(r)!);
  }

  /** Atomically create a room with its agents; a failure leaves nothing behind. */
  createRoomWithAgents(
    room: CreateRoomInput,
    agents: CreateRoomAgentInput[],
    now = Date.now(),
  ): { room: ChatRoom; agents: RoomAgent[] } {
    return this.tx(() => {
      const created = this.createRoom(room, now);
      const createdAgents = agents.map((a) => this.addAgent(a, now));
      return { room: created, agents: createdAgents };
    });
  }

  addAgent(input: CreateRoomAgentInput, now = Date.now()): RoomAgent {
    const id = `agent-${randomUUID()}`;
    this.run(`INSERT INTO room_agents(
      id,room_id,name,role,prompt,agent_dir,model,thinking_mode,emoji,color,is_coordinator,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, input.roomId, input.name, input.role ?? "", input.prompt, input.agentDir,
      input.model ?? null, input.thinkingMode ?? null, input.emoji ?? null, input.color ?? null,
      input.isCoordinator ? 1 : 0, now);
    if (input.isCoordinator) {
      this.run("UPDATE chat_rooms SET coordinator_agent_id=? WHERE id=?", id, input.roomId);
    }
    return this.getAgent(id)!;
  }

  getAgent(id: string): RoomAgent | null {
    const row = this.one("SELECT * FROM room_agents WHERE id = ?", id);
    return row ? this.agentFrom(row) : null;
  }

  listAgents(roomId: string): RoomAgent[] {
    return this.all("SELECT * FROM room_agents WHERE room_id = ? ORDER BY created_at", roomId)
      .map((r) => this.agentFrom(r));
  }

  findAgentByName(roomId: string, name: string): RoomAgent | null {
    const row = this.one("SELECT * FROM room_agents WHERE room_id = ? AND name = ?", roomId, name);
    return row ? this.agentFrom(row) : null;
  }

  appendMessage(input: AppendMessageInput, now = Date.now()): RoomMessage {
    const id = `msg-${randomUUID()}`;
    const seq = this.nextSeq(input.roomId);
    this.run(`INSERT INTO room_messages(
      id,room_id,seq,author_kind,author_agent_id,content,task_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?)`,
      id, input.roomId, seq, input.authorKind, input.authorAgentId ?? null,
      input.content, input.taskId ?? null, now);
    return this.getMessage(id)!;
  }

  private nextSeq(roomId: string): number {
    const row = this.one("SELECT MAX(seq) AS m FROM room_messages WHERE room_id = ?", roomId);
    return num(row?.m) + 1;
  }

  getMessage(id: string): RoomMessage | null {
    const row = this.one("SELECT * FROM room_messages WHERE id = ?", id);
    return row ? this.messageFrom(row) : null;
  }

  listMessages(roomId: string, limit = 500): RoomMessage[] {
    return this.all(
      "SELECT * FROM room_messages WHERE room_id = ? ORDER BY seq DESC LIMIT ?", roomId, limit,
    ).map((r) => this.messageFrom(r)).reverse();
  }

  getState(roomId: string): RoomState {
    return this.stateFrom(this.one("SELECT * FROM room_state WHERE room_id = ?", roomId), roomId);
  }

  /** Reset per-user-turn flow state: rounds, chain and termination (AC4.2/AC5.3/AC6.3). */
  resetState(roomId: string, now = Date.now()): RoomState {
    this.run(`INSERT INTO room_state(room_id,round_count,chain,terminated,updated_at)
      VALUES(?,0,'[]',0,?)
      ON CONFLICT(room_id) DO UPDATE SET round_count=0,chain='[]',terminated=0,updated_at=?`,
      roomId, now, now);
    return this.getState(roomId);
  }

  /** Record one agent trigger. Returns the updated state. */
  recordTrigger(roomId: string, agentId: string, now = Date.now()): RoomState {
    return this.tx(() => {
      const current = this.getState(roomId);
      const chain = [...current.chain, agentId];
      this.run(`UPDATE room_state SET round_count=?,chain=?,updated_at=? WHERE room_id=?`,
        current.roundCount + 1, JSON.stringify(chain), now, roomId);
      return this.getState(roomId);
    });
  }

  markTerminated(roomId: string, now = Date.now()): RoomState {
    this.run(`INSERT INTO room_state(room_id,round_count,chain,terminated,updated_at)
      VALUES(?,0,'[]',1,?)
      ON CONFLICT(room_id) DO UPDATE SET terminated=1,updated_at=?`, roomId, now, now);
    return this.getState(roomId);
  }
}
