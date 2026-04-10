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

export type DBGenerationExecutionAttempt = {
  id: number;
  run_id: string;
  slot_index: number;
  attempt: number;
  execution_phase: "compile" | "test_exec" | "quality_gate" | string;
  bundle_hash: string;
  strategy: string | null;
  budget_profile_json: string | null;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  timeout_stage: "compile" | "execute" | "overall" | string | null;
  watchdog_source: "inner" | "outer" | "unknown" | string | null;
  failure_category: string | null;
  stdout_hash: string | null;
  stderr_hash: string | null;
  stdout_snippet: string | null;
  stderr_snippet: string | null;
  parsed_failures_json: string | null;
  trace_json: string | null;
  created_at: string;
};

export type DBGenerationSlotDiagnosis = {
  id: number;
  run_id: string;
  slot_index: number;
  attempt: number;
  diagnosis_class: string;
  recoverability: "recoverable" | "fatal" | "quarantine" | string;
  normalized_symptom: string;
  recommended_repair_strategy: string | null;
  source_execution_attempt_id: number | null;
  created_at: string;
};

export type DBGenerationRunFailureCacheEntry = {
  id: number;
  run_id: string;
  language: string;
  topic_signature: string;
  failure_class: string;
  normalized_symptom: string;
  guardrail_patch_json: string | null;
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

export const generationExecutionAttemptRepository = {
  create(args: {
    runId: string;
    slotIndex: number;
    attempt: number;
    executionPhase: "compile" | "test_exec" | "quality_gate";
    bundleHash: string;
    strategy?: string | null;
    budgetProfile?: unknown;
    startedAt: string;
    finishedAt?: string | null;
    exitCode?: number | null;
    timeoutStage?: "compile" | "execute" | "overall" | null;
    watchdogSource?: "inner" | "outer" | "unknown" | null;
    failureCategory?: string | null;
    stdoutHash?: string | null;
    stderrHash?: string | null;
    stdoutSnippet?: string | null;
    stderrSnippet?: string | null;
    parsedFailures?: unknown;
    trace?: unknown;
  }) {
    const stmt = db.prepare(
      `INSERT INTO generation_execution_attempts (
         run_id, slot_index, attempt, execution_phase, bundle_hash, strategy, budget_profile_json,
         started_at, finished_at, exit_code, timeout_stage, watchdog_source, failure_category,
         stdout_hash, stderr_hash, stdout_snippet, stderr_snippet, parsed_failures_json, trace_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      args.runId,
      args.slotIndex,
      args.attempt,
      args.executionPhase,
      args.bundleHash,
      args.strategy ?? null,
      typeof args.budgetProfile === "undefined" ? null : safeJsonStringify(args.budgetProfile),
      args.startedAt,
      args.finishedAt ?? null,
      typeof args.exitCode === "number" ? args.exitCode : null,
      args.timeoutStage ?? null,
      args.watchdogSource ?? null,
      args.failureCategory ?? null,
      args.stdoutHash ?? null,
      args.stderrHash ?? null,
      args.stdoutSnippet ?? null,
      args.stderrSnippet ?? null,
      typeof args.parsedFailures === "undefined" ? null : safeJsonStringify(args.parsedFailures),
      typeof args.trace === "undefined" ? null : safeJsonStringify(args.trace)
    );
    return Number(result.lastInsertRowid);
  },

  listByRun(runId: string, slotIndex?: number) {
    if (typeof slotIndex === "number") {
      const stmt = db.prepare(
        `SELECT * FROM generation_execution_attempts WHERE run_id = ? AND slot_index = ? ORDER BY id ASC`
      );
      return stmt.all(runId, slotIndex) as DBGenerationExecutionAttempt[];
    }
    const stmt = db.prepare(`SELECT * FROM generation_execution_attempts WHERE run_id = ? ORDER BY id ASC`);
    return stmt.all(runId) as DBGenerationExecutionAttempt[];
  },
};

export const generationSlotDiagnosisRepository = {
  create(args: {
    runId: string;
    slotIndex: number;
    attempt: number;
    diagnosisClass: string;
    recoverability: "recoverable" | "fatal" | "quarantine";
    normalizedSymptom: string;
    recommendedRepairStrategy?: string | null;
    sourceExecutionAttemptId?: number | null;
  }) {
    const stmt = db.prepare(
      `INSERT INTO generation_slot_diagnoses (
         run_id, slot_index, attempt, diagnosis_class, recoverability, normalized_symptom,
         recommended_repair_strategy, source_execution_attempt_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      args.runId,
      args.slotIndex,
      args.attempt,
      args.diagnosisClass,
      args.recoverability,
      args.normalizedSymptom,
      args.recommendedRepairStrategy ?? null,
      args.sourceExecutionAttemptId ?? null
    );
    return Number(result.lastInsertRowid);
  },

  listByRun(runId: string, slotIndex?: number) {
    if (typeof slotIndex === "number") {
      const stmt = db.prepare(`SELECT * FROM generation_slot_diagnoses WHERE run_id = ? AND slot_index = ? ORDER BY id ASC`);
      return stmt.all(runId, slotIndex) as DBGenerationSlotDiagnosis[];
    }
    const stmt = db.prepare(`SELECT * FROM generation_slot_diagnoses WHERE run_id = ? ORDER BY id ASC`);
    return stmt.all(runId) as DBGenerationSlotDiagnosis[];
  },
};

export const generationRunFailureCacheRepository = {
  create(args: {
    runId: string;
    language: string;
    topicSignature: string;
    failureClass: string;
    normalizedSymptom: string;
    guardrailPatch?: unknown;
  }) {
    const stmt = db.prepare(
      `INSERT INTO generation_run_failure_cache (
         run_id, language, topic_signature, failure_class, normalized_symptom, guardrail_patch_json
       ) VALUES (?, ?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      args.runId,
      args.language,
      args.topicSignature,
      args.failureClass,
      args.normalizedSymptom,
      typeof args.guardrailPatch === "undefined" ? null : safeJsonStringify(args.guardrailPatch)
    );
    return Number(result.lastInsertRowid);
  },

  listByRun(runId: string) {
    const stmt = db.prepare(`SELECT * FROM generation_run_failure_cache WHERE run_id = ? ORDER BY id ASC`);
    return stmt.all(runId) as DBGenerationRunFailureCacheEntry[];
  },
};
