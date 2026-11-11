/**
 * Minimal migration ledger (the "P8 patch" half the P9 PRD asks for).
 *
 * `CREATE TABLE IF NOT EXISTS` is idempotent for TABLES and useless for COLUMNS:
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so every new column used to need a
 * hand-written `PRAGMA table_info` probe in the `ExecutionStore` constructor.
 * That probe is technical debt with a real failure mode: it grows without bound,
 * it keeps no record of what has been applied, and a column added in the wrong
 * order silently diverges between a fresh and a long-lived database.
 *
 * The ledger fixes the record-keeping, not the DDL: `schema_migrations` names
 * what ran. Every `up` is nevertheless REQUIRED to be idempotent
 * (`addColumnIfMissing`), because the ledger is itself new: the first run against
 * a database created before it sees an EMPTY ledger next to a table that may
 * already carry the column. A ledger that trusted its own history would replay
 * every migration against a live database; one that checks reality first cannot.
 *
 * Deliberately not a migration framework: no down migrations (this repo never
 * rolls a schema back — it is greenfield and local), no CLI, no ordering DSL.
 */

import type { DatabaseSync } from "node:sqlite";

interface Row {
  [key: string]: string | number | null | bigint;
}

const asRows = (value: unknown): Row[] => value as Row[];

export interface Migration {
  /** Stable, unique, never edited after it ships: it is the ledger key. */
  id: string;
  /** Apply the change. MUST be safe to run on an already-migrated database. */
  up: (db: DatabaseSync) => void;
}

export function hasTable(db: DatabaseSync, table: string): boolean {
  const rows = asRows(db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?").all(table));
  return rows.length > 0;
}

export function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  if (!hasTable(db, table)) return false;
  return asRows(db.prepare(`PRAGMA table_info(${table})`).all())
    .some((row) => row.name === column);
}

/**
 * The primitive every column migration needs. Returns whether it changed
 * anything, so a caller can tell a real application from a no-op.
 */
export function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): boolean {
  if (hasColumn(db, table, column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/**
 * Create the ledger if needed, then run the migrations whose id it does not
 * hold, in the order given. Returns the ids actually applied this run (empty on
 * an up-to-date database), which is what a caller can report as evidence.
 */
export function applyMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[],
  now = Date.now(),
): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );`);
  const applied = new Set(asRows(db.prepare("SELECT id FROM schema_migrations").all())
    .map((row) => String(row.id)));
  const record = db.prepare("INSERT INTO schema_migrations(id, applied_at) VALUES(?, ?)");
  const done: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    migration.up(db);
    record.run(migration.id, now);
    done.push(migration.id);
  }
  return done;
}
