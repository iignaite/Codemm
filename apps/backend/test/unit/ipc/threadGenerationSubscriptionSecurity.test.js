require("../../helpers/setupDb");

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { createThreadHandlers } = require("../../../src/ipc/threads");
const { createThread } = require("../../../src/services/sessionService");
const { runRepository } = require("../../../src/database/repositories/runRepository");

test("threads.subscribeGeneration rejects runIds that belong to a different thread", async () => {
  const handlers = createThreadHandlers({ sendEvent: () => {} });
  const subscribe = handlers["threads.subscribeGeneration"].handler;

  const threadA = createThread("practice");
  const threadB = createThread("practice");
  const otherRunId = crypto.randomUUID();
  runRepository.create(otherRunId, "generation", { threadId: threadB.sessionId, metaJson: "{}" });

  await assert.rejects(
    () => subscribe({ threadId: threadA.sessionId, runId: otherRunId }),
    /runId does not belong to the provided threadId/i
  );
});

test("threads.subscribeGeneration accepts runIds owned by the requested thread", async () => {
  const handlers = createThreadHandlers({ sendEvent: () => {} });
  const subscribe = handlers["threads.subscribeGeneration"].handler;
  const unsubscribe = handlers["threads.unsubscribeGeneration"].handler;

  const thread = createThread("practice");
  const runId = crypto.randomUUID();
  runRepository.create(runId, "generation", { threadId: thread.sessionId, metaJson: "{}" });

  const result = await subscribe({ threadId: thread.sessionId, runId });
  assert.equal(result.runId, runId);
  assert.ok(typeof result.subId === "string" && result.subId.length > 0);

  await unsubscribe({ subId: result.subId });
});
