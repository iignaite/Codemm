import db from "../db";

export type RunKind = "generation" | "judge.run" | "judge.submit";
export type RunStatus = "running" | "succeeded" | "failed";

export type RunRecord = {
  id: string;
  thread_id: string | null;
  kind: RunKind;
  status: RunStatus;
  meta_json: string | null;
  created_at: string;
  finished_at: string | null;
};

export type RunEventRecord = {
  seq: number;
  type: string;
  payload_json: string;
  created_at: string;
};

export const runRepository = {
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
    return stmt.get(id) as RunRecord | undefined;
  },
  latestByThread: (threadId: string, kind: RunKind) => {
    const stmt = db.prepare(
      `SELECT * FROM runs WHERE thread_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1`
    );
    return stmt.get(threadId, kind) as RunRecord | undefined;
  },
  listByThread: (threadId: string, kind: RunKind, limit: number = 20) => {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const stmt = db.prepare(
      `SELECT * FROM runs WHERE thread_id = ? AND kind = ? ORDER BY created_at DESC LIMIT ?`
    );
    return stmt.all(threadId, kind, safeLimit) as RunRecord[];
  },
};

export const runEventRepository = {
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
    return stmt.all(runId, safeLimit) as RunEventRecord[];
  },
};
