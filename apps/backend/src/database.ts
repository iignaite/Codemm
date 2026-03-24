import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import dotenv from "dotenv";

// Load `.env` early so CODEMM_DB_PATH can be used even when this module is imported before `dotenv.config()`.
dotenv.config();

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function resolveDirPath(p: string): string {
  const expanded = expandTilde(p);
  return path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
}

function resolveDbFilePath(p: string): string {
  const resolved = resolveDirPath(p);
  ensureDir(path.dirname(resolved));
  return resolved;
}

function pickWritableDataDir(preferredDir: string): string {
  try {
    ensureDir(preferredDir);
    return preferredDir;
  } catch (err) {
    const cwdDir = path.join(process.cwd(), ".codemm");
    try {
      ensureDir(cwdDir);
      // eslint-disable-next-line no-console
      console.warn(`[db] Falling back to writable data dir: ${cwdDir} (preferred failed: ${preferredDir})`, err);
      return cwdDir;
    } catch {
      const tmpDir = path.join(os.tmpdir(), "codemm");
      ensureDir(tmpDir);
      // eslint-disable-next-line no-console
      console.warn(`[db] Falling back to temp data dir: ${tmpDir} (preferred failed: ${preferredDir})`, err);
      return tmpDir;
    }
  }
}

function getDefaultDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Codemm");
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Codemm");
  }

  const xdg = typeof process.env.XDG_DATA_HOME === "string" ? process.env.XDG_DATA_HOME.trim() : "";
  if (xdg) return path.join(xdg, "codemm");
  return path.join(os.homedir(), ".local", "share", "codemm");
}

const envDbPath = process.env.CODEMM_DB_PATH;
const envDbDir = process.env.CODEMM_DB_DIR;
let dbPath: string;

if (typeof envDbPath === "string" && envDbPath.trim()) {
  const trimmed = envDbPath.trim();
  dbPath = trimmed === ":memory:" ? ":memory:" : resolveDbFilePath(trimmed);
} else {
  const dataDir =
    typeof envDbDir === "string" && envDbDir.trim()
      ? resolveDirPath(envDbDir.trim())
      : pickWritableDataDir(getDefaultDataDir());

  ensureDir(dataDir);
  dbPath = path.join(dataDir, "codemm.db");
}

let db: Database.Database;
try {
  db = new Database(dbPath);
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(`[db] Failed to open SQLite DB at: ${dbPath}`);
  throw err;
}

// Enable foreign keys
db.pragma("foreign_keys = ON");
// Be resilient to transient locks (multiple readers/writers in dev).
db.pragma("busy_timeout = 5000");

// Initialize database schema
export function initializeDatabase() {
  // ==========================================================
  // IDE-first persistence (local-only, no auth/user accounts)
  // ==========================================================
  //
  // Note: legacy SaaS-era DBs may still contain users/community tables/columns.

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

  // ----------------------------------------------------------
  // Migration: sessions → threads (and related tables/columns)
  // ----------------------------------------------------------
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

  // threads (local conversation + deterministic state machine)
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

  // Lightweight migrations for older DBs (SQLite can't add columns in CREATE TABLE IF NOT EXISTS).
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

  // Activities table
  db.exec(`
    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT,
      problems TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      time_limit_seconds INTEGER,
      created_at TEXT NOT NULL
      -- no foreign keys: local-only store
    )
  `);

  const activityCols = db
    .prepare(`PRAGMA table_info(activities)`)
    .all() as { name: string }[];
  const activityColSet = new Set(activityCols.map((c) => c.name));

  if (!activityColSet.has("status")) {
    db.exec(`ALTER TABLE activities ADD COLUMN status TEXT NOT NULL DEFAULT 'DRAFT'`);
  }
  if (!activityColSet.has("time_limit_seconds")) {
    db.exec(`ALTER TABLE activities ADD COLUMN time_limit_seconds INTEGER`);
  }

  // Submissions table
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

  // Runs + events (append-only, replayable)
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

  // Create indexes for better performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_threads_state ON threads(state);
    CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_id ON thread_messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_thread_collectors_thread_id ON thread_collectors(thread_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_activity_id ON submissions(activity_id);
    CREATE INDEX IF NOT EXISTS idx_runs_thread_id ON runs(thread_id);
    CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id);
  `);

  console.log("Database initialized successfully");
}

export interface DBActivity {
  id: string;
  title: string;
  prompt?: string;
  problems: string; // JSON string
  status?: string;
  time_limit_seconds?: number | null;
  created_at: string;
}

export interface DBActivitySummary {
  id: string;
  title: string;
  status?: string;
  time_limit_seconds?: number | null;
  created_at: string;
}

export interface Submission {
  id: number;
  activity_id: string;
  problem_id: string;
  code: string;
  success: boolean;
  passed_tests: number;
  total_tests: number;
  execution_time_ms?: number;
  submitted_at: string;
}

export interface DBSession {
  id: string;
  state: string;
  learning_mode?: string | null;
  spec_json: string;
  instructions_md?: string | null;
  plan_json?: string | null;
  problems_json?: string | null;
  activity_id?: string | null;
  last_error?: string | null;
  confidence_json?: string | null;
  intent_trace_json?: string | null;
  commitments_json?: string | null;
  generation_outcomes_json?: string | null;
  created_at: string;
  updated_at: string;
}

export interface DBSessionSummary {
  id: string;
  state: string;
  learning_mode: string | null;
  created_at: string;
  updated_at: string;
  activity_id: string | null;
  last_message: string | null;
  last_message_at: string | null;
  message_count: number;
}

export interface DBLearnerProfile {
  // removed (SaaS/user-account concept)
}

export interface DBSessionMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface DBSessionCollector {
  session_id: string;
  current_question_key: string | null;
  buffer_json: string;
  created_at: string;
  updated_at: string;
}

// User operations
export const userDb = undefined as never;

// Activity operations
export const activityDb = {
  create: (
    id: string,
    title: string,
    problems: string,
    prompt?: string,
    opts?: { status?: "DRAFT" | "PUBLISHED"; timeLimitSeconds?: number | null }
  ) => {
    const stmt = db.prepare(
      `INSERT INTO activities (id, title, prompt, problems, status, time_limit_seconds, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    );
    const status = opts?.status ?? "DRAFT";
    const timeLimitSeconds = typeof opts?.timeLimitSeconds === "number" ? opts.timeLimitSeconds : null;
    stmt.run(id, title, prompt || "", problems, status, timeLimitSeconds);
  },

  findById: (id: string): DBActivity | undefined => {
    const stmt = db.prepare(`SELECT * FROM activities WHERE id = ?`);
    return stmt.get(id) as DBActivity | undefined;
  },

  listSummaries: (limit: number = 50): DBActivitySummary[] => {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const stmt = db.prepare(
      `SELECT id, title, status, time_limit_seconds, created_at FROM activities ORDER BY created_at DESC LIMIT ?`
    );
    return stmt.all(safeLimit) as DBActivitySummary[];
  },

  listAll: (limit: number = 50): DBActivity[] => {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const stmt = db.prepare(`SELECT * FROM activities ORDER BY created_at DESC LIMIT ?`);
    return stmt.all(safeLimit) as DBActivity[];
  },

  delete: (id: string) => {
    const stmt = db.prepare(`DELETE FROM activities WHERE id = ?`);
    stmt.run(id);
  },

  update: (
    id: string,
    patch: {
      title?: string;
      prompt?: string;
      problems?: string;
      time_limit_seconds?: number | null;
      status?: "DRAFT" | "PUBLISHED";
    }
  ): DBActivity | undefined => {
    const sets: string[] = [];
    const args: any[] = [];

    if (typeof patch.title === "string") {
      sets.push("title = ?");
      args.push(patch.title);
    }
    if (typeof patch.prompt === "string") {
      sets.push("prompt = ?");
      args.push(patch.prompt);
    }
    if (typeof patch.problems === "string") {
      sets.push("problems = ?");
      args.push(patch.problems);
    }
    if (typeof patch.time_limit_seconds !== "undefined") {
      sets.push("time_limit_seconds = ?");
      args.push(patch.time_limit_seconds ?? null);
    }
    if (typeof patch.status === "string") {
      sets.push("status = ?");
      args.push(patch.status);
    }

    if (sets.length === 0) return activityDb.findById(id);

    const stmt = db.prepare(`UPDATE activities SET ${sets.join(", ")} WHERE id = ?`);
    stmt.run(...args, id);
    return activityDb.findById(id);
  },
};

// Submission operations
export const submissionDb = {
  create: (
    activityId: string,
    problemId: string,
    code: string,
    success: boolean,
    passedTests: number,
    totalTests: number,
    executionTimeMs?: number
  ) => {
    const stmt = db.prepare(
      `INSERT INTO submissions (activity_id, problem_id, code, success, passed_tests, total_tests, execution_time_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      activityId,
      problemId,
      code,
      success ? 1 : 0,
      passedTests,
      totalTests,
      executionTimeMs || null
    );
    return result.lastInsertRowid as number;
  },

  findByActivityAndProblem: (activityId: string, problemId: string): Submission[] => {
    const stmt = db.prepare(
      `SELECT * FROM submissions 
       WHERE activity_id = ? AND problem_id = ?
       ORDER BY submitted_at DESC`
    );
    return stmt.all(activityId, problemId) as Submission[];
  },
};

// Codemm v1.0 Session operations (contract-driven)
export const threadDb = {
  create: (
    id: string,
    state: string,
    learningMode: string,
    specJson: string
  ) => {
    const stmt = db.prepare(
      `INSERT INTO threads (id, state, learning_mode, spec_json, instructions_md, confidence_json, intent_trace_json, commitments_json, generation_outcomes_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    );
    stmt.run(id, state, learningMode, specJson, null, "{}", "[]", "[]", "[]");
  },

  findById: (id: string): DBSession | undefined => {
    const stmt = db.prepare(`SELECT * FROM threads WHERE id = ?`);
    return stmt.get(id) as DBSession | undefined;
  },

  updateState: (id: string, state: string) => {
    const stmt = db.prepare(
      `UPDATE threads SET state = ?, updated_at = datetime('now') WHERE id = ?`
    );
    stmt.run(state, id);
  },

  updateSpecJson: (id: string, specJson: string) => {
    const stmt = db.prepare(
      `UPDATE threads SET spec_json = ?, updated_at = datetime('now') WHERE id = ?`
    );
    stmt.run(specJson, id);
  },

  setInstructionsMd: (id: string, instructionsMd: string | null) => {
    const stmt = db.prepare(
      `UPDATE threads SET instructions_md = ?, updated_at = datetime('now') WHERE id = ?`
    );
    stmt.run(instructionsMd ?? null, id);
  },

  setPlanJson: (id: string, planJson: string) => {
    const stmt = db.prepare(
      `UPDATE threads SET plan_json = ?, updated_at = datetime('now') WHERE id = ?`
    );
    stmt.run(planJson, id);
  },

  setProblemsJson: (id: string, problemsJson: string) => {
    const stmt = db.prepare(
      `UPDATE threads SET problems_json = ?, updated_at = datetime('now') WHERE id = ?`
    );
    stmt.run(problemsJson, id);
  },

  setActivityId: (id: string, activityId: string) => {
    const stmt = db.prepare(
      `UPDATE threads SET activity_id = ?, updated_at = datetime('now') WHERE id = ?`
    );
    stmt.run(activityId, id);
  },

  setLastError: (id: string, error: string | null) => {
    const stmt = db.prepare(
      `UPDATE threads SET last_error = ?, updated_at = datetime('now') WHERE id = ?`
    );
    stmt.run(error, id);
  },

  updateConfidenceJson: (id: string, confidenceJson: string) => {
    const stmt = db.prepare(
      `UPDATE threads SET confidence_json = ?, updated_at = datetime('now') WHERE id = ?`
    );
    stmt.run(confidenceJson, id);
  },

  updateIntentTraceJson: (id: string, traceJson: string) => {
    const stmt = db.prepare(
      `UPDATE threads SET intent_trace_json = ?, updated_at = datetime('now') WHERE id = ?`
    );
    stmt.run(traceJson, id);
  },

  updateCommitmentsJson: (id: string, commitmentsJson: string) => {
    const stmt = db.prepare(
      `UPDATE threads SET commitments_json = ?, updated_at = datetime('now') WHERE id = ?`
    );
    stmt.run(commitmentsJson, id);
  },

  updateGenerationOutcomesJson: (id: string, outcomesJson: string) => {
    const stmt = db.prepare(
      `UPDATE threads SET generation_outcomes_json = ?, updated_at = datetime('now') WHERE id = ?`
    );
    stmt.run(outcomesJson, id);
  },

  listSummaries: (limit: number = 50): DBSessionSummary[] => {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const stmt = db.prepare(`
      SELECT
        s.id,
        s.state,
        s.learning_mode,
        s.created_at,
        s.updated_at,
        s.activity_id,
        (
          SELECT m.content
          FROM thread_messages m
          WHERE m.thread_id = s.id
          ORDER BY m.created_at DESC
          LIMIT 1
        ) AS last_message,
        (
          SELECT m.created_at
          FROM thread_messages m
          WHERE m.thread_id = s.id
          ORDER BY m.created_at DESC
          LIMIT 1
        ) AS last_message_at,
        (
          SELECT COUNT(*)
          FROM thread_messages m
          WHERE m.thread_id = s.id
        ) AS message_count
      FROM threads s
      ORDER BY COALESCE(last_message_at, s.updated_at) DESC
      LIMIT ?
    `);
    return stmt.all(safeLimit) as DBSessionSummary[];
  },
};

export const threadCollectorDb = {
  upsert: (threadId: string, currentQuestionKey: string | null, buffer: string[]) => {
    const stmt = db.prepare(
      `INSERT INTO thread_collectors (thread_id, current_question_key, buffer_json, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(thread_id) DO UPDATE SET
         current_question_key = excluded.current_question_key,
         buffer_json = excluded.buffer_json,
         updated_at = datetime('now')`
    );
    stmt.run(threadId, currentQuestionKey ?? null, JSON.stringify(buffer));
  },

  findByThreadId: (threadId: string): DBSessionCollector | undefined => {
    const stmt = db.prepare(`SELECT * FROM thread_collectors WHERE thread_id = ?`);
    return stmt.get(threadId) as DBSessionCollector | undefined;
  },
};

export const threadMessageDb = {
  create: (id: string, threadId: string, role: "user" | "assistant", content: string) => {
    const stmt = db.prepare(
      `INSERT INTO thread_messages (id, thread_id, role, content, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    );
    stmt.run(id, threadId, role, content);
  },

  findByThreadId: (threadId: string): DBSessionMessage[] => {
    const stmt = db.prepare(
      `SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY created_at ASC`
    );
    return stmt.all(threadId) as DBSessionMessage[];
  },
};

export const learnerProfileDb = undefined as never;

export type RunKind = "generation" | "judge.run" | "judge.submit";
export type RunStatus = "running" | "succeeded" | "failed";

export const runDb = {
  create: (id: string, kind: RunKind, opts?: { threadId?: string | null; metaJson?: string | null }) => {
    const stmt = db.prepare(
      `INSERT INTO runs (id, thread_id, kind, status, meta_json, created_at)
       VALUES (?, ?, ?, 'running', ?, datetime('now'))`
    );
    stmt.run(id, opts?.threadId ?? null, kind, opts?.metaJson ?? null);
  },
  finish: (id: string, status: RunStatus) => {
    const stmt = db.prepare(`UPDATE runs SET status = ?, finished_at = datetime('now') WHERE id = ?`);
    stmt.run(status, id);
  },
  findById: (id: string) => {
    const stmt = db.prepare(`SELECT * FROM runs WHERE id = ?`);
    return stmt.get(id) as any | undefined;
  },
  latestByThread: (threadId: string, kind: RunKind) => {
    const stmt = db.prepare(
      `SELECT * FROM runs WHERE thread_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1`
    );
    return stmt.get(threadId, kind) as any | undefined;
  },
  listByThread: (threadId: string, kind: RunKind, limit: number = 20) => {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const stmt = db.prepare(
      `SELECT * FROM runs WHERE thread_id = ? AND kind = ? ORDER BY created_at DESC LIMIT ?`
    );
    return stmt.all(threadId, kind, safeLimit) as any[];
  },
};

export const runEventDb = {
  append: (runId: string, seq: number, type: string, payloadJson: string) => {
    const stmt = db.prepare(
      `INSERT INTO run_events (run_id, seq, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    );
    stmt.run(runId, seq, type, payloadJson);
  },
  listByRun: (runId: string, limit: number = 500) => {
    const safeLimit = Math.max(1, Math.min(5000, Math.floor(limit)));
    const stmt = db.prepare(
      `SELECT seq, type, payload_json, created_at FROM run_events WHERE run_id = ? ORDER BY seq ASC LIMIT ?`
    );
    return stmt.all(runId, safeLimit) as { seq: number; type: string; payload_json: string; created_at: string }[];
  },
};

export default db;
