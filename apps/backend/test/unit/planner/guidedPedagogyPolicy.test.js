require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildGuidedPedagogyPolicy } = require("../../../src/planner/pedagogy");

test("guided pedagogy policy: scaffold depends on mastery", () => {
  const spec = {
    version: "1.0",
    language: "java",
    problem_count: 4,
    difficulty_plan: [
      { difficulty: "easy", count: 3 },
      { difficulty: "medium", count: 1 },
    ],
    topic_tags: ["graph theory"],
    problem_style: "return",
    constraints: "Use Java 17. You must not use package declarations. Use JUnit 5. Do not use randomness.",
    test_case_count: 8,
  };

  const low = buildGuidedPedagogyPolicy({
    spec,
    masterySnapshot: {
      language: "java",
      concept_mastery: { "graph theory": 0.1 },
      taken_at: new Date().toISOString(),
    },
  });

  const high = buildGuidedPedagogyPolicy({
    spec,
    masterySnapshot: {
      language: "java",
      concept_mastery: { "graph theory": 0.95 },
      taken_at: new Date().toISOString(),
    },
  });

  assert.equal(low.mode, "guided");
  assert.equal(high.mode, "guided");
  assert.ok(Array.isArray(low.scaffold_curve));
  assert.ok(Array.isArray(high.scaffold_curve));
  assert.deepEqual(low.scaffold_curve, [80, 60, 30, 10]);
  assert.deepEqual(high.scaffold_curve, [80, 60, 30, 10]);
  assert.notEqual(low.hints_enabled, high.hints_enabled);
});
