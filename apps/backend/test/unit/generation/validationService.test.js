require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { inferFailureKind, progressSummaryForFailure } = require("../../../src/generation/services/validationService");

test("validation service: preserves explicit terminal error kinds", () => {
  assert.equal(inferFailureKind({ kind: "timeout", message: "Reference solution timed out" }), "timeout");
  assert.equal(inferFailureKind({ kind: "contract", message: "Repair regenerated the same artifact" }), "contract");
});

test("validation service: slot failure summary keeps timeout terminal errors classified", () => {
  const out = progressSummaryForFailure({
    slotIndex: 0,
    attempt: 1,
    maxAttempts: 1,
    err: { kind: "timeout", stage: "repair", message: "Reference solution timed out" },
    slotIntent: {
      slotIndex: 0,
      language: "java",
      difficulty: "easy",
      topics: ["encapsulation"],
      constraints: "Java 21",
      problemStyle: "stdout",
      testCaseCount: 8,
    },
    final: true,
  });

  assert.equal(out.summary.kind, "timeout");
  assert.equal(out.failure.kind, "timeout");
  assert.equal(out.summary.phase, "generate");
});
