require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { proposeGenerationFallback, proposeGenerationFallbackWithPolicy } = require("../../../src/agent/generationFallback");

test("generation fallback: reduces hard to medium", () => {
  const spec = {
    version: "1.0",
    language: "java",
    problem_count: 3,
    difficulty_plan: [
      { difficulty: "easy", count: 1 },
      { difficulty: "hard", count: 2 },
    ],
    topic_tags: ["arrays"],
    problem_style: "stdout",
    constraints: "Java 17, JUnit 5, no package declarations.",
    test_case_count: 8,
  };

  const d = proposeGenerationFallback(spec);
  assert.ok(d);
  assert.match(d.reason, /reduced hard/i);
  assert.equal(d.patch[0].path, "/difficulty_plan");
  assert.deepEqual(d.patch[0].value, [
    { difficulty: "easy", count: 1 },
    { difficulty: "medium", count: 2 },
  ]);
});

test("generation fallback: preserves explicit hard intent when downgrade is disallowed", () => {
  const spec = {
    version: "1.0",
    language: "java",
    problem_count: 3,
    difficulty_plan: [
      { difficulty: "easy", count: 1 },
      { difficulty: "hard", count: 2 },
    ],
    topic_tags: ["arrays"],
    problem_style: "stdout",
    constraints: "Java 17, JUnit 5, no package declarations.",
    test_case_count: 8,
  };

  const d = proposeGenerationFallbackWithPolicy(spec, { allowDowngradeDifficulty: false, allowNarrowTopics: true });
  // No other fallback steps apply (topics already narrow).
  assert.equal(d, null);
});

test("generation fallback: ladder applies each rung once, then terminates", () => {
  const { applyJsonPatch } = require("../../../src/compiler/jsonPatch");

  let spec = {
    version: "1.0",
    language: "java",
    problem_count: 3,
    difficulty_plan: [
      { difficulty: "easy", count: 1 },
      { difficulty: "hard", count: 2 },
    ],
    topic_tags: ["a", "b", "c", "d", "e"],
    problem_style: "stdout",
    constraints: "Java 17, JUnit 5, no package declarations.",
    test_case_count: 8,
  };

  const reasons = [];
  for (let rung = 0; rung < 10; rung++) {
    const decision = proposeGenerationFallbackWithPolicy(spec, {});
    if (!decision) break;
    reasons.push(decision.reason);
    spec = applyJsonPatch(spec, decision.patch);
  }

  assert.equal(reasons.length, 2, "exactly two rungs fire, then the ladder is exhausted");
  assert.match(reasons[0], /reduced hard/i);
  assert.match(reasons[1], /narrowed topic/i);
  assert.deepEqual(spec.topic_tags, ["a", "b", "c"]);
  assert.ok(spec.difficulty_plan.every((d) => d.difficulty !== "hard"));
  assert.equal(proposeGenerationFallbackWithPolicy(spec, {}), null, "no further rungs — the retry loop terminates");
});

test("generation fallback: narrows topic scope when many tags", () => {
  const spec = {
    version: "1.0",
    language: "java",
    problem_count: 3,
    difficulty_plan: [
      { difficulty: "easy", count: 2 },
      { difficulty: "medium", count: 1 },
    ],
    topic_tags: ["a", "b", "c", "d", "e"],
    problem_style: "stdout",
    constraints: "Java 17, JUnit 5, no package declarations.",
    test_case_count: 8,
  };

  const d = proposeGenerationFallback(spec);
  assert.ok(d);
  assert.match(d.reason, /narrowed topic/i);
  assert.deepEqual(d.patch, [{ op: "replace", path: "/topic_tags", value: ["a", "b", "c"] }]);
});
