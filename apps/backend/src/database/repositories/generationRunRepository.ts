import type {
  GenerationFailureKind,
  GenerationRunStatus,
  GenerationSlotStage,
  GenerationSlotTerminalStatus,
} from "@codemm/shared-contracts";
import db from "../db";

export type DBGenerationRun = {
  id: string;
  thread_id: string;
  status: GenerationRunStatus | string;
  activity_id: string | null;
  total_slots: number;
  completed_slots: number;
  successful_slots: number;
  failed_slots: number;
  last_failure_kind: GenerationFailureKind | null;
  last_failure_code: string | null;
  last_failure_message: string | null;
  meta_json: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DBGenerationSlotRun = {
  id: number;
  run_id: string;
  slot_index: number;
  status: GenerationSlotStage | string;
  current_stage: string | null;
  attempt_count: number;
  title: string | null;
  topic: string | null;
  language: string | null;
  started_at: string | null;
  ended_at: string | null;
  last_failure_kind: GenerationFailureKind | null;
  last_failure_code: string | null;
  last_failure_message: string | null;
  last_artifact_hash: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
};

export type DBGenerationSlotTransition = {
  id: number;
  run_id: string;
  slot_index: number;
  attempt: number | null;
  stage: string | null;
  status: string;
  payload_json: string | null;
  created_at: string;
};

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "null";
  }
}

export const generationRunRepository = {
  create(args: {
    id: string;
    threadId: string;
    totalSlots: number;
    metaJson?: string | null;
  }) {
    const stmt = db.prepare(
      `INSERT INTO generation_runs (
         id, thread_id, status, activity_id, total_slots, completed_slots, successful_slots, failed_slots,
         last_failure_kind, last_failure_code, last_failure_message, meta_json, started_at, finished_at, created_at, updated_at
       ) VALUES (?, ?, 'PENDING', NULL, ?, 0, 0, 0, NULL, NULL, NULL, ?, NULL, NULL, datetime('now'), datetime('now'))`
    );
    stmt.run(args.id, args.threadId, args.totalSlots, args.metaJson ?? null);
  },

  markRunning(id: string) {
    const stmt = db.prepare(
      `UPDATE generation_runs
         SET status = 'RUNNING',
             started_at = COALESCE(started_at, datetime('now')),
             updated_at = datetime('now')
       WHERE id = ?`
    );
    stmt.run(id);
  },

  finish(args: {
    id: string;
    status: GenerationRunStatus;
    activityId?: string | null;
    completedSlots: number;
    successfulSlots: number;
    failedSlots: number;
    lastFailureKind?: GenerationFailureKind | null;
    lastFailureCode?: string | null;
    lastFailureMessage?: string | null;
  }) {
    const stmt = db.prepare(
      `UPDATE generation_runs
         SET status = ?,
             activity_id = ?,
             completed_slots = ?,
             successful_slots = ?,
             failed_slots = ?,
             last_failure_kind = ?,
             last_failure_code = ?,
             last_failure_message = ?,
             finished_at = datetime('now'),
             updated_at = datetime('now')
       WHERE id = ?`
    );
    stmt.run(
      args.status,
      args.activityId ?? null,
      args.completedSlots,
      args.successfulSlots,
      args.failedSlots,
      args.lastFailureKind ?? null,
      args.lastFailureCode ?? null,
      args.lastFailureMessage ?? null,
      args.id
    );
  },

  findById(id: string) {
    const stmt = db.prepare(`SELECT * FROM generation_runs WHERE id = ?`);
    return stmt.get(id) as DBGenerationRun | undefined;
  },

  latestByThread(threadId: string) {
    const stmt = db.prepare(
      `SELECT * FROM generation_runs WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`
    );
    return stmt.get(threadId) as DBGenerationRun | undefined;
  },

  listStaleActiveRuns() {
    const stmt = db.prepare(
      `SELECT * FROM generation_runs WHERE status IN ('PENDING', 'RUNNING') ORDER BY created_at ASC`
    );
    return stmt.all() as DBGenerationRun[];
  },
};

export const generationSlotRunRepository = {
  seed(runId: string, slots: Array<{ slotIndex: number; topic?: string | null; language?: string | null }>) {
    const insert = db.prepare(
      `INSERT OR REPLACE INTO generation_slot_runs (
         run_id, slot_index, status, current_stage, attempt_count, title, topic, language,
         started_at, ended_at, last_failure_kind, last_failure_code, last_failure_message, last_artifact_hash,
         result_json, created_at, updated_at
       ) VALUES (?, ?, 'QUEUED', 'QUEUED', 0, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, datetime('now'), datetime('now'))`
    );
    const tx = db.transaction((rows: Array<{ slotIndex: number; topic?: string | null; language?: string | null }>) => {
      for (const row of rows) {
        insert.run(runId, row.slotIndex, row.topic ?? null, row.language ?? null);
      }
    });
    tx(slots);
  },

  find(runId: string, slotIndex: number) {
    const stmt = db.prepare(`SELECT * FROM generation_slot_runs WHERE run_id = ? AND slot_index = ?`);
    return stmt.get(runId, slotIndex) as DBGenerationSlotRun | undefined;
  },

  listByRun(runId: string) {
    const stmt = db.prepare(`SELECT * FROM generation_slot_runs WHERE run_id = ? ORDER BY slot_index ASC`);
    return stmt.all(runId) as DBGenerationSlotRun[];
  },

  beginSlot(args: {
    runId: string;
    slotIndex: number;
    topic: string;
    language: string;
  }) {
    const stmt = db.prepare(
      `UPDATE generation_slot_runs
         SET status = 'SKELETON_RUNNING',
             current_stage = 'SKELETON_RUNNING',
             topic = ?,
             language = ?,
             started_at = COALESCE(started_at, datetime('now')),
             updated_at = datetime('now')
       WHERE run_id = ? AND slot_index = ?`
    );
    stmt.run(args.topic, args.language, args.runId, args.slotIndex);
  },

  updateStage(args: {
    runId: string;
    slotIndex: number;
    status: GenerationSlotStage;
    currentStage?: string | null;
    attemptCount?: number;
    title?: string | null;
    lastFailureKind?: GenerationFailureKind | null;
    lastFailureCode?: string | null;
    lastFailureMessage?: string | null;
    lastArtifactHash?: string | null;
    result?: unknown;
    ended?: boolean;
  }) {
    const stmt = db.prepare(
      `UPDATE generation_slot_runs
         SET status = ?,
             current_stage = ?,
             attempt_count = ?,
             title = COALESCE(?, title),
             last_failure_kind = ?,
             last_failure_code = ?,
             last_failure_message = ?,
             last_artifact_hash = COALESCE(?, last_artifact_hash),
             result_json = COALESCE(?, result_json),
             ended_at = CASE WHEN ? = 1 THEN datetime('now') ELSE ended_at END,
             updated_at = datetime('now')
       WHERE run_id = ? AND slot_index = ?`
    );
    const current = this.find(args.runId, args.slotIndex);
    stmt.run(
      args.status,
      args.currentStage ?? args.status,
      args.attemptCount ?? current?.attempt_count ?? 0,
      args.title ?? null,
      args.lastFailureKind ?? null,
      args.lastFailureCode ?? null,
      args.lastFailureMessage ?? null,
      args.lastArtifactHash ?? null,
      typeof args.result === "undefined" ? null : safeJsonStringify(args.result),
      args.ended ? 1 : 0,
      args.runId,
      args.slotIndex
    );
  },

  appendTransition(args: {
    runId: string;
    slotIndex: number;
    attempt?: number | null;
    stage?: string | null;
    status: string;
    payload?: unknown;
  }) {
    const stmt = db.prepare(
      `INSERT INTO generation_slot_transitions (run_id, slot_index, attempt, stage, status, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    );
    stmt.run(
      args.runId,
      args.slotIndex,
      typeof args.attempt === "number" ? args.attempt : null,
      args.stage ?? null,
      args.status,
      typeof args.payload === "undefined" ? null : safeJsonStringify(args.payload)
    );
  },

  markTerminal(args: {
    runId: string;
    slotIndex: number;
    status: GenerationSlotTerminalStatus;
    attemptCount: number;
    title?: string | null;
    result?: unknown;
    lastFailureKind?: GenerationFailureKind | null;
    lastFailureCode?: string | null;
    lastFailureMessage?: string | null;
  }) {
    const nextArgs: Parameters<typeof generationSlotRunRepository.updateStage>[0] = {
      runId: args.runId,
      slotIndex: args.slotIndex,
      status: args.status,
      currentStage: args.status,
      attemptCount: args.attemptCount,
      ended: true,
    };
    if (typeof args.title !== "undefined") nextArgs.title = args.title;
    if (typeof args.result !== "undefined") nextArgs.result = args.result;
    if (typeof args.lastFailureKind !== "undefined") nextArgs.lastFailureKind = args.lastFailureKind;
    if (typeof args.lastFailureCode !== "undefined") nextArgs.lastFailureCode = args.lastFailureCode;
    if (typeof args.lastFailureMessage !== "undefined") nextArgs.lastFailureMessage = args.lastFailureMessage;
    this.updateStage(nextArgs);
  },

  reconcileIncomplete(runId: string) {
    const stmt = db.prepare(
      `UPDATE generation_slot_runs
         SET status = CASE
               WHEN status = 'QUEUED' THEN 'SKIPPED'
               ELSE 'RETRYABLE_FAILURE'
             END,
             current_stage = CASE
               WHEN status = 'QUEUED' THEN 'SKIPPED'
               ELSE 'RETRYABLE_FAILURE'
             END,
             last_failure_code = COALESCE(last_failure_code, 'ENGINE_RESTART'),
             last_failure_message = COALESCE(last_failure_message, 'Generation was interrupted before slot completion.'),
             ended_at = COALESCE(ended_at, datetime('now')),
             updated_at = datetime('now')
       WHERE run_id = ?
         AND status NOT IN ('SUCCEEDED', 'RETRYABLE_FAILURE', 'HARD_FAILURE', 'SKIPPED')`
    );
    stmt.run(runId);
  },
};

export const generationSlotTransitionRepository = {
  listByRun(runId: string) {
    const stmt = db.prepare(`SELECT * FROM generation_slot_transitions WHERE run_id = ? ORDER BY id ASC`);
    return stmt.all(runId) as DBGenerationSlotTransition[];
  },
};
