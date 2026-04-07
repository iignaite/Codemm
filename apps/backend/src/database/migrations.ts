import db from "./db";

export function initializeDatabase() {
  const tableExists = (name: string): boolean => {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name) as
      | { name: string }
      | undefined;
    return Boolean(row && row.name === name);
  };

  const colSet = (table: string): Set<string> => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return new Set(cols.map((c) => c.name));
  };

  const hasSessions = tableExists("sessions");
  const hasThreads = tableExists("threads");
  if (hasSessions && !hasThreads) {
    db.exec(`ALTER TABLE sessions RENAME TO threads`);
  }

  const hasSessionMsgs = tableExists("session_messages");
  const hasThreadMsgs = tableExists("thread_messages");
  if (hasSessionMsgs && !hasThreadMsgs) {
    db.exec(`ALTER TABLE session_messages RENAME TO thread_messages`);
  }

  const hasSessionCollectors = tableExists("session_collectors");
  const hasThreadCollectors = tableExists("thread_collectors");
  if (hasSessionCollectors && !hasThreadCollectors) {
    db.exec(`ALTER TABLE session_collectors RENAME TO thread_collectors`);
  }

  if (tableExists("thread_messages")) {
    const cols = colSet("thread_messages");
    if (cols.has("session_id") && !cols.has("thread_id")) {
      db.exec(`ALTER TABLE thread_messages RENAME COLUMN session_id TO thread_id`);
    }
  }

  if (tableExists("thread_collectors")) {
    const cols = colSet("thread_collectors");
    if (cols.has("session_id") && !cols.has("thread_id")) {
      db.exec(`ALTER TABLE thread_collectors RENAME COLUMN session_id TO thread_id`);
    }
  }

  db.exec(`
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

  const threadColSet = colSet("threads");
  if (!threadColSet.has("confidence_json")) db.exec(`ALTER TABLE threads ADD COLUMN confidence_json TEXT`);
  if (!threadColSet.has("intent_trace_json")) db.exec(`ALTER TABLE threads ADD COLUMN intent_trace_json TEXT`);
  if (!threadColSet.has("commitments_json")) db.exec(`ALTER TABLE threads ADD COLUMN commitments_json TEXT`);
  if (!threadColSet.has("generation_outcomes_json")) db.exec(`ALTER TABLE threads ADD COLUMN generation_outcomes_json TEXT`);
  if (!threadColSet.has("instructions_md")) db.exec(`ALTER TABLE threads ADD COLUMN instructions_md TEXT`);
  if (!threadColSet.has("learning_mode")) {
    db.exec(`ALTER TABLE threads ADD COLUMN learning_mode TEXT NOT NULL DEFAULT 'practice'`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_collectors (
      thread_id TEXT PRIMARY KEY,
      current_question_key TEXT,
      buffer_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
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

  const activityCols = db.prepare(`PRAGMA table_info(activities)`).all() as { name: string }[];
  const activityColSet = new Set(activityCols.map((c) => c.name));

  if (!activityColSet.has("status")) {
    db.exec(`ALTER TABLE activities ADD COLUMN status TEXT NOT NULL DEFAULT 'DRAFT'`);
  }
  if (!activityColSet.has("time_limit_seconds")) {
    db.exec(`ALTER TABLE activities ADD COLUMN time_limit_seconds INTEGER`);
  }

  db.exec(`
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

  db.exec(`
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

  db.exec(`
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS generation_runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      activity_id TEXT,
      total_slots INTEGER NOT NULL DEFAULT 0,
      completed_slots INTEGER NOT NULL DEFAULT 0,
      successful_slots INTEGER NOT NULL DEFAULT 0,
      failed_slots INTEGER NOT NULL DEFAULT 0,
      last_failure_kind TEXT,
      last_failure_code TEXT,
      last_failure_message TEXT,
      meta_json TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
      FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE SET NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS generation_slot_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      slot_index INTEGER NOT NULL,
      status TEXT NOT NULL,
      current_stage TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      topic TEXT,
      language TEXT,
      started_at TEXT,
      ended_at TEXT,
      last_failure_kind TEXT,
      last_failure_code TEXT,
      last_failure_message TEXT,
      last_artifact_hash TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_id, slot_index),
      FOREIGN KEY (run_id) REFERENCES generation_runs(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS generation_slot_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      slot_index INTEGER NOT NULL,
      attempt INTEGER,
      stage TEXT,
      status TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES generation_runs(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS generation_execution_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      slot_index INTEGER NOT NULL,
      attempt INTEGER NOT NULL,
      execution_phase TEXT NOT NULL,
      bundle_hash TEXT NOT NULL,
      strategy TEXT,
      budget_profile_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      exit_code INTEGER,
      timeout_stage TEXT,
      watchdog_source TEXT,
      failure_category TEXT,
      stdout_hash TEXT,
      stderr_hash TEXT,
      stdout_snippet TEXT,
      stderr_snippet TEXT,
      parsed_failures_json TEXT,
      trace_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES generation_runs(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS generation_slot_diagnoses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      slot_index INTEGER NOT NULL,
      attempt INTEGER NOT NULL,
      diagnosis_class TEXT NOT NULL,
      recoverability TEXT NOT NULL,
      normalized_symptom TEXT NOT NULL,
      recommended_repair_strategy TEXT,
      source_execution_attempt_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES generation_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (source_execution_attempt_id) REFERENCES generation_execution_attempts(id) ON DELETE SET NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS generation_run_failure_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      language TEXT NOT NULL,
      topic_signature TEXT NOT NULL,
      failure_class TEXT NOT NULL,
      normalized_symptom TEXT NOT NULL,
      guardrail_patch_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES generation_runs(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_threads_state ON threads(state);
    CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_id ON thread_messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_thread_collectors_thread_id ON thread_collectors(thread_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_activity_id ON submissions(activity_id);
    CREATE INDEX IF NOT EXISTS idx_runs_thread_id ON runs(thread_id);
    CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id);
    CREATE INDEX IF NOT EXISTS idx_generation_runs_thread_id ON generation_runs(thread_id);
    CREATE INDEX IF NOT EXISTS idx_generation_runs_status ON generation_runs(status);
    CREATE INDEX IF NOT EXISTS idx_generation_slot_runs_run_id ON generation_slot_runs(run_id);
    CREATE INDEX IF NOT EXISTS idx_generation_slot_transitions_run_id ON generation_slot_transitions(run_id);
    CREATE INDEX IF NOT EXISTS idx_generation_execution_attempts_run_slot ON generation_execution_attempts(run_id, slot_index, attempt);
    CREATE INDEX IF NOT EXISTS idx_generation_slot_diagnoses_run_slot ON generation_slot_diagnoses(run_id, slot_index, attempt);
    CREATE INDEX IF NOT EXISTS idx_generation_run_failure_cache_run_id ON generation_run_failure_cache(run_id);
  `);

  console.log("Database initialized successfully");
}
