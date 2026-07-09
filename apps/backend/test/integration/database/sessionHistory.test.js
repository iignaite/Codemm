require("../../helpers/setupDb");

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { threadDb, threadMessageDb } = require("../../../src/database");
const { createThread } = require("../../../src/services/threads");

test("threadDb.listSummaries returns recent threads with message counts", async () => {
  const s1 = createThread("practice");
  threadMessageDb.create(crypto.randomUUID(), s1.sessionId, "user", "first session message");

  await new Promise((r) => setTimeout(r, 1100));

  const s2 = createThread("guided");
  threadMessageDb.create(crypto.randomUUID(), s2.sessionId, "user", "second session message");

  const res = threadDb.listSummaries(50);
  const idx2 = res.findIndex((t) => t.id === s2.sessionId);
  const idx1 = res.findIndex((t) => t.id === s1.sessionId);
  assert.ok(idx2 >= 0, "Expected s2 in summaries");
  assert.ok(idx1 >= 0, "Expected s1 in summaries");
  assert.ok(idx2 < idx1, "Expected s2 to be more recent than s1");

  assert.equal(res[idx2].id, s2.sessionId);
  assert.equal(res[idx2].message_count, 1);
  assert.equal(res[idx2].last_message, "second session message");

  assert.equal(res[idx1].id, s1.sessionId);
  assert.equal(res[idx1].message_count, 1);
  assert.equal(res[idx1].last_message, "first session message");
});
