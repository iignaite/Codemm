require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { runDialogueTurn } = require("../../../src/services/dialogueService");

// These messages are fully handled by the deterministic extractor, so no LLM
// is contacted regardless of environment configuration.
function turn(latestUserMessage) {
  return runDialogueTurn({
    sessionState: "CLARIFYING",
    currentSpec: {},
    conversationHistory: [],
    latestUserMessage,
  });
}

test("dialogue parse: structured multi-line message captures topics (regression)", async () => {
  const out = await turn("Language: python\nStyle: stdout\nTopics: strings\nDifficulty: easy:2");
  assert.equal(out.parseSource, "deterministic");
  assert.equal(out.proposedPatch.language, "python");
  assert.deepEqual(out.proposedPatch.topic_tags, ["strings"]);
});

test("dialogue parse: structured topics list splits into tags", async () => {
  const out = await turn("Language: java\nTopics: arrays, linked lists, recursion");
  assert.deepEqual(out.proposedPatch.topic_tags, ["arrays", "linked lists", "recursion"]);
});

test("dialogue parse: bare comma list answers the topics question", async () => {
  const out = await turn("graphs, dynamic programming");
  assert.deepEqual(out.proposedPatch.topic_tags, ["graphs", "dynamic programming"]);
});

test("dialogue parse: sentences with other captured fields do not produce junk tags", async () => {
  const out = await turn("I want to practice recursion in Java. 3 problems: 2 easy, 1 medium.");
  assert.equal(out.proposedPatch.language, "java");
  assert.equal(out.proposedPatch.problem_count, 3);
  assert.equal("topic_tags" in out.proposedPatch, false, "no comma-split junk from prose");
});
