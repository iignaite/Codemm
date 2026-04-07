import db from "../db";

export interface DBActivity {
  id: string;
  title: string;
  prompt?: string;
  problems: string;
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

export const activityRepository = {
  create: (
    id: string,
    title: string,
    problems: string,
    prompt?: string,
    opts?: { status?: "DRAFT" | "INCOMPLETE" | "PUBLISHED"; timeLimitSeconds?: number | null }
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
      status?: "DRAFT" | "INCOMPLETE" | "PUBLISHED";
    }
  ): DBActivity | undefined => {
    const sets: string[] = [];
    const args: unknown[] = [];

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

    if (sets.length === 0) return activityRepository.findById(id);

    const stmt = db.prepare(`UPDATE activities SET ${sets.join(", ")} WHERE id = ?`);
    stmt.run(...args, id);
    return activityRepository.findById(id);
  },
};

export const submissionRepository = {
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
