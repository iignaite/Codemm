import db from "../db";

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

export const threadRepository = {
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

  findByActivityId: (activityId: string): DBSession | undefined => {
    const stmt = db.prepare(`SELECT * FROM threads WHERE activity_id = ? ORDER BY updated_at DESC LIMIT 1`);
    return stmt.get(activityId) as DBSession | undefined;
  },

  updateState: (id: string, state: string) => {
    const stmt = db.prepare(`UPDATE threads SET state = ?, updated_at = datetime('now') WHERE id = ?`);
    stmt.run(state, id);
  },

  updateSpecJson: (id: string, specJson: string) => {
    const stmt = db.prepare(`UPDATE threads SET spec_json = ?, updated_at = datetime('now') WHERE id = ?`);
    stmt.run(specJson, id);
  },

  setInstructionsMd: (id: string, instructionsMd: string | null) => {
    const stmt = db.prepare(`UPDATE threads SET instructions_md = ?, updated_at = datetime('now') WHERE id = ?`);
    stmt.run(instructionsMd ?? null, id);
  },

  setPlanJson: (id: string, planJson: string) => {
    const stmt = db.prepare(`UPDATE threads SET plan_json = ?, updated_at = datetime('now') WHERE id = ?`);
    stmt.run(planJson, id);
  },

  setProblemsJson: (id: string, problemsJson: string) => {
    const stmt = db.prepare(`UPDATE threads SET problems_json = ?, updated_at = datetime('now') WHERE id = ?`);
    stmt.run(problemsJson, id);
  },

  setActivityId: (id: string, activityId: string) => {
    const stmt = db.prepare(`UPDATE threads SET activity_id = ?, updated_at = datetime('now') WHERE id = ?`);
    stmt.run(activityId, id);
  },

  setLastError: (id: string, error: string | null) => {
    const stmt = db.prepare(`UPDATE threads SET last_error = ?, updated_at = datetime('now') WHERE id = ?`);
    stmt.run(error, id);
  },

  updateConfidenceJson: (id: string, confidenceJson: string) => {
    const stmt = db.prepare(`UPDATE threads SET confidence_json = ?, updated_at = datetime('now') WHERE id = ?`);
    stmt.run(confidenceJson, id);
  },

  updateIntentTraceJson: (id: string, traceJson: string) => {
    const stmt = db.prepare(`UPDATE threads SET intent_trace_json = ?, updated_at = datetime('now') WHERE id = ?`);
    stmt.run(traceJson, id);
  },

  updateCommitmentsJson: (id: string, commitmentsJson: string) => {
    const stmt = db.prepare(`UPDATE threads SET commitments_json = ?, updated_at = datetime('now') WHERE id = ?`);
    stmt.run(commitmentsJson, id);
  },

  updateGenerationOutcomesJson: (id: string, outcomesJson: string) => {
    const stmt = db.prepare(`UPDATE threads SET generation_outcomes_json = ?, updated_at = datetime('now') WHERE id = ?`);
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

  listByStates: (states: string[]) => {
    if (!Array.isArray(states) || states.length === 0) return [] as DBSession[];
    const placeholders = states.map(() => "?").join(", ");
    const stmt = db.prepare(`SELECT * FROM threads WHERE state IN (${placeholders}) ORDER BY updated_at DESC`);
    return stmt.all(...states) as DBSession[];
  },
};

export const threadCollectorRepository = {
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

export const threadMessageRepository = {
  create: (id: string, threadId: string, role: "user" | "assistant", content: string) => {
    const stmt = db.prepare(
      `INSERT INTO thread_messages (id, thread_id, role, content, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    );
    stmt.run(id, threadId, role, content);
  },

  findByThreadId: (threadId: string): DBSessionMessage[] => {
    const stmt = db.prepare(`SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY created_at ASC`);
    return stmt.all(threadId) as DBSessionMessage[];
  },
};
