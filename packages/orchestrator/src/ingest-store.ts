/**
 * P9a persistence: inbound events, trigger rules, lane claims, rate windows and
 * the coalesce log.
 *
 * Beside `ExecutionStore` and `RoomStore` on the same `DatabaseSync` handle, so an
 * event, the Task it produced and the rule that claimed it commit together — the
 * same "one database, one commit" rule `postRoomMessage` follows.
 *
 * NAME, and why it is not `events`: `ExecutionStore` already owns `events` for the
 * durable per-attempt event log, and this file shares its database. `CREATE TABLE
 * IF NOT EXISTS events` would have silently done nothing and then failed on the
 * first INSERT. So the inbound table is `inbound_events`.
 *
 * Three helper tables instead of columns on `tasks`, each for a reason:
 *  - `lane_claims`  — the (rule, lane, subject) -> Task mapping coalescing needs.
 *    `tasks` has no `subject`; deriving it by joining events would make the hot
 *    path a two-table join for no gain.
 *  - `rule_dispatches` — the rate window. Counting "dispatches in the last N ms"
 *    cannot be answered from `inbound_events` without JSON-searching `rule_ids`.
 *  - `event_coalesce` — the relation AC2.3 audits. A JSON array on the Task would
 *    be a read-modify-write two producers can lose between them.
 *
 * D1/B: rules live in a table AND are importable from `rules.json` (one-way,
 * Git-auditable). Nothing watches the file: a rule change stays a reviewable act.
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type {
  EventScope,
  InboundEvent,
  IngestOutcome,
  TriggerRule,
} from "./ingest.js";
import { dedupKeyOf } from "./ingest.js";

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

/**
 * Savepoint names are per connection, and two `IngestStore` instances can share one
 * handle, so the counter is module-level: a name is never reused.
 */
let nextSavepoint = 0;

/** A stored event, as `GET /api/ingest/events/:id` reports it. */
export interface InboundEventRecord {
  event: InboundEvent;
  scope: EventScope;
  dedupKey: string;
  outcome: IngestOutcome;
  /** Rules that matched, in dispatch order. Empty for `unmatched`. */
  ruleIds: string[];
  /** Tasks this event produced (or, for `coalesced`, the Task it joined). */
  taskIds: string[];
  /** Task the event was coalesced into, when `outcome === "coalesced"`. */
  coalescedIntoTaskId: string | null;
  /** Set while `outcome === "deferred"`: when the redrive pass should retry. */
  retryAt: number | null;
  arrivedAt: number;
}

/** One rule as exported to `rules.json` (D1/B): no ids a human cannot re-type. */
export type RuleDocument = Omit<TriggerRule, "id" | "createdAt" | "updatedAt">;

export class IngestStore {
  readonly db: DatabaseSync;

  private readonly ownsDb: boolean;

  constructor(dbOrFilename: DatabaseSync | string = ":memory:") {
    this.ownsDb = typeof dbOrFilename === "string";
    this.db = this.ownsDb
      ? new DatabaseSync(dbOrFilename as string)
      : (dbOrFilename as DatabaseSync);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbound_events (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL,
        detail TEXT,
        link TEXT,
        occurred_at INTEGER NOT NULL,
        arrived_at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        truncated TEXT NOT NULL DEFAULT '{}',
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        dedup_key TEXT NOT NULL UNIQUE,
        outcome TEXT NOT NULL,
        rule_ids TEXT NOT NULL DEFAULT '[]',
        task_ids TEXT NOT NULL DEFAULT '[]',
        coalesced_into TEXT,
        retry_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS inbound_events_source ON inbound_events(source, type);
      CREATE INDEX IF NOT EXISTS inbound_events_retry ON inbound_events(outcome, retry_at);
      CREATE TABLE IF NOT EXISTS trigger_rules (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        project_id TEXT,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0,
        when_clause TEXT NOT NULL,
        to_clause TEXT NOT NULL,
        ask TEXT NOT NULL,
        skill TEXT,
        lane TEXT NOT NULL,
        parallel INTEGER NOT NULL DEFAULT 1,
        tell TEXT NOT NULL DEFAULT 'silent',
        cron TEXT,
        rate TEXT,
        dedup TEXT NOT NULL DEFAULT '{"windowMs":0}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS trigger_rules_enabled ON trigger_rules(enabled);
      -- AC4.2: the last slot each schedule fired. Persisted so a restart fills the
      -- most recent missed slot instead of replaying history or skipping the work.
      CREATE TABLE IF NOT EXISTS cron_state (
        rule_id TEXT PRIMARY KEY,
        last_slot INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lane_claims (
        rule_id TEXT NOT NULL,
        lane TEXT NOT NULL,
        subject TEXT NOT NULL,
        task_id TEXT NOT NULL,
        claimed_at INTEGER NOT NULL,
        PRIMARY KEY (rule_id, lane, subject)
      );
      CREATE TABLE IF NOT EXISTS rule_dispatches (
        rule_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (rule_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS rule_dispatches_time ON rule_dispatches(rule_id, created_at);
      CREATE TABLE IF NOT EXISTS event_coalesce (
        event_id TEXT NOT NULL REFERENCES inbound_events(id),
        task_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (event_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS event_coalesce_task ON event_coalesce(task_id);
      -- P9b: the decision ledger. dedup_key is the IDENTITY of a notice —
      -- (rule, subject, kind) — so "定过的事不问第二遍" survives a restart.
      -- No backticks in here: this whole block is one JS template literal.
      CREATE TABLE IF NOT EXISTS tell_log (
        dedup_key TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        sent_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS tell_log_rule ON tell_log(rule_id, sent_at);
    `);
  }

  close(): void { if (this.ownsDb) this.db.close(); }

  /**
   * A `SAVEPOINT`, not `BEGIN`, and for the same reason `RoomStore` uses one: the
   * ingestion service wraps the whole decision (event + Tasks + outcome + lane claim)
   * in a transaction owned by the `ExecutionStore`, and SQLite rejects a nested
   * `BEGIN` outright ("cannot start a transaction within a transaction"). A per-store
   * depth counter cannot see the OTHER store's transaction, so a plain `BEGIN` here
   * would fail the moment the service is driven from inside `executions.transaction`.
   *
   * Standalone, `SAVEPOINT`/`RELEASE` is a transaction; nested inside one, it is a
   * sub-transaction whose work still rolls back with the outer one. Hybrid safety
   * comes from that, and the savepoint name is unique per call so re-entrancy cannot
   * collide.
   */
  transaction<T>(fn: () => T): T {
    const savepoint = `mta_ingest_${nextSavepoint++}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const out = fn();
      this.db.exec(`RELEASE ${savepoint}`);
      return out;
    } catch (err) {
      try { this.db.exec(`ROLLBACK TO ${savepoint}`); this.db.exec(`RELEASE ${savepoint}`); }
      catch { /* The outer transaction is already doomed; keep the original error. */ }
      throw err;
    }
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

  // ---- events -----------------------------------------------------------

  /**
   * AC2.1/AC2.4: delivery-level idempotency. A repeated POST of the SAME
   * `(source, id)` returns the ORIGINAL row and never creates a second event or a
   * second batch of Tasks. Returns `inserted: false` so the caller reports
   * `delivered` — "you got it", not "I did something new".
   */
  insertEvent(
    event: InboundEvent,
    scope: EventScope,
    initialOutcome: IngestOutcome,
    now = Date.now(),
  ): { record: InboundEventRecord; inserted: boolean } {
    return this.transaction(() => {
      const dedupKey = dedupKeyOf(event.source, event.id);
      const existing = this.one("SELECT * FROM inbound_events WHERE dedup_key = ?", dedupKey);
      if (existing) return { record: this.eventFrom(existing), inserted: false };
      this.run(`INSERT INTO inbound_events(
        id,source,type,subject,summary,detail,link,occurred_at,arrived_at,payload,truncated,
        tenant_id,project_id,dedup_key,outcome,rule_ids,task_ids
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'[]','[]')`,
        event.id, event.source, event.type, event.subject, event.summary,
        event.detail ?? null, event.link ?? null, event.occurredAt, now,
        JSON.stringify(event.payload), JSON.stringify(event.truncated),
        scope.tenantId, scope.projectId, dedupKey, initialOutcome);
      return { record: this.eventFrom(this.one("SELECT * FROM inbound_events WHERE id = ?", event.id)!), inserted: true };
    });
  }

  /** AC1.2: the outcome and what matched are recorded, never inferred later. */
  setEventOutcome(
    id: string,
    outcome: IngestOutcome,
    patch: { ruleIds?: string[]; taskIds?: string[]; coalescedInto?: string | null } = {},
  ): void {
    this.transaction(() => {
      if (patch.ruleIds !== undefined) {
        this.run("UPDATE inbound_events SET rule_ids=? WHERE id=?", JSON.stringify(patch.ruleIds), id);
      }
      if (patch.taskIds !== undefined) {
        this.run("UPDATE inbound_events SET task_ids=? WHERE id=?", JSON.stringify(patch.taskIds), id);
      }
      this.run("UPDATE inbound_events SET outcome=?, coalesced_into=? WHERE id=?",
        outcome, patch.coalescedInto ?? null, id);
    });
  }

  /**
   * AC2.3: record that an event was folded into an existing Task. Idempotent on
   * `(event_id, task_id)`, so a replayed delivery cannot double-count.
   */
  linkCoalesced(eventId: string, taskId: string, now = Date.now()): void {
    this.run("INSERT OR IGNORE INTO event_coalesce(event_id,task_id,created_at) VALUES(?,?,?)",
      eventId, taskId, now);
  }

  coalescedEventIds(taskId: string): string[] {
    return this.all("SELECT event_id FROM event_coalesce WHERE task_id=? ORDER BY created_at, event_id", taskId)
      .map((r) => text(r.event_id)!);
  }

  /** AC2.5: a deferred event must be re-offered. `retry_at` is when. */
  scheduleRetry(id: string, retryAt: number): void {
    this.run("UPDATE inbound_events SET outcome='deferred', retry_at=? WHERE id=?", retryAt, id);
  }

  clearRetry(id: string): void {
    this.run("UPDATE inbound_events SET retry_at=NULL WHERE id=?", id);
  }

  /**
   * Atomically take ownership of ONE due deferral.
   *
   * The old redrive path read `dueRetries()` and then called `clearRetry()`: a read
   * followed by an unconditional write. Two workers could therefore both pick up the
   * same row and both run the decision. The event-level idempotency key stopped a
   * duplicate Task, but the redundant pass still executed — and any coalesce or lane
   * side effect in it would be applied twice.
   *
   * The claim IS the test: one conditional UPDATE, so exactly one caller observes
   * `changes === 1`. Callers run inside `executions.transaction`, whose
   * `BEGIN IMMEDIATE` serialises two concurrent claims.
   */
  claimRetry(id: string, now = Date.now()): boolean {
    const res = this.db
      .prepare("UPDATE inbound_events SET retry_at=NULL WHERE id=? AND outcome='deferred' AND retry_at IS NOT NULL AND retry_at<=?")
      .run(id, now);
    return Number(res.changes) === 1;
  }

  dueRetries(at: number): InboundEventRecord[] {
    return this.all(
      "SELECT * FROM inbound_events WHERE outcome='deferred' AND retry_at IS NOT NULL AND retry_at<=? ORDER BY retry_at",
      at,
    ).map((r) => this.eventFrom(r));
  }

  getEvent(id: string): InboundEventRecord | null {
    const row = this.one("SELECT * FROM inbound_events WHERE id = ?", id);
    return row ? this.eventFrom(row) : null;
  }

  listEvents(limit = 100): InboundEventRecord[] {
    return this.all("SELECT * FROM inbound_events ORDER BY arrived_at DESC, id LIMIT ?", limit)
      .map((r) => this.eventFrom(r));
  }

  private eventFrom(row: Row): InboundEventRecord {
    const detail = text(row.detail);
    const link = text(row.link);
    return {
      event: {
        id: text(row.id)!,
        source: text(row.source)!,
        type: text(row.type)!,
        subject: text(row.subject) ?? "",
        summary: text(row.summary)!,
        ...(detail !== null ? { detail } : {}),
        ...(link !== null ? { link } : {}),
        occurredAt: num(row.occurred_at),
        payload: json<Record<string, unknown>>(row.payload, {}),
        truncated: json<{ summary: boolean; detail: boolean }>(row.truncated, { summary: false, detail: false }),
      },
      scope: { tenantId: text(row.tenant_id)!, projectId: text(row.project_id)! },
      dedupKey: text(row.dedup_key)!,
      outcome: text(row.outcome) as IngestOutcome,
      ruleIds: json<string[]>(row.rule_ids, []),
      taskIds: json<string[]>(row.task_ids, []),
      coalescedIntoTaskId: text(row.coalesced_into),
      retryAt: row.retry_at === null || row.retry_at === undefined ? null : num(row.retry_at),
      arrivedAt: num(row.arrived_at),
    };
  }

  // ---- lane claims + rate windows ---------------------------------------

  /** The Task that owns `(rule, lane, subject)`; the caller checks it is still live. */
  laneClaim(ruleId: string, lane: string, subject: string): string | null {
    const row = this.one(
      "SELECT task_id FROM lane_claims WHERE rule_id=? AND lane=? AND subject=?",
      ruleId, lane, subject);
    return row ? text(row.task_id) : null;
  }

  /** INSERT OR REPLACE: a terminal owner's stale claim is superseded by the new Task. */
  claimLane(ruleId: string, lane: string, subject: string, taskId: string, now = Date.now()): void {
    this.run(`INSERT INTO lane_claims(rule_id,lane,subject,task_id,claimed_at) VALUES(?,?,?,?,?)
      ON CONFLICT(rule_id,lane,subject) DO UPDATE SET task_id=excluded.task_id, claimed_at=excluded.claimed_at`,
      ruleId, lane, subject, taskId, now);
  }

  recordDispatch(ruleId: string, eventId: string, taskId: string, now = Date.now()): void {
    this.run("INSERT OR IGNORE INTO rule_dispatches(rule_id,event_id,task_id,created_at) VALUES(?,?,?,?)",
      ruleId, eventId, taskId, now);
  }

  // ---- tell ledger (P9b) ------------------------------------------------

  /**
   * Take the exclusive right to send one notice, keyed by the notice's IDENTITY
   * (rule, subject, kind) rather than by the Task, so a retried Task and a worker
   * restart both find the same row.
   *
   * At-most-once for success, at-least-once for failure: a notice that reached the
   * channel is never sent again, and one the channel rejected may be retried. A
   * crash between claim and send loses that one notification, which is the correct
   * bias for a notifier — see tell.ts.
   */
  claimTell(dedupKey: string, ruleId: string, taskId: string, kind: string, channel: string, now = Date.now()): boolean {
    // Two different answers for two different histories, and this is the whole
    // policy in one statement:
    //   - already `sent`  -> the WHERE fails, changes = 0, never re-notified;
    //   - already `failed`-> re-claimed, so a webhook blip is retried;
    //   - already `claimed` -> another caller is mid-send, do not stack.
    const res = this.db.prepare(`
      INSERT INTO tell_log(dedup_key,rule_id,task_id,kind,channel,status,attempts,created_at)
      VALUES(?,?,?,?,?,'claimed',1,?)
      ON CONFLICT(dedup_key) DO UPDATE SET status='claimed', attempts=attempts+1
        WHERE tell_log.status='failed'`,
    ).run(dedupKey, ruleId, taskId, kind, channel, now);
    return Number(res.changes) === 1;
  }

  /** Give the claim back when the notice was never attempted (cooldown). */
  releaseTell(dedupKey: string): void {
    this.run("DELETE FROM tell_log WHERE dedup_key=? AND status='claimed'", dedupKey);
  }

  finishTell(dedupKey: string, status: "sent" | "failed", error: string | null, now = Date.now()): void {
    this.run("UPDATE tell_log SET status=?,last_error=?,sent_at=? WHERE dedup_key=?",
      status, error, status === "sent" ? now : null, dedupKey);
  }

  /** When this rule last actually reached the channel, or null. */
  lastTellSentAt(ruleId: string): number | null {
    const row = this.one("SELECT MAX(sent_at) AS t FROM tell_log WHERE rule_id=? AND status='sent'", ruleId);
    return row?.t === null || row?.t === undefined ? null : num(row.t);
  }

  /** Dispatches this rule started at or after `since` — the AC2.5 rate window. */
  countDispatchesSince(ruleId: string, since: number): number {
    const row = this.one(
      "SELECT COUNT(*) AS n FROM rule_dispatches WHERE rule_id=? AND created_at>=?", ruleId, since);
    return num(row?.n);
  }

  // ---- rules ------------------------------------------------------------

  createRule(value: Omit<TriggerRule, "id" | "createdAt" | "updatedAt">, now = Date.now()): TriggerRule {
    const id = `rule-${randomUUID()}`;
    this.run(`INSERT INTO trigger_rules(
      id,tenant_id,project_id,name,enabled,priority,when_clause,to_clause,ask,skill,lane,
      parallel,tell,cron,rate,dedup,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, value.tenantId, value.projectId, value.name, value.enabled ? 1 : 0, value.priority,
      JSON.stringify(value.when), JSON.stringify(value.to), value.ask, value.skill, value.lane,
      value.parallel, value.tell, value.cron ? JSON.stringify(value.cron) : null,
      value.rate ? JSON.stringify(value.rate) : null,
      JSON.stringify(value.dedup), now, now);
    return this.getRule(id)!;
  }

  getRule(id: string): TriggerRule | null {
    const row = this.one("SELECT * FROM trigger_rules WHERE id = ?", id);
    return row ? this.ruleFrom(row) : null;
  }

  listRules(): TriggerRule[] {
    return this.all("SELECT * FROM trigger_rules ORDER BY priority DESC, name").map((r) => this.ruleFrom(r));
  }

  listEnabledRules(): TriggerRule[] {
    return this.all("SELECT * FROM trigger_rules WHERE enabled=1 ORDER BY priority DESC, name")
      .map((r) => this.ruleFrom(r));
  }

  /**
   * Rules exported to `rules.json` (D1/B), in the same deterministic order the
   * matcher uses. The round-trip is `export -> review in Git -> import`.
   */
  exportRules(): RuleDocument[] {
    return this.listRules().map(({ id: _id, createdAt: _c, updatedAt: _u, ...rest }) => rest);
  }

  private ruleFrom(row: Row): TriggerRule {
    const rateRaw = text(row.rate);
    const cronRaw = text(row.cron);
    return {
      id: text(row.id)!,
      tenantId: text(row.tenant_id),
      projectId: text(row.project_id),
      name: text(row.name)!,
      enabled: num(row.enabled) === 1,
      priority: num(row.priority),
      when: json<TriggerRule["when"]>(row.when_clause, {}),
      to: json<TriggerRule["to"]>(row.to_clause, { memberId: "", workspacePath: "", tools: [] }),
      ask: text(row.ask)!,
      skill: text(row.skill),
      lane: text(row.lane)!,
      // P9c: this used to be the literal 1, the P9a assumption that nothing else
      // could be stored. Reading it back as 1 would have silently dropped a rule's
      // fan-out on every reload while registration still reported the real value —
      // two answers depending on whether the row had been re-read.
      parallel: num(row.parallel) >= 1 ? num(row.parallel) : 1,
      tell: (text(row.tell) ?? "silent") as TriggerRule["tell"],
      cron: cronRaw === null ? null : json<{ expression: string; type: string } | null>(cronRaw, null),
      rate: rateRaw === null ? null : json<{ max: number; windowMs: number } | null>(rateRaw, null),
      dedup: json<{ windowMs: number }>(row.dedup, { windowMs: 0 }),
      createdAt: num(row.created_at),
      updatedAt: num(row.updated_at),
    };
  }

  // ---- cron state (AC4.2) -----------------------------------------------

  /**
   * The last slot a schedule fired, or `null` if it has never been ticked. A
   * `null` is distinct from `0` on purpose: a brand-new rule must NOT replay every
   * slot since the epoch, so the scheduler seeds it to "now" on first sight.
   */
  getCronState(ruleId: string): number | null {
    const row = this.one("SELECT last_slot FROM cron_state WHERE rule_id=?", ruleId);
    return row ? num(row.last_slot) : null;
  }

  setCronState(ruleId: string, slot: number): void {
    this.run(`INSERT INTO cron_state(rule_id,last_slot) VALUES(?,?)
      ON CONFLICT(rule_id) DO UPDATE SET last_slot=excluded.last_slot`, ruleId, slot);
  }

  // ---- stats (AC6.3) ----------------------------------------------------

  /**
   * Per-source/type outcome counts, derived from the recorded rows. Deliberately
   * not a cached counter: a cache is one more thing that can disagree with the rows
   * it summarises, and this table is small by construction (one row per inbound
   * event, not per token). Token/cost totals are joined in by the route, from the
   * `usage` table that already exists.
   */
  eventStats(): Array<{ source: string; type: string; total: number; byOutcome: Record<string, number> }> {
    const rows = this.all(`SELECT source, type, outcome, COUNT(*) AS n
      FROM inbound_events GROUP BY source, type, outcome ORDER BY source, type`);
    const merged = new Map<string, { source: string; type: string; total: number; byOutcome: Record<string, number> }>();
    for (const row of rows) {
      const source = text(row.source)!;
      const type = text(row.type)!;
      const key = `${source}\x1f${type}`;
      const bucket = merged.get(key) ?? { source, type, total: 0, byOutcome: {} };
      const count = num(row.n);
      bucket.total += count;
      bucket.byOutcome[text(row.outcome)!] = count;
      merged.set(key, bucket);
    }
    return [...merged.values()];
  }
}
