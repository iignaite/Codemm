require("../../helpers/setupDb");

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { threadRepository } = require("../../../src/database/repositories/threadRepository");
const {
  generationRunRepository,
  generationSlotRunRepository,
} = require("../../../src/database/repositories/generationRunRepository");
const { reconcileInterruptedGenerationState } = require("../../../src/services/threads/generationRecoveryService");

test("reconcileInterruptedGenerationState finalizes stale generation runs and repairs stuck thread state", () => {
  const threadId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  threadRepository.create(
    threadId,
    "GENERATING",
    "practice",
    JSON.stringify({
      language: "java",
      topic_tags: ["arrays"],
      problem_count: 2,
      difficulty_plan: { easy: 2, medium: 0, hard: 0 },
      problem_style: "return",
    })
  );

  generationRunRepository.create({
    id: runId,
    threadId,
    totalSlots: 2,
    metaJson: JSON.stringify({ threadId }),
  });
  generationRunRepository.markRunning(runId);
  generationSlotRunRepository.seed(runId, [
    { slotIndex: 0, topic: "arrays", language: "java" },
    { slotIndex: 1, topic: "strings", language: "java" },
  ]);
  generationSlotRunRepository.markTerminal({
    runId,
    slotIndex: 0,
    status: "SUCCEEDED",
    attemptCount: 1,
  });
  generationSlotRunRepository.updateStage({
    runId,
    slotIndex: 1,
    status: "REFERENCE_RUNNING",
    currentStage: "REFERENCE_RUNNING",
    attemptCount: 1,
  });

  const result = reconcileInterruptedGenerationState();

  assert.deepEqual(result.reconciledRunIds, [runId]);
  assert.ok(result.updatedThreadIds.includes(threadId));

  const recoveredRun = generationRunRepository.findById(runId);
  assert.equal(recoveredRun.status, "PARTIAL_SUCCESS");
  assert.equal(recoveredRun.successful_slots, 1);
  assert.equal(recoveredRun.failed_slots, 1);
  assert.equal(recoveredRun.last_failure_code, "ENGINE_RESTART");

  const slots = generationSlotRunRepository.listByRun(runId);
  assert.equal(slots[0].status, "SUCCEEDED");
  assert.equal(slots[1].status, "RETRYABLE_FAILURE");

  const thread = threadRepository.findById(threadId);
  assert.equal(thread.state, "PARTIAL_SUCCESS");
  assert.match(String(thread.last_error ?? ""), /interrupted before completion/i);
});
