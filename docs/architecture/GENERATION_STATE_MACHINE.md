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
- `PARTIAL_SUCCESS`
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
- `PARTIAL_SUCCESS`
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
- `SKELETON_RUNNING`
- `TESTS_RUNNING`
- `REFERENCE_RUNNING`
- `VALIDATING_REFERENCE`
- `REPAIRING_REFERENCE`
- `VALIDATING_REPAIR`
- `SUCCEEDED`
- `RETRYABLE_FAILURE`
- `HARD_FAILURE`
- `SKIPPED`

Source of truth:

- `generation_slot_runs`
- `generation_slot_transitions`

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
7. Each slot advances independently through stage states and emits durable transition rows.
8. After all slots finish, run status is derived from slot terminal outcomes.
9. Thread status is derived from run status.

### Terminal Run Derivation

- All slots `SUCCEEDED` -> `COMPLETED`
- Mix of `SUCCEEDED` and failures/skips -> `PARTIAL_SUCCESS`
- No success, only retryable failures/skips -> `RETRYABLE_FAILURE`
- No success, only hard failures -> `HARD_FAILURE`

## Failure Isolation

- Slot failure does not throw across the entire thread boundary.
- The orchestrator records slot terminal state and continues remaining slots.
- Thread outcome is derived after all slot results are known.

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

- `COMPILE_ERROR`
- `TEST_FAILURE`
- `EXEC_TIMEOUT`
- `OUTPUT_LIMIT`
- `INFRA_ERROR`

Judge containers are launched with:

- networking disabled
- read-only filesystem
- unprivileged container user
- bounded tmpfs
- CPU / memory / PID limits
- explicit container cleanup on forced termination

Java judging now compiles into `/tmp/classes` so `/workspace` can remain read-only.

Before Docker validation, staged generation also performs a fast Java preflight for structural-topic slots:

- reject `stdin`-driven reference solutions for structural OOP topics
- assert structural-topic requirements (`encapsulation`, `inheritance`, `polymorphism`, etc.) against the generated reference + test suite
- short-circuit no-op repairs when the repair stage regenerates the same reference artifact hash/source after a validation failure

This prevents a class of doomed validate → repair → validate timeout loops from consuming another full judge cycle.

## Current Migration Notes

- Existing `runs` and `run_events` remain for diagnostics and replay compatibility.
- `generation_runs`, `generation_slot_runs`, and `generation_slot_transitions` are now the execution source of truth.
- Older targeted slot-regeneration strategy names are rejected explicitly until stage-targeted slot resume is implemented against the new persistent model.
