require("../../helpers/setupDb");

const test = require("node:test");
const assert = require("node:assert/strict");

const { learnerProfileDb, conceptMasteryDb } = require("../../../src/database");

test("learnerProfileDb: singleton profile is created on first read", () => {
  const first = learnerProfileDb.get();
  assert.equal(first.goal, null);
  assert.equal(first.preferred_style, null);
  assert.ok(first.created_at);

  const second = learnerProfileDb.get();
  assert.equal(second.created_at, first.created_at);
});

test("learnerProfileDb: update patches goal and style", () => {
  const updated = learnerProfileDb.update({ goal: "pass my Java final", preferred_style: "guided" });
  assert.equal(updated.goal, "pass my Java final");
  assert.equal(updated.preferred_style, "guided");

  const cleared = learnerProfileDb.update({ goal: null });
  assert.equal(cleared.goal, null);
  assert.equal(cleared.preferred_style, "guided");
});

test("conceptMasteryDb: upsert/get/list/snapshot roundtrip", () => {
  const now = new Date().toISOString();
  conceptMasteryDb.upsert({
    language: "java",
    concept: "recursion",
    mastery: 0.4,
    attempts: 2,
    passes: 1,
    last_attempt_at: now,
    updated_at: now,
  });

  const found = conceptMasteryDb.get("java", "recursion");
  assert.ok(found);
  assert.equal(found.mastery, 0.4);
  assert.equal(found.attempts, 2);

  conceptMasteryDb.upsert({ ...found, mastery: 0.55, attempts: 3, passes: 2 });
  const updated = conceptMasteryDb.get("java", "recursion");
  assert.equal(updated.mastery, 0.55);
  assert.equal(updated.attempts, 3);

  conceptMasteryDb.upsert({
    language: "java",
    concept: "arrays",
    mastery: 0.9,
    attempts: 5,
    passes: 5,
    last_attempt_at: now,
    updated_at: now,
  });

  const list = conceptMasteryDb.listByLanguage("java");
  assert.ok(list.length >= 2);

  const snapshot = conceptMasteryDb.snapshot("java");
  assert.equal(snapshot.language, "java");
  assert.equal(snapshot.concept_mastery["recursion"], 0.55);
  assert.equal(snapshot.concept_mastery["arrays"], 0.9);

  const pythonSnapshot = conceptMasteryDb.snapshot("python");
  assert.deepEqual(pythonSnapshot.concept_mastery, {});
});
