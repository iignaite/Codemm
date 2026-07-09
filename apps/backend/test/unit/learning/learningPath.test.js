require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildLearningPath, MASTERED_THRESHOLD } = require("../../../src/learning/learningPath");

const AT = "2026-07-09T00:00:00.000Z";

function concept(name, mastery, attempts, passes = 0) {
  return {
    language: "java",
    concept: name,
    mastery,
    attempts,
    passes,
    last_attempt_at: attempts > 0 ? AT : null,
    updated_at: AT,
  };
}

test("learning path: empty mastery yields an empty path", () => {
  const path = buildLearningPath({ language: "java", concepts: [], builtAt: AT });
  assert.equal(path.totalCount, 0);
  assert.equal(path.masteredCount, 0);
  assert.equal(path.overallMastery, 0);
  assert.equal(path.recommendedConcept, null);
  assert.deepEqual(path.modules, []);
});

test("learning path: orders in-progress weakest-first, then not-started, then mastered", () => {
  const path = buildLearningPath({
    language: "java",
    concepts: [
      concept("mastered-topic", 0.95, 10, 10),
      concept("not-started-topic", 0.5, 0, 0),
      concept("strong-progress", 0.7, 5, 3),
      concept("weak-progress", 0.2, 3, 1),
    ],
    builtAt: AT,
  });

  assert.deepEqual(
    path.modules.map((m) => m.concept),
    ["weak-progress", "strong-progress", "not-started-topic", "mastered-topic"]
  );
  assert.deepEqual(
    path.modules.map((m) => m.status),
    ["in_progress", "in_progress", "not_started", "mastered"]
  );
});

test("learning path: recommends the weakest non-mastered concept", () => {
  const path = buildLearningPath({
    language: "java",
    concepts: [
      concept("arrays", 0.9, 8, 7),
      concept("recursion", 0.3, 4, 1),
      concept("graphs", 0.6, 5, 3),
    ],
    builtAt: AT,
  });

  assert.equal(path.recommendedConcept, "recursion");
  assert.equal(path.modules.find((m) => m.concept === "recursion").recommended, true);
  assert.equal(path.modules.filter((m) => m.recommended).length, 1);
});

test("learning path: recommends a not-started concept when nothing is in progress", () => {
  const path = buildLearningPath({
    language: "java",
    concepts: [concept("arrays", 0.95, 10, 10), concept("trees", 0.5, 0, 0)],
    builtAt: AT,
  });
  assert.equal(path.recommendedConcept, "trees");
});

test("learning path: no recommendation once every concept is mastered", () => {
  const path = buildLearningPath({
    language: "java",
    concepts: [concept("arrays", 0.9, 10, 10), concept("loops", MASTERED_THRESHOLD, 8, 8)],
    builtAt: AT,
  });
  assert.equal(path.recommendedConcept, null);
  assert.equal(path.masteredCount, 2);
  assert.equal(path.totalCount, 2);
});

test("learning path: overall mastery is the mean across concepts", () => {
  const path = buildLearningPath({
    language: "java",
    concepts: [concept("a", 0.2, 1, 0), concept("b", 0.8, 3, 2)],
    builtAt: AT,
  });
  assert.ok(Math.abs(path.overallMastery - 0.5) < 1e-12);
});

test("learning path: ordering is stable across rebuilds", () => {
  const concepts = [concept("b", 0.4, 2, 1), concept("a", 0.4, 2, 1), concept("c", 0.4, 2, 1)];
  const first = buildLearningPath({ language: "java", concepts, builtAt: AT });
  const second = buildLearningPath({ language: "java", concepts: [...concepts].reverse(), builtAt: AT });
  assert.deepEqual(
    first.modules.map((m) => m.concept),
    second.modules.map((m) => m.concept)
  );
  // Equal mastery + status → alphabetical.
  assert.deepEqual(first.modules.map((m) => m.concept), ["a", "b", "c"]);
});
