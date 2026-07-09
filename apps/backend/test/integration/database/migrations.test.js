require("../../helpers/setupBase");

process.env.CODEMM_DB_PATH = ":memory:";

const test = require("node:test");
const assert = require("node:assert/strict");

// Import the raw connection FIRST so we can seed a legacy schema before migrating.
const db = require("../../../src/database/db").default;
const { LATEST_SCHEMA_VERSION, getSchemaVersion, initializeDatabase } = require("../../../src/database/migrations");

function tableNames() {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all()
    .map((r) => r.name);
}

test("migrations: legacy session tables are renamed and stamped at the latest version", () => {
  assert.equal(getSchemaVersion(), 0, "fresh connection starts unversioned");

  // Seed a pre-rename legacy schema (what a pre-IDE-first database looked like).
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL, spec_json TEXT NOT NULL);
    CREATE TABLE session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO sessions (id, state, spec_json) VALUES ('legacy-1', 'DRAFT', '{}');
    INSERT INTO session_messages (id, session_id, role, content) VALUES ('m1', 'legacy-1', 'user', 'hi');
  `);

  initializeDatabase();

  assert.equal(getSchemaVersion(), LATEST_SCHEMA_VERSION);
  const tables = tableNames();
  assert.ok(tables.includes("threads"), "sessions renamed to threads");
  assert.ok(tables.includes("thread_messages"), "session_messages renamed to thread_messages");
  assert.ok(!tables.includes("sessions"));
  assert.ok(!tables.includes("session_messages"));

  const migratedRow = db.prepare(`SELECT thread_id FROM thread_messages WHERE id = 'm1'`).get();
  assert.equal(migratedRow.thread_id, "legacy-1", "session_id column renamed and data preserved");

  const legacyThread = db.prepare(`SELECT learning_mode FROM threads WHERE id = 'legacy-1'`).get();
  assert.equal(legacyThread.learning_mode, "practice", "missing columns added with defaults");
});

test("migrations: full schema exists after initialization", () => {
  const tables = tableNames();
  for (const expected of [
    "threads",
    "thread_collectors",
    "thread_messages",
    "activities",
    "submissions",
    "runs",
    "run_events",
    "learner_profile",
    "concept_mastery",
  ]) {
    assert.ok(tables.includes(expected), `missing table ${expected}`);
  }
});

test("migrations: re-running is a no-op at the same version", () => {
  const before = getSchemaVersion();
  initializeDatabase();
  initializeDatabase();
  assert.equal(getSchemaVersion(), before);

  const row = db.prepare(`SELECT COUNT(*) AS n FROM thread_messages`).get();
  assert.equal(row.n, 1, "no data duplicated or lost on re-run");
});
