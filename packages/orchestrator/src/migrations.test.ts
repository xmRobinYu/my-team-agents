/**
 * The migration ledger — the "P8 patch" half of P9.
 *
 * The load-bearing properties are (1) a SECOND apply is a no-op, and (2) a database
 * created BEFORE the ledger still records its existing columns as applied instead of
 * re-running the ALTER. Property (2) is what makes the ledger safe to introduce into
 * a live system, and it is the one an id-uniqueness check alone would miss.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { addColumnIfMissing, applyMigrations, hasColumn, hasTable, type Migration } from "./migrations.js";
import { ExecutionStore } from "./execution-store.js";

const MIGRATIONS: Migration[] = [
  { id: "a", up: (db) => { db.exec("CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY)"); } },
  { id: "b", up: (db) => { addColumnIfMissing(db, "t", "note", "TEXT"); } },
];

describe("migration ledger", () => {
  it("applies each migration once and is a no-op on the second run", () => {
    const db = new DatabaseSync(":memory:");
    expect(applyMigrations(db, MIGRATIONS)).toEqual(["a", "b"]);
    expect(applyMigrations(db, MIGRATIONS)).toEqual([]);
    expect(hasColumn(db, "t", "note")).toBe(true);
  });

  it("records what ran, so a caller can report evidence instead of assuming", () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db, MIGRATIONS, 1234);
    const rows = db.prepare("SELECT id, applied_at FROM schema_migrations ORDER BY id").all() as Array<{ id: string; applied_at: number }>;
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows.every((r) => r.applied_at === 1234)).toBe(true);
  });

  it("a database that already has the column records it as applied, never re-ALTERs", () => {
    // Simulate a pre-ledger database: table + column exist, no ledger.
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, note TEXT)");
    expect(hasColumn(db, "t", "note")).toBe(true);
    // The migration is idempotent, so applying it is safe even though the column is
    // already there — the ALTER is skipped and only the ledger row is written.
    expect(() => applyMigrations(db, MIGRATIONS)).not.toThrow();
    expect(applyMigrations(db, MIGRATIONS)).toEqual([]);
  });

  it("addColumnIfMissing reports whether it changed anything", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
    expect(addColumnIfMissing(db, "t", "x", "TEXT")).toBe(true);
    expect(addColumnIfMissing(db, "t", "x", "TEXT")).toBe(false);
  });

  it("hasTable/hasColumn are false rather than throwing on a missing table", () => {
    const db = new DatabaseSync(":memory:");
    expect(hasTable(db, "nope")).toBe(false);
    expect(hasColumn(db, "nope", "x")).toBe(false);
  });
});

describe("ExecutionStore uses the ledger for the P9a columns", () => {
  it("a fresh database gets lane, event_id, tools, error_kind, parallel and records all six migrations", () => {
    const store = new ExecutionStore(":memory:");
    const tasks = store.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const names = tasks.map((c) => c.name);
    for (const column of ["agent_dir", "lane", "event_id", "tools"]) {
      expect(names, column).toContain(column);
    }
    // P9c put its column on `attempts`, not `tasks` — the reason is WHERE the fact
    // lives: a retry re-uses the Task row but always mints a new Attempt.
    const attempts = store.db.prepare("PRAGMA table_info(attempts)").all() as Array<{ name: string }>;
    expect(attempts.map((c) => c.name)).toContain("error_kind");
    const attemptCols = store.db.prepare("PRAGMA table_info(attempts)").all() as Array<{ name: string }>;
    expect(attemptCols.map((c) => c.name)).toContain("error_kind");
    expect(names).toContain("parallel");
    const ledger = store.db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: string }>;
    expect(ledger.map((r) => r.id)).toEqual([
      "0001-tasks-agent-dir", "0002-tasks-lane", "0003-tasks-event-id", "0004-tasks-tools",
      "0005-attempts-error-kind", "0006-tasks-parallel",
    ]);
    store.close();
  });

  it("re-opening an existing database applies nothing new", () => {
    // A second ExecutionStore over the same FILE re-runs `applyMigrations`; the
    // ledger makes it a no-op, which is what proves the ALTERs do not repeat and
    // that a live database survives a restart with the new code.
    const dir = mkdtempSync(join(tmpdir(), "mta-mig-"));
    const file = join(dir, "exec.sqlite");
    try {
      const first = new ExecutionStore(file);
      first.close();
      const second = new ExecutionStore(file);
      // Same columns, and the ledger still holds exactly the six known ids.
      const ledger = second.db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: string }>;
      expect(ledger.map((r) => r.id)).toEqual([
        "0001-tasks-agent-dir", "0002-tasks-lane", "0003-tasks-event-id", "0004-tasks-tools",
        "0005-attempts-error-kind", "0006-tasks-parallel",
      ]);
      expect(second.listTasks()).toEqual([]);
      second.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
