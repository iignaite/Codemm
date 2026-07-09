require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MASTERY_PRIOR,
  MASTERY_LEARNING_RATE,
  applyAttemptEvidence,
  attemptScore,
  masteryLevelFor,
  normalizeConceptKey,
} = require("../../../src/learning/mastery");

const AT = "2026-07-09T00:00:00.000Z";

function evidence(passedTests, totalTests) {
  return { passed: passedTests === totalTests && totalTests > 0, passedTests, totalTests, at: AT };
}

test("mastery: first attempt starts from the neutral prior", () => {
  const next = applyAttemptEvidence(undefined, {
    language: "java",
    concept: "Recursion",
    evidence: evidence(8, 8),
  });
  assert.equal(next.concept, "recursion");
  assert.equal(next.attempts, 1);
  assert.equal(next.passes, 1);
  assert.equal(next.mastery, MASTERY_PRIOR + MASTERY_LEARNING_RATE * (1 - MASTERY_PRIOR));
});

test("mastery: failing attempt lowers mastery, partial pass moves toward ratio", () => {
  const prev = applyAttemptEvidence(undefined, { language: "java", concept: "loops", evidence: evidence(8, 8) });

  const failed = applyAttemptEvidence(prev, { language: "java", concept: "loops", evidence: evidence(0, 8) });
  assert.ok(failed.mastery < prev.mastery);
  assert.equal(failed.attempts, 2);
  assert.equal(failed.passes, 1);

  const partial = applyAttemptEvidence(failed, { language: "java", concept: "loops", evidence: evidence(4, 8) });
  const expected = failed.mastery + MASTERY_LEARNING_RATE * (0.5 - failed.mastery);
  assert.ok(Math.abs(partial.mastery - expected) < 1e-12);
});

test("mastery: progression is monotone and bounded under repeated passes/failures", () => {
  let record;
  for (let i = 0; i < 50; i++) {
    const next = applyAttemptEvidence(record, { language: "python", concept: "graphs", evidence: evidence(8, 8) });
    if (record) assert.ok(next.mastery >= record.mastery);
    record = next;
  }
  assert.ok(record.mastery > 0.98 && record.mastery <= 1);
  assert.equal(record.attempts, 50);
  assert.equal(record.passes, 50);

  for (let i = 0; i < 50; i++) {
    const next = applyAttemptEvidence(record, { language: "python", concept: "graphs", evidence: evidence(0, 8) });
    assert.ok(next.mastery <= record.mastery);
    record = next;
  }
  assert.ok(record.mastery >= 0 && record.mastery < 0.02);
});

test("mastery: single attempt cannot swing the estimate past the learning rate", () => {
  const prev = {
    language: "java",
    concept: "recursion",
    mastery: 0.9,
    attempts: 10,
    passes: 9,
    last_attempt_at: AT,
    updated_at: AT,
  };
  const next = applyAttemptEvidence(prev, { language: "java", concept: "recursion", evidence: evidence(0, 8) });
  assert.ok(Math.abs(next.mastery - prev.mastery) <= MASTERY_LEARNING_RATE * 0.9 + 1e-12);
});

test("mastery: attemptScore falls back to pass flag when no tests are reported", () => {
  assert.equal(attemptScore({ passed: true, passedTests: 0, totalTests: 0, at: AT }), 1);
  assert.equal(attemptScore({ passed: false, passedTests: 0, totalTests: 0, at: AT }), 0);
});

test("mastery: level thresholds are table-driven", () => {
  assert.equal(masteryLevelFor(0), "novice");
  assert.equal(masteryLevelFor(0.39), "novice");
  assert.equal(masteryLevelFor(0.4), "developing");
  assert.equal(masteryLevelFor(0.6), "proficient");
  assert.equal(masteryLevelFor(0.85), "mastered");
  assert.equal(masteryLevelFor(1), "mastered");
});

test("mastery: concept keys are normalized", () => {
  assert.equal(normalizeConceptKey("  Graph   Theory  "), "graph theory");
  assert.equal(normalizeConceptKey("Recursion"), "recursion");
});
