# Generation State Machine

This document describes the persistent activity-generation state machine used by Codemm.

## Goals

- Separate user-facing thread state from generation execution state.
- Persist slot-stage transitions instead of inferring them from transient progress events.
- Support partial success, overlapping runs, and restart recovery.
- Keep generation progress correlated by `runId`, not by thread alone.

## Aggregates

### Thread Aggregate

User-facing lifecycle:

- `DRAFT`
- `CLARIFYING`
- `READY`
- `GENERATE_PENDING`
- `GENERATING`
- `COMPLETED`
- `INCOMPLETE`
- `RETRYABLE_FAILURE`
- `HARD_FAILURE`

Rules:

- Thread state is derived from the latest persisted generation run.
- `GENERATE_PENDING` means the request has been accepted but slot execution has not started.
- `GENERATING` means there is an active persisted generation run in progress.
- Terminal thread outcomes do not imply all slots succeeded.

### Generation Run Aggregate

Persistent run lifecycle:

- `PENDING`
- `RUNNING`
- `COMPLETED`
- `INCOMPLETE`
- `RETRYABLE_FAILURE`
- `HARD_FAILURE`
- `ABORTED`

Source of truth:

- `generation_runs`

Important fields:

- `id`
- `thread_id`
- `status`
- `activity_id`
- `total_slots`
- `completed_slots`
- `successful_slots`
- `failed_slots`
- `last_failure_kind`
- `last_failure_code`
- `last_failure_message`
- `started_at`
- `finished_at`

### Slot Aggregate

Persistent slot-stage lifecycle:

- `QUEUED`
- `SKELETON_GENERATING`
- `TESTS_GENERATING`
- `REFERENCE_GENERATING`
- `GENERATION_CONTRACT_VALIDATING`
- `STATIC_ANALYSIS`
- `API_SHAPE_VALIDATION`
- `COMPLEXITY_RISK_ESTIMATION`
- `EXECUTION_BUNDLE_READY`
- `COMPILE_RUNNING`
- `TEST_EXEC_RUNNING`
- `QUALITY_GATE_RUNNING`
- `FAILURE_DIAGNOSED`
- `REPAIR_STRATEGY_SELECTED`
- `REPAIR_GENERATING`
- `REPAIR_SANITIZING`
- `REPAIR_EXECUTING`
- `SUCCEEDED`
- `RECOVERABLE_FAILED`
- `FATAL_FAILED`
- `QUARANTINED`
- `SKIPPED`

Source of truth:

- `generation_slot_runs`
- `generation_slot_transitions`
- `generation_execution_attempts`
- `generation_slot_diagnoses`
- `generation_run_failure_cache`

Important fields:

- `run_id`
- `slot_index`
- `status`
- `current_stage`
- `attempt_count`
- `started_at`
- `ended_at`
- `last_failure_kind`
- `last_failure_code`
- `last_failure_message`
- `last_artifact_hash`

## Transition Model

### Normal Flow

1. Thread in `READY` accepts a generation request.
2. Thread transitions to `GENERATE_PENDING`.
3. A `generation_runs` row is created in `PENDING`.
4. Slot rows are seeded in `generation_slot_runs` as `QUEUED`.
5. Run transitions to `RUNNING`.
6. Thread transitions to `GENERATING`.
7. Each slot generates artifacts (`skeleton`, `tests`, `reference`) and validates the generation contract.
8. The generated artifacts pass through a sanitization boundary before Docker execution:
   - static analysis
   - API-shape validation
   - complexity-risk estimation
   - execution-bundle construction
9. Only a validated in-memory execution bundle is passed to the judge.
10. Judge execution persists per-attempt execution traces and any resulting slot diagnoses.
11. Recoverable failures may enter the repair loop with an explicit repair strategy.
12. After all slots finish, run status is derived from slot terminal outcomes.
13. Thread status is derived from run status.

### Terminal Run Derivation

- All slots `SUCCEEDED` -> `COMPLETED`
- Mix of `SUCCEEDED` and failures/skips -> `INCOMPLETE`
- No success, only retryable failures/skips -> `RETRYABLE_FAILURE`
- No success, only hard failures -> `HARD_FAILURE`

## Failure Isolation

- Slot failure does not throw across the entire thread boundary.
- The orchestrator records slot terminal state and continues remaining slots.
- Thread outcome is derived after all slot results are known.
- Partial output is persisted as an activity with status `INCOMPLETE`, not as a normal completed learner activity.

## Run-Scoped Progress

- In-memory progress bus channels are keyed by `runId`.
- IPC subscriptions accept `runId`.
- Buffered replay prefers persisted `runs` + `run_events` for the requested `runId`.
- Frontend generation progress is subscribed before generation starts using a caller-generated `runId`.

## Crash Recovery

Startup reconciliation runs during engine boot:

1. Find stale `generation_runs` in `PENDING` or `RUNNING`.
2. Reconcile incomplete slot rows:
   - `QUEUED` -> `SKIPPED`
   - in-flight stage states -> `RETRYABLE_FAILURE`
3. Recompute terminal run outcome from reconciled slot rows.
4. Rewrite thread state from the recovered run.
5. Clear orphaned `GENERATE_PENDING` / `GENERATING` thread states even if the latest run is missing.

This prevents the database from remaining permanently inconsistent after crashes.

## Judge Integration

Reference validation now consumes structured judge outcomes:

- `COMPILE_FAILURE`
- `TEST_FAILURE`
- `TIME_BUDGET_EXCEEDED`
- `OUTPUT_LIMIT_EXCEEDED`
- `JUDGE_INFRA_FAILURE`

Judge containers are launched with:

- networking disabled
- read-only filesystem
- unprivileged container user
- bounded tmpfs
- CPU / memory / PID limits
- explicit container cleanup on forced termination

Java judging now compiles into `/tmp/classes` so `/workspace` can remain read-only.

Before Docker validation, staged generation now builds a validated execution bundle and performs fast sanitization checks:

- schema validation for generated artifacts
- API-shape alignment between starter, tests, and hidden reference
- language-specific stdin / interactive-input rejection where deterministic execution is required
- rough loop / recursion / complexity-risk heuristics
- per-language structural checks before any Docker call

The bundle is in-memory only. The database persists only hashes, findings, diagnosis metadata, and bounded execution snippets.

Before Docker validation, staged generation also performs a fast Java preflight for structural-topic slots:

- reject `stdin`-driven reference solutions for structural OOP topics
- assert structural-topic requirements (`encapsulation`, `inheritance`, `polymorphism`, etc.) against the generated reference + test suite
- short-circuit no-op repairs when the repair stage regenerates the same reference artifact hash/source after a validation failure

This prevents a class of doomed validate → repair → validate timeout loops from consuming another full judge cycle.

Execution diagnostics are persisted separately from slot-stage transitions:

- `generation_execution_attempts` stores compile / test / quality-gate attempts plus timeout-stage metadata and bounded stdout/stderr evidence
- `generation_slot_diagnoses` stores structured diagnoses and recommended repair strategies
- `generation_run_failure_cache` stores run-scoped normalized failure patterns and injected guardrails for later slots

## Current Migration Notes

- Existing `runs` and `run_events` remain for diagnostics and replay compatibility.
- `generation_runs`, `generation_slot_runs`, and `generation_slot_transitions` are now the execution source of truth.
- `PARTIAL_SUCCESS` remains a compatibility read path in some surfaces, but new writes use `INCOMPLETE`.
- Older targeted slot-regeneration strategy names are rejected explicitly until stage-targeted slot resume is implemented against the new persistent model.
