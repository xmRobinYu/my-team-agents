import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { CanonicalEvent } from "@my-team-agents/runtime-core";

export type TaskStatus =
  | "queued"
  | "running"
  | "retry_wait"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelling"
  | "cancelled";

export interface TaskResult {
  outcome: "success" | "partial" | "failed";
  summary: string;
  artifacts: Array<{ path: string; description?: string }>;
  remainingRisks: string[];
}

export interface CreateTaskInput {
  tenantId: string;
  projectId: string;
  memberId: string;
  workspacePath: string;
  prompt: string;
  groupId?: string;
  model?: string;
  chainId?: string;
  parentTaskId?: string;
  depth?: number;
  idempotencyKey?: string;
  recoverySnapshot?: string;
  /** Pi session file to resume on the next Attempt (set after a run reports it). */
  sessionFile?: string;
  availableAt?: number;
}

export interface TaskRecord extends CreateTaskInput {
  id: string;
  chainId: string;
  depth: number;
  batch: number;
  batchAttempts: number;
  fencingToken: number;
  status: TaskStatus;
  activeAttemptId: string | null;
  availableAt: number;
  result: TaskResult | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AttemptRecord {
  id: string;
  taskId: string;
  sequence: number;
  batch: number;
  fencingToken: number;
  workerId: string;
  status: "leased" | "running" | "completed" | "failed" | "orphaned" | "cancelled";
  leaseExpiresAt: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface HandoffCommit {
  sourceToolCallId: string;
  toMemberId: string;
  reason: string;
  input: CreateTaskInput;
}

export interface UsageRecord {
  attemptId: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
}

interface Row {
  [key: string]: string | number | null | bigint;
}

const asRows = (value: unknown): Row[] => value as Row[];
const asRow = (value: unknown): Row | undefined => value as Row | undefined;
const text = (v: string | number | bigint | null | undefined) =>
  v === null || v === undefined ? null : String(v);
const num = (v: string | number | bigint | null | undefined) =>
  v === null || v === undefined ? 0 : Number(v);
const json = <T>(v: unknown, fallback: T): T => {
  try { return JSON.parse(String(v)) as T; } catch { return fallback; }
};

/**
 * SQLite source of truth for the durable execution spine.
 *
 * All writes that decide execution ownership are conditional on a fencing token.
 * Runtime calls deliberately live outside this class: no model or tool ever runs
 * inside a database transaction.
 */
export class ExecutionStore {
  readonly db: DatabaseSync;

  constructor(filename = ":memory:") {
    this.db = new DatabaseSync(filename);
    // API and Worker are separate processes; without a busy timeout a
    // concurrent write fails immediately with SQLITE_BUSY instead of waiting.
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chains (
        id TEXT PRIMARY KEY,
        budget_used INTEGER NOT NULL DEFAULT 0,
        visit_counts TEXT NOT NULL DEFAULT '{}',
        cancel_requested INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        chain_id TEXT NOT NULL REFERENCES chains(id),
        parent_task_id TEXT,
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        prompt TEXT NOT NULL,
        group_id TEXT,
        model TEXT,
        depth INTEGER NOT NULL DEFAULT 0,
        batch INTEGER NOT NULL DEFAULT 1,
        batch_attempts INTEGER NOT NULL DEFAULT 0,
        fencing_token INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT UNIQUE,
        recovery_snapshot TEXT,
        session_file TEXT,
        status TEXT NOT NULL,
        active_attempt_id TEXT,
        available_at INTEGER NOT NULL,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_ready ON tasks(status, available_at);
      CREATE INDEX IF NOT EXISTS tasks_chain ON tasks(chain_id);
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        sequence INTEGER NOT NULL,
        batch INTEGER NOT NULL,
        fencing_token INTEGER NOT NULL,
        worker_id TEXT NOT NULL,
        status TEXT NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(task_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS attempts_lease ON attempts(status, lease_expires_at);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        attempt_id TEXT NOT NULL REFERENCES attempts(id),
        attempt_sequence INTEGER NOT NULL,
        event TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(attempt_id, attempt_sequence)
      );
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id, id);
      CREATE TABLE IF NOT EXISTS usage (
        attempt_id TEXT NOT NULL REFERENCES attempts(id),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input INTEGER NOT NULL,
        output INTEGER NOT NULL,
        cache_read INTEGER NOT NULL,
        cache_write INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        total_cost REAL NOT NULL,
        PRIMARY KEY(attempt_id, provider, model)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        source_attempt_id TEXT NOT NULL REFERENCES attempts(id),
        source_tool_call_id TEXT NOT NULL,
        target_member_id TEXT NOT NULL,
        child_task_id TEXT NOT NULL REFERENCES tasks(id),
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at INTEGER NOT NULL,
        UNIQUE(source_tool_call_id, target_member_id)
      );
    `);
  }

  close(): void { this.db.close(); }

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

  private taskFrom(row: Row | undefined): TaskRecord | null {
    if (!row) return null;
    return {
      id: text(row.id)!,
      chainId: text(row.chain_id)!,
      parentTaskId: text(row.parent_task_id) ?? undefined,
      tenantId: text(row.tenant_id)!,
      projectId: text(row.project_id)!,
      memberId: text(row.member_id)!,
      workspacePath: text(row.workspace_path)!,
      prompt: text(row.prompt)!,
      groupId: text(row.group_id) ?? undefined,
      model: text(row.model) ?? undefined,
      depth: num(row.depth),
      batch: num(row.batch),
      batchAttempts: num(row.batch_attempts),
      fencingToken: num(row.fencing_token),
      idempotencyKey: text(row.idempotency_key) ?? undefined,
      recoverySnapshot: text(row.recovery_snapshot) ?? undefined,
      sessionFile: text(row.session_file) ?? undefined,
      status: text(row.status) as TaskStatus,
      activeAttemptId: text(row.active_attempt_id),
      availableAt: num(row.available_at),
      result: row.result ? json<TaskResult | null>(row.result, null) : null,
      error: text(row.error),
      createdAt: num(row.created_at),
      updatedAt: num(row.updated_at),
    };
  }

  private attemptFrom(row: Row): AttemptRecord {
    return {
      id: text(row.id)!, taskId: text(row.task_id)!, sequence: num(row.sequence),
      batch: num(row.batch), fencingToken: num(row.fencing_token),
      workerId: text(row.worker_id)!, status: text(row.status) as AttemptRecord["status"],
      leaseExpiresAt: num(row.lease_expires_at), error: text(row.error),
      createdAt: num(row.created_at), updatedAt: num(row.updated_at),
    };
  }

  private insertTask(input: CreateTaskInput, now: number, forcedId?: string): TaskRecord {
    if (input.idempotencyKey) {
      const existing = this.one("SELECT * FROM tasks WHERE idempotency_key = ?", input.idempotencyKey);
      if (existing) return this.taskFrom(existing)!;
    }
    const id = forcedId ?? `task-${randomUUID()}`;
    const chainId = input.chainId ?? `chain-${randomUUID()}`;
    this.run("INSERT OR IGNORE INTO chains(id) VALUES(?)", chainId);
    this.run(`INSERT INTO tasks(
      id,chain_id,parent_task_id,tenant_id,project_id,member_id,workspace_path,prompt,
      group_id,model,depth,idempotency_key,recovery_snapshot,status,available_at,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)`,
      id, chainId, input.parentTaskId ?? null, input.tenantId, input.projectId,
      input.memberId, input.workspacePath, input.prompt, input.groupId ?? null,
      input.model ?? null, input.depth ?? 0, input.idempotencyKey ?? null,
      input.recoverySnapshot ?? null, input.availableAt ?? now, now, now);
    return this.getTask(id)!;
  }

  createTask(input: CreateTaskInput, now = Date.now()): TaskRecord {
    return this.tx(() => this.insertTask(input, now));
  }

  getTask(id: string): TaskRecord | null {
    return this.taskFrom(this.one("SELECT * FROM tasks WHERE id = ?", id));
  }

  listTasks(limit = 100): TaskRecord[] {
    return this.all("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?", limit)
      .map((r) => this.taskFrom(r)!);
  }

  getAttempts(taskId: string): AttemptRecord[] {
    return this.all("SELECT * FROM attempts WHERE task_id = ? ORDER BY sequence", taskId)
      .map((r) => this.attemptFrom(r));
  }

  getAttempt(id: string): AttemptRecord | null {
    const row = this.one("SELECT * FROM attempts WHERE id = ?", id);
    return row ? this.attemptFrom(row) : null;
  }

  getChain(chainId: string): { budgetUsed: number; visitCounts: Record<string, number>; cancelRequested: boolean } {
    const row = this.one("SELECT * FROM chains WHERE id = ?", chainId);
    return {
      budgetUsed: num(row?.budget_used),
      visitCounts: json<Record<string, number>>(row?.visit_counts, {}),
      cancelRequested: num(row?.cancel_requested) === 1,
    };
  }

  getChainTasks(chainId: string): TaskRecord[] {
    return this.all("SELECT * FROM tasks WHERE chain_id = ? ORDER BY created_at", chainId)
      .map((r) => this.taskFrom(r)!);
  }

  getOutbox(taskId?: string): Array<Record<string, unknown>> {
    const rows = taskId
      ? this.all(`SELECT o.* FROM outbox o JOIN tasks t ON t.id=o.child_task_id
                  WHERE t.parent_task_id=? ORDER BY o.created_at`, taskId)
      : this.all("SELECT * FROM outbox ORDER BY created_at");
    return rows.map((r) => Object.fromEntries(Object.entries(r)));
  }

  private current(attemptId: string, fencingToken: number): Row {
    const row = this.one(`SELECT a.id AS attempt_id,t.* FROM attempts a
      JOIN tasks t ON t.id=a.task_id
      WHERE a.id=? AND a.fencing_token=? AND t.active_attempt_id=? AND t.fencing_token=?`,
      attemptId, fencingToken, attemptId, fencingToken);
    if (!row) throw new Error("stale fencing token: attempt no longer owns the task");
    return row;
  }

  appendEvent(attemptId: string, fencingToken: number, event: CanonicalEvent, now = Date.now()): boolean {
    return this.tx(() => {
      let current: Row;
      try { current = this.current(attemptId, fencingToken); }
      catch { return false; }
      const previous = this.one(
        "SELECT COALESCE(MAX(attempt_sequence),0) AS seq FROM events WHERE attempt_id=?", attemptId);
      const sequence = num(previous?.seq) + 1;
      this.run("INSERT INTO events(task_id,attempt_id,attempt_sequence,event,created_at) VALUES(?,?,?,?,?)",
        text(current.id)!, attemptId, sequence, JSON.stringify(event), now);
      if (event.usage) {
        const u = event.usage;
        this.run(`INSERT INTO usage(attempt_id,provider,model,input,output,cache_read,cache_write,total_tokens,total_cost)
          VALUES(?,?,?,?,?,?,?,?,?)
          ON CONFLICT(attempt_id,provider,model) DO UPDATE SET
            input=MAX(input,excluded.input), output=MAX(output,excluded.output),
            cache_read=MAX(cache_read,excluded.cache_read), cache_write=MAX(cache_write,excluded.cache_write),
            total_tokens=MAX(total_tokens,excluded.total_tokens), total_cost=MAX(total_cost,excluded.total_cost)`,
          attemptId, event.provider ?? "unknown", event.model ?? "unknown",
          u.input, u.output, u.cacheRead, u.cacheWrite, u.totalTokens, u.cost.total);
      }
      return true;
    });
  }

  getEvents(taskId: string, after = 0, limit = 500): Array<{ id: number; attemptId: string; sequence: number; event: CanonicalEvent }> {
    return this.all("SELECT * FROM events WHERE task_id=? AND id>? ORDER BY id LIMIT ?", taskId, after, limit)
      .map((r) => ({
        id: num(r.id), attemptId: text(r.attempt_id)!, sequence: num(r.attempt_sequence),
        event: json<CanonicalEvent>(r.event, { type: "unknown", runId: "unknown", timestamp: "" }),
      }));
  }

  getUsage(taskId?: string): UsageRecord[] {
    const rows = taskId
      ? this.all("SELECT u.* FROM usage u JOIN attempts a ON a.id=u.attempt_id WHERE a.task_id=?", taskId)
      : this.all("SELECT * FROM usage");
    return rows.map((r) => ({
      attemptId: text(r.attempt_id)!, provider: text(r.provider)!, model: text(r.model)!,
      input: num(r.input), output: num(r.output), cacheRead: num(r.cache_read),
      cacheWrite: num(r.cache_write), totalTokens: num(r.total_tokens), totalCost: num(r.total_cost),
    }));
  }

  claimNext(workerId: string, now = Date.now(), leaseMs = 30_000): { task: TaskRecord; attempt: AttemptRecord } | null {
    return this.tx(() => {
      const row = this.one(`SELECT t.*,c.cancel_requested FROM tasks t
        LEFT JOIN chains c ON c.id=t.chain_id
        WHERE (t.status='queued' OR (t.status='retry_wait' AND t.available_at<=?))
          AND t.available_at<=? AND t.batch_attempts<3
          AND COALESCE(c.cancel_requested,0)=0
        ORDER BY t.created_at LIMIT 1`, now, now);
      if (!row) return null;
      const task = this.taskFrom(row)!;
      const fencing = task.fencingToken + 1;
      const attemptId = `attempt-${randomUUID()}`;
      const previous = this.one("SELECT COALESCE(MAX(sequence),0) AS seq FROM attempts WHERE task_id=?", task.id);
      const sequence = num(previous?.seq) + 1;
      this.run(`INSERT INTO attempts(id,task_id,sequence,batch,fencing_token,worker_id,status,lease_expires_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'leased',?,?,?)`,
        attemptId, task.id, sequence, task.batch, fencing, workerId, now + leaseMs, now, now);
      this.run(`UPDATE tasks SET status='running',active_attempt_id=?,fencing_token=?,
        batch_attempts=batch_attempts+1,updated_at=? WHERE id=? AND fencing_token=?`,
        attemptId, fencing, now, task.id, task.fencingToken);
      this.run("UPDATE outbox SET status='delivered' WHERE child_task_id=?", task.id);
      return { task: this.getTask(task.id)!, attempt: this.getAttempt(attemptId)! };
    });
  }

  heartbeat(attemptId: string, fencingToken: number, now = Date.now(), leaseMs = 30_000): boolean {
    const result = this.db.prepare(`UPDATE attempts SET lease_expires_at=?,updated_at=?
      WHERE id=? AND fencing_token=? AND status IN ('leased','running')`)
      .run(now + leaseMs, now, attemptId, fencingToken);
    return Number(result.changes) === 1;
  }

  markAttemptRunning(attemptId: string, fencingToken: number, now = Date.now()): boolean {
    const result = this.db.prepare(`UPDATE attempts SET status='running',updated_at=?
      WHERE id=? AND fencing_token=? AND status='leased'`).run(now, attemptId, fencingToken);
    return Number(result.changes) === 1;
  }

  completeSuccess(attemptId: string, fencingToken: number, result: TaskResult,
    handoffs: HandoffCommit[], now = Date.now()): string[] {
    return this.tx(() => {
      const row = this.current(attemptId, fencingToken);
      const task = this.taskFrom(row)!;
      this.run("UPDATE attempts SET status='completed',updated_at=? WHERE id=?", now, attemptId);
      const chain = this.getChain(task.chainId);
      const cancelled = chain.cancelRequested || task.status === "cancelling";
      this.run(`UPDATE tasks SET status=?,active_attempt_id=NULL,result=?,error=NULL,updated_at=? WHERE id=?`,
        cancelled ? "cancelled" : "succeeded", JSON.stringify(result), now, task.id);
      const childIds: string[] = [];
      let budget = chain.budgetUsed;
      const visits = { ...chain.visitCounts };
      const perMember = new Map<string, number>();
      for (const handoff of handoffs) {
        const existing = this.one("SELECT child_task_id FROM outbox WHERE source_tool_call_id=? AND target_member_id=?",
          handoff.sourceToolCallId, handoff.toMemberId);
        if (existing) { childIds.push(text(existing.child_task_id)!); continue; }
        const childId = `task-${randomUUID()}`;
        const child = this.insertTask({
          ...handoff.input,
          chainId: task.chainId,
          parentTaskId: task.id,
          depth: task.depth + 1,
          idempotencyKey: `handoff:${task.chainId}:${handoff.sourceToolCallId}:${handoff.toMemberId}`,
        }, now, childId);
        this.run(`INSERT INTO outbox(id,source_attempt_id,source_tool_call_id,target_member_id,child_task_id,reason,created_at)
          VALUES(?,?,?,?,?,?,?)`, `outbox-${randomUUID()}`, attemptId,
          handoff.sourceToolCallId, handoff.toMemberId, child.id, handoff.reason, now);
        childIds.push(child.id);
        budget += 1;
        perMember.set(handoff.toMemberId, (perMember.get(handoff.toMemberId) ?? 0) + 1);
      }
      for (const [memberId, count] of perMember) {
        visits[memberId] = (visits[memberId] ?? 0) + count;
      }
      this.run("UPDATE chains SET budget_used=?,visit_counts=? WHERE id=?",
        budget, JSON.stringify(visits), task.chainId);
      return childIds;
    });
  }

  finishFailure(attemptId: string, fencingToken: number, error: string,
    options: { blocked?: boolean; now?: number } = {}): TaskStatus {
    return this.tx(() => {
      const row = this.current(attemptId, fencingToken);
      const task = this.taskFrom(row)!;
      const now = options.now ?? Date.now();
      const chain = this.getChain(task.chainId);
      const cancelled = chain.cancelRequested || task.status === "cancelling";
      this.run("UPDATE attempts SET status=?,error=?,updated_at=? WHERE id=?",
        cancelled ? "cancelled" : "failed", error, now, attemptId);
      const status: TaskStatus = cancelled ? "cancelled" : options.blocked ? "blocked"
        : task.batchAttempts < 3 ? "retry_wait" : "failed";
      const delay = task.batchAttempts === 1 ? 5_000 : 25_000;
      // Snapshot is generated after the failure is recorded, so a retry can see
      // why the previous Attempt ended instead of repeating it blindly.
      this.run(`UPDATE tasks SET status=?,active_attempt_id=NULL,available_at=?,error=?,updated_at=? WHERE id=?`,
        status, status === "retry_wait" ? now + delay : now, error, now, task.id);
      const snapshot = this.recoverySnapshot(task.id);
      this.run("UPDATE tasks SET recovery_snapshot=? WHERE id=?", snapshot, task.id);
      return status;
    });
  }

  expiredAttempts(now = Date.now()): AttemptRecord[] {
    return this.all(`SELECT * FROM attempts WHERE status IN ('leased','running') AND lease_expires_at<?`, now)
      .map((r) => this.attemptFrom(r));
  }

  recoverAttempt(attemptId: string, reason: string, blocked: boolean, now = Date.now()): TaskStatus {
    return this.tx(() => {
      const attempt = this.getAttempt(attemptId);
      if (!attempt || !["leased", "running"].includes(attempt.status)) {
        return this.getTask(attempt?.taskId ?? "")?.status ?? "failed";
      }
      const task = this.getTask(attempt.taskId)!;
      this.run("UPDATE attempts SET status='orphaned',error=?,updated_at=? WHERE id=?", reason, now, attemptId);
      const status: TaskStatus = blocked ? "blocked" : task.batchAttempts < 3 ? "retry_wait" : "failed";
      this.run(`UPDATE tasks SET status=?,active_attempt_id=NULL,fencing_token=fencing_token+1,
        available_at=?,error=?,recovery_snapshot=?,updated_at=? WHERE id=?`,
        status, now, reason, this.recoverySnapshot(task.id), now, task.id);
      return status;
    });
  }

  recoverySnapshot(taskId: string): string {
    const task = this.getTask(taskId);
    if (!task) return "";
    const events = this.getEvents(taskId, 0, 1000);
    const lastText = [...events].reverse().find((e) =>
      (e.event.type === "message_end" || e.event.type === "message_update") && e.event.text)?.event;
    const tools = events.filter((e) => e.event.toolName).map((e) => ({
      type: e.event.type, toolCallId: e.event.toolCallId, toolName: e.event.toolName,
      isError: e.event.isError,
    }));
    return JSON.stringify({
      kind: "deterministic-recovery-v1",
      originalTask: task.prompt,
      previousError: task.error,
      lastAssistantMessage: lastText?.text ?? null,
      lastAssistantEventType: lastText?.type ?? null,
      toolOutcomes: tools,
      sessionFile: task.sessionFile ?? null,
      instruction: "Continue unfinished work. Do not repeat confirmed side effects; unknown side effects require human review.",
    });
  }

  /**
   * Persist the Pi session file reported by a run. Fenced: a superseded Attempt
   * must not point the next Attempt at its own (dead) session.
   */
  recordSession(attemptId: string, fencingToken: number, sessionFile: string): boolean {
    return this.tx(() => {
      const attempt = this.one("SELECT task_id FROM attempts WHERE id=? AND fencing_token=?",
        attemptId, fencingToken);
      if (!attempt) return false;
      const taskId = text(attempt.task_id)!;
      const owned = this.one(
        "SELECT id FROM tasks WHERE id=? AND active_attempt_id=? AND fencing_token=?",
        taskId, attemptId, fencingToken);
      if (!owned) return false;
      this.run("UPDATE tasks SET session_file=? WHERE id=?", sessionFile, taskId);
      return true;
    });
  }

  requestCancelChain(chainId: string, now = Date.now()): number {
    return this.tx(() => {
      this.run("UPDATE chains SET cancel_requested=1 WHERE id=?", chainId);
      this.run(`UPDATE tasks SET status=CASE WHEN status='running' THEN 'cancelling' ELSE 'cancelled' END,
        active_attempt_id=CASE WHEN status='running' THEN active_attempt_id ELSE NULL END,
        updated_at=? WHERE chain_id=? AND status NOT IN ('succeeded','failed','cancelled')`, now, chainId);
      const row = this.one(`SELECT COUNT(*) AS n FROM tasks WHERE chain_id=?
        AND status IN ('cancelling','cancelled')`, chainId);
      return num(row?.n);
    });
  }

  retryTask(taskId: string, now = Date.now()): boolean {
    return this.tx(() => {
      const task = this.getTask(taskId);
      if (!task || !["failed", "blocked", "cancelled"].includes(task.status)) return false;
      // A cancelled chain stays cancelled: manual retry must not resurrect work
      // the user asked to stop, otherwise cancelling a parent is reversible by
      // accident and the chain can keep producing handoffs.
      if (this.getChain(task.chainId).cancelRequested) return false;
      this.run(`UPDATE tasks SET status='queued',batch=batch+1,batch_attempts=0,active_attempt_id=NULL,
        fencing_token=fencing_token+1,error=NULL,available_at=?,updated_at=? WHERE id=?`, now, now, taskId);
      return true;
    });
  }

  confirmBlocked(taskId: string, note: string, now = Date.now()): boolean {
    return this.tx(() => {
      const task = this.getTask(taskId);
      if (!task || task.status !== "blocked") return false;
      this.run(`UPDATE tasks SET status='queued',recovery_snapshot=?,error=NULL,available_at=?,updated_at=? WHERE id=?`,
        JSON.stringify({ humanConfirmedSideEffects: note, recovery: this.recoverySnapshot(taskId) }),
        now, taskId);
      return true;
    });
  }
}
