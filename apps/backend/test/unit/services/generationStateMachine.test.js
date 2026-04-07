require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { deriveRunStatus, mapRunStatusToThreadState } = require("../../../src/services/threads/generationState");
const {
  subscribeGenerationProgress,
  publishGenerationProgress,
  getGenerationProgressBuffer,
} = require("../../../src/generation/progressBus");
const {
  buildJudgeResult,
  COMPILE_TIMEOUT_MARKER,
  EXEC_TIMEOUT_MARKER,
} = require("../../../src/judge/outcome");

test("deriveRunStatus maps mixed slot outcomes to incomplete", () => {
  const status = deriveRunStatus([
    {
      slotIndex: 0,
      terminalStatus: "SUCCEEDED",
      retries: 0,
      problem: { id: "p1" },
      outcome: { slotIndex: 0, success: true, status: "SUCCEEDED", retries: 0 },
    },
    {
      slotIndex: 1,
      terminalStatus: "RETRYABLE_FAILURE",
      retries: 1,
      outcome: {
        slotIndex: 1,
        success: false,
        status: "RETRYABLE_FAILURE",
        retries: 1,
        failureKind: "timeout",
        failureCode: "TIME_BUDGET_EXCEEDED",
        message: "Reference execution timed out.",
      },
      failure: {
        kind: "timeout",
        code: "TIME_BUDGET_EXCEEDED",
        message: "Reference execution timed out.",
        stage: "VALIDATING_REFERENCE",
      },
    },
  ]);

  assert.equal(status, "INCOMPLETE");
  assert.equal(mapRunStatusToThreadState(status), "INCOMPLETE");
});

test("progress bus isolates buffered and live events by runId", () => {
  const seenRun1 = [];
  const seenRun2 = [];
  const off1 = subscribeGenerationProgress("run-1", (event) => seenRun1.push(event));
  const off2 = subscribeGenerationProgress("run-2", (event) => seenRun2.push(event));

  publishGenerationProgress("run-1", { type: "generation_started", runId: "run-1", totalSlots: 2, run: 1 });
  publishGenerationProgress("run-2", { type: "generation_started", runId: "run-2", totalSlots: 1, run: 1 });
  publishGenerationProgress("run-1", { type: "generation_failed", runId: "run-1", error: "boom" });

  assert.equal(seenRun1.length, 2);
  assert.equal(seenRun2.length, 1);
  assert.equal(getGenerationProgressBuffer("run-1").length, 2);
  assert.equal(getGenerationProgressBuffer("run-2").length, 1);

  off1();
  off2();
});

test("judge outcome preserves timeout stage and strips internal timeout markers", () => {
  const compileTimeout = buildJudgeResult({
    success: false,
    passedTests: [],
    failedTests: [],
    executionTimeMs: 1234,
    capture: {
      stdout: "",
      stderr: `${COMPILE_TIMEOUT_MARKER}\ncompiler stalled`,
      exitCode: 124,
      timedOut: false,
      outputLimitExceeded: false,
    },
  });

  assert.equal(compileTimeout.failureCategory, "TIME_BUDGET_EXCEEDED");
  assert.equal(compileTimeout.timeoutStage, "compile");
  assert.equal(compileTimeout.watchdogSource, "inner");
  assert.ok(!compileTimeout.stderr.includes(COMPILE_TIMEOUT_MARKER));

  const execTimeout = buildJudgeResult({
    success: false,
    passedTests: [],
    failedTests: [],
    executionTimeMs: 2500,
    capture: {
      stdout: "",
      stderr: `${EXEC_TIMEOUT_MARKER}\nprogram stalled`,
      exitCode: 124,
      timedOut: false,
      outputLimitExceeded: false,
    },
  });

  assert.equal(execTimeout.failureCategory, "TIME_BUDGET_EXCEEDED");
  assert.equal(execTimeout.timeoutStage, "execute");
  assert.equal(execTimeout.watchdogSource, "inner");
  assert.ok(!execTimeout.stderr.includes(EXEC_TIMEOUT_MARKER));
});
