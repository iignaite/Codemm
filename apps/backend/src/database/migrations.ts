import type { Database } from "better-sqlite3";
import db from "./db";
import { logStructured } from "../infra/observability/logger";

/**
 * Versioned, table-driven migrations tracked via `PRAGMA user_version`.
 *
 * Rules:
 * - Migrations run in ascending `version` order inside a transaction each;
 *   `user_version` is stamped as part of the same transaction.
 * - The baseline (version 1) MUST stay idempotent: databases created before
 *   versioning have `user_version = 0` but already contain every table, so
 *   the baseline must be a no-op against them.
 * - Migrations with version >= 2 run at most once and may use plain DDL.
 * - Never edit an existing migration after it has shipped; append a new one.
 */

type Migration = {
  version: number;
  name: string;
  up: (database: Database) => void;
};

function tableExists(database: Database, name: string): boolean {
  const row = database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name) as
    | { name: string }
    | undefined;
  return Boolean(row && row.name === name);
}

function colSet(database: Database, table: string): Set<string> {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(cols.map((c) => c.name));
}

/** Idempotent baseline: the full IDE-first schema plus legacy `sessions` → `threads` renames. */
function baselineSchema(database: Database): void {
  const hasSessions = tableExists(database, "sessions");
  const hasThreads = tableExists(database, "threads");
  if (hasSessions && !hasThreads) {
    database.exec(`ALTER TABLE sessions RENAME TO threads`);
  }

  const hasSessionMsgs = tableExists(database, "session_messages");
  const hasThreadMsgs = tableExists(database, "thread_messages");
  if (hasSessionMsgs && !hasThreadMsgs) {
    database.exec(`ALTER TABLE session_messages RENAME TO thread_messages`);
  }

  const hasSessionCollectors = tableExists(database, "session_collectors");
  const hasThreadCollectors = tableExists(database, "thread_collectors");
  if (hasSessionCollectors && !hasThreadCollectors) {
    database.exec(`ALTER TABLE session_collectors RENAME TO thread_collectors`);
  }

  if (tableExists(database, "thread_messages")) {
    const cols = colSet(database, "thread_messages");
    if (cols.has("session_id") && !cols.has("thread_id")) {
      database.exec(`ALTER TABLE thread_messages RENAME COLUMN session_id TO thread_id`);
    }
  }

  if (tableExists(database, "thread_collectors")) {
    const cols = colSet(database, "thread_collectors");
    if (cols.has("session_id") && !cols.has("thread_id")) {
      database.exec(`ALTER TABLE thread_collectors RENAME COLUMN session_id TO thread_id`);
    }
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      learning_mode TEXT NOT NULL DEFAULT 'practice',
      spec_json TEXT NOT NULL,
      plan_json TEXT,
      problems_json TEXT,
      activity_id TEXT,
      last_error TEXT,
      confidence_json TEXT,
      intent_trace_json TEXT,
      commitments_json TEXT,
      generation_outcomes_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const threadColSet = colSet(database, "threads");
  if (!threadColSet.has("confidence_json")) database.exec(`ALTER TABLE threads ADD COLUMN confidence_json TEXT`);
  if (!threadColSet.has("intent_trace_json")) database.exec(`ALTER TABLE threads ADD COLUMN intent_trace_json TEXT`);
  if (!threadColSet.has("commitments_json")) database.exec(`ALTER TABLE threads ADD COLUMN commitments_json TEXT`);
  if (!threadColSet.has("generation_outcomes_json")) database.exec(`ALTER TABLE threads ADD COLUMN generation_outcomes_json TEXT`);
  if (!threadColSet.has("instructions_md")) database.exec(`ALTER TABLE threads ADD COLUMN instructions_md TEXT`);
  if (!threadColSet.has("learning_mode")) {
    database.exec(`ALTER TABLE threads ADD COLUMN learning_mode TEXT NOT NULL DEFAULT 'practice'`);
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS thread_collectors (
      thread_id TEXT PRIMARY KEY,
      current_question_key TEXT,
      buffer_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS thread_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT,
      problems TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      time_limit_seconds INTEGER,
      created_at TEXT NOT NULL
    )
  `);

  const activityColSet = colSet(database, "activities");
  if (!activityColSet.has("status")) {
    database.exec(`ALTER TABLE activities ADD COLUMN status TEXT NOT NULL DEFAULT 'DRAFT'`);
  }
  if (!activityColSet.has("time_limit_seconds")) {
    database.exec(`ALTER TABLE activities ADD COLUMN time_limit_seconds INTEGER`);
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id TEXT NOT NULL,
      problem_id TEXT NOT NULL,
      code TEXT NOT NULL,
      success BOOLEAN NOT NULL,
      passed_tests INTEGER NOT NULL,
      total_tests INTEGER NOT NULL,
      execution_time_ms INTEGER,
      submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      meta_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_id, seq),
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS learner_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      goal TEXT,
      preferred_style TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS concept_mastery (
      language TEXT NOT NULL,
      concept TEXT NOT NULL,
      mastery REAL NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      passes INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (language, concept)
    )
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_threads_state ON threads(state);
    CREATE INDEX IF NOT EXISTS idx_concept_mastery_language ON concept_mastery(language);
    CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_id ON thread_messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_thread_collectors_thread_id ON thread_collectors(thread_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_activity_id ON submissions(activity_id);
    CREATE INDEX IF NOT EXISTS idx_runs_thread_id ON runs(thread_id);
    CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id);
  `);
}

const MIGRATIONS: readonly Migration[] = [{ version: 1, name: "baseline-ide-first-schema", up: baselineSchema }];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export function getSchemaVersion(database: Database = db): number {
  return Number(database.pragma("user_version", { simple: true }));
}

export function initializeDatabase(database: Database = db): void {
  const startVersion = getSchemaVersion(database);
  for (const migration of MIGRATIONS) {
    if (migration.version <= startVersion) continue;
    const apply = database.transaction(() => {
      migration.up(database);
      database.pragma(`user_version = ${migration.version}`);
    });
    apply();
    logStructured("info", "db.migration.applied", { version: migration.version, name: migration.name });
  }
  logStructured("info", "db.initialized", { schemaVersion: getSchemaVersion(database) });
}
