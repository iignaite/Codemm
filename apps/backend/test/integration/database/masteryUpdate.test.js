require("../../helpers/setupDb");

const test = require("node:test");
const assert = require("node:assert/strict");

const { conceptMasteryDb } = require("../../../src/database");
const { recordAttemptMastery } = require("../../../src/learning/masteryService");
const { MASTERY_PRIOR, MASTERY_LEARNING_RATE } = require("../../../src/learning/mastery");

const AT = "2026-07-09T00:00:00.000Z";

const problemsJson = JSON.stringify([
  { id: "p1", language: "python", topic_tag: "Recursion", title: "t", description: "d", constraints: "c" },
  { id: "p2", topic_tag: "Loops", title: "t", description: "d", constraints: "c" },
  { id: "p3", title: "no tag" },
]);

test("recordAttemptMastery: persists normalized concept mastery from a judged submission", () => {
  recordAttemptMastery({
    activityProblemsJson: problemsJson,
    problemId: "p1",
    fallbackLanguage: "java",
    evidence: { passed: true, passedTests: 8, totalTests: 8, at: AT },
  });

  const record = conceptMasteryDb.get("python", "recursion");
  assert.ok(record, "uses the problem's own language, not the fallback");
  assert.equal(record.attempts, 1);
  assert.equal(record.passes, 1);
  assert.equal(record.mastery, MASTERY_PRIOR + MASTERY_LEARNING_RATE * (1 - MASTERY_PRIOR));
  assert.equal(conceptMasteryDb.get("java", "recursion"), undefined);
});

test("recordAttemptMastery: falls back to the submission language when the problem has none", () => {
  recordAttemptMastery({
    activityProblemsJson: problemsJson,
    problemId: "p2",
    fallbackLanguage: "java",
    evidence: { passed: false, passedTests: 2, totalTests: 8, at: AT },
  });

  const record = conceptMasteryDb.get("java", "loops");
  assert.ok(record);
  assert.equal(record.attempts, 1);
  assert.equal(record.passes, 0);
  assert.ok(record.mastery < MASTERY_PRIOR);
});

test("recordAttemptMastery: skips quietly on malformed data without touching mastery", () => {
  recordAttemptMastery({
    activityProblemsJson: "not json",
    problemId: "p1",
    fallbackLanguage: "java",
    evidence: { passed: true, passedTests: 1, totalTests: 1, at: AT },
  });
  recordAttemptMastery({
    activityProblemsJson: problemsJson,
    problemId: "missing",
    fallbackLanguage: "java",
    evidence: { passed: true, passedTests: 1, totalTests: 1, at: AT },
  });
  recordAttemptMastery({
    activityProblemsJson: problemsJson,
    problemId: "p3",
    fallbackLanguage: "java",
    evidence: { passed: true, passedTests: 1, totalTests: 1, at: AT },
  });

  const python = conceptMasteryDb.listByLanguage("python");
  const java = conceptMasteryDb.listByLanguage("java");
  assert.equal(python.length + java.length, 2, "only the two valid attempts exist");
});

test("recordAttemptMastery: repeated attempts accumulate on one record", () => {
  recordAttemptMastery({
    activityProblemsJson: problemsJson,
    problemId: "p1",
    fallbackLanguage: "java",
    evidence: { passed: true, passedTests: 8, totalTests: 8, at: AT },
  });

  const record = conceptMasteryDb.get("python", "recursion");
  assert.equal(record.attempts, 2);
  assert.equal(record.passes, 2);
});
