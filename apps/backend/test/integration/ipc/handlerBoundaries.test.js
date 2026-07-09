require("../../helpers/setupDb");

const test = require("node:test");
const assert = require("node:assert/strict");

const { validateOrThrow } = require("../../../src/ipc/common");
const { createJudgeHandlers } = require("../../../src/ipc/judge");
const { createThreadHandlers } = require("../../../src/ipc/threads");
const { createActivityHandlers } = require("../../../src/ipc/activities");
const { createLearningHandlers } = require("../../../src/ipc/learning");

// Mirrors the dispatch in ipcServer.ts: schema validation, then the handler.
async function dispatch(def, params) {
  const validated = def.schema ? validateOrThrow(def.schema, params) : params;
  return def.handler(validated);
}

const judge = createJudgeHandlers();
const threads = createThreadHandlers({ sendEvent: () => {} });
const activities = createActivityHandlers();
const learning = createLearningHandlers();

test("ipc boundary: judge.run rejects malformed requests before any execution", async () => {
  const cases = [
    { name: "code and files together", params: { language: "python", code: "x", files: { "main.py": "x" } } },
    { name: "neither code nor files", params: { language: "python" } },
    { name: "unknown language", params: { language: "cobol", code: "print(1)" } },
    { name: "oversized code", params: { language: "python", code: "x".repeat(200_001) } },
    { name: "oversized stdin", params: { language: "python", code: "print(1)", stdin: "y".repeat(50_001) } },
    { name: "empty files object", params: { language: "python", files: {} } },
    { name: "invalid filename", params: { language: "python", files: { "../evil.py": "x" } } },
    { name: "sql has no /run", params: { language: "sql", files: { "solution.sql": "SELECT 1;" } } },
  ];
  for (const { name, params } of cases) {
    await assert.rejects(dispatch(judge["judge.run"], params), undefined, name);
  }
});

test("ipc boundary: judge.submit rejects malformed requests before any execution", async () => {
  const cases = [
    { name: "missing testSuite", params: { language: "python", code: "x" } },
    { name: "oversized testSuite", params: { language: "python", code: "x", testSuite: "t".repeat(200_001) } },
    { name: "reserved python test filename", params: { language: "python", testSuite: "t", files: { "solution.py": "x", "test_solution.py": "boom" } } },
    { name: "python without solution.py", params: { language: "python", testSuite: "t", files: { "helper.py": "x" } } },
    { name: "sql with extra files", params: { language: "sql", testSuite: "t", files: { "solution.sql": "SELECT 1;", "extra_file.sql": "x" } } },
  ];
  for (const { name, params } of cases) {
    await assert.rejects(dispatch(judge["judge.submit"], params), undefined, name);
  }
});

test("ipc boundary: threads schema limits and unknown ids", async () => {
  await assert.rejects(dispatch(threads["threads.get"], {}), /threadId|Required|invalid/i);
  await assert.rejects(dispatch(threads["threads.get"], { threadId: "does-not-exist" }));
  await assert.rejects(dispatch(threads["threads.postMessage"], { threadId: "t", message: "" }));
  await assert.rejects(dispatch(threads["threads.postMessage"], { threadId: "t", message: "x".repeat(50_001) }));
  await assert.rejects(dispatch(threads["threads.setInstructions"], { threadId: "t", instructions_md: "x".repeat(8_001) }));
  await assert.rejects(dispatch(threads["threads.generate"], { threadId: "" }));
});

test("ipc boundary: threads.create/get roundtrip works through the dispatch path", async () => {
  const created = await dispatch(threads["threads.create"], { learning_mode: "guided" });
  assert.ok(created.threadId);
  assert.equal(created.learning_mode, "guided");

  const detail = await dispatch(threads["threads.get"], { threadId: created.threadId });
  assert.equal(detail.threadId, created.threadId);
  assert.equal(detail.state, "DRAFT");
  assert.ok(Array.isArray(detail.messages));
});

test("ipc boundary: activities schema limits and unknown ids", async () => {
  await assert.rejects(dispatch(activities["activities.get"], {}));
  await assert.rejects(dispatch(activities["activities.get"], { id: "missing-activity" }), /not found/i);
  await assert.rejects(dispatch(activities["activities.list"], { limit: 201 }));
  const listed = await dispatch(activities["activities.list"], { limit: 5 });
  assert.ok(Array.isArray(listed.activities));
});

test("ipc boundary: learning handlers validate and roundtrip", async () => {
  await assert.rejects(dispatch(learning["learning.getMastery"], { language: "cobol" }));
  await assert.rejects(dispatch(learning["learning.updateProfile"], { preferredStyle: "chaotic" }));

  const updated = await dispatch(learning["learning.updateProfile"], { goal: "learn java", preferredStyle: "guided" });
  assert.equal(updated.profile.goal, "learn java");

  const mastery = await dispatch(learning["learning.getMastery"], { language: "java" });
  assert.equal(mastery.language, "java");
  assert.ok(Array.isArray(mastery.concepts));
});
