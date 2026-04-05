require("../../helpers/setupDb");
const { installGenerationStub } = require("../../helpers/installGenerationStub");

const test = require("node:test");
const assert = require("node:assert/strict");

const { createSession, processSessionMessage, generateFromSession, getSession } = require("../../../src/services/sessionService");

function installStubs(t) {
  function parseRequestedCountAndStyle(msg) {
    const m = String(msg || "");
    const lower = m.toLowerCase();
    const countMatch = lower.match(/\b(\d+)\s+(?:problems?|questions?)\b/);
    const count = countMatch ? Number(countMatch[1]) : 1;
    // SQL supports only stdout style in v1.
    const style = "stdout";
    const topicsMatch = m.match(/\btopics?\s*:\s*([A-Za-z0-9 _-]+)/i);
    const topic = topicsMatch?.[1]?.trim().split(/[,\n]/)[0]?.trim() || "filtering";
    return { count, style, topic };
  }

  function buildDialogueResponse(latestUserMessage) {
    const { count, style, topic } = parseRequestedCountAndStyle(latestUserMessage);
    return {
      acknowledgement: "OK",
      inferred_intent: "Generate an activity.",
      proposedPatch: {
        language: "sql",
        problem_count: count,
        difficulty_plan: [{ difficulty: "easy", count }],
        topic_tags: [topic],
        problem_style: style,
      },
    };
  }

  function sqlDraft(slotIndex) {
    const suite = {
      schema_sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER);",
      cases: Array.from({ length: 8 }, (_, i) => ({
        name: `test_case_${i + 1}`,
        seed_sql: `INSERT INTO t (id, v) VALUES (${i + 1}, ${i});`,
        expected: { columns: ["v"], rows: [[i]] },
        order_matters: true,
      })),
    };

    return {
      id: `sql-e2e-edge-${slotIndex}`,
      title: `Select V ${slotIndex}`,
      description: "Return v for id=1.",
      starter_code: "SELECT v FROM t WHERE id = 1 ORDER BY v;",
      reference_solution: "SELECT v FROM t WHERE id = 1 ORDER BY v;",
      test_suite: JSON.stringify(suite),
      constraints: "SQLite 3 (SQL dialect), read-only queries only, deterministic results (explicit ORDER BY when needed).",
      sample_inputs: ["t rows: (id=1,v=0)"],
      sample_outputs: ["v\\n0"],
      difficulty: "easy",
      topic_tag: "filtering",
    };
  }

  installGenerationStub(t, {
    language: "sql",
    buildDialogueResponse,
    buildDraft: sqlDraft,
    judgeResult: { success: false, passedTests: [], failedTests: ["baseline"] },
  });
}

test("e2e edge: missing difficulty requires confirmation, then 'yes' applies pending patch", async (t) => {
  installStubs(t);

  const { sessionId } = createSession("practice");

  const msg1 = await processSessionMessage(sessionId, "Create 4 problems in SQL with stdout style. Topics: filtering");
  assert.equal(msg1.accepted, true);
  assert.equal(msg1.done, false);
  assert.equal(msg1.state, "CLARIFYING");
  assert.equal(msg1.next_action, "ask");
  assert.equal(msg1.questionKey, "difficulty_plan");

  const msg2 = await processSessionMessage(sessionId, "easy");
  assert.equal(msg2.accepted, true);
  assert.equal(msg2.done, true);
  assert.equal(msg2.state, "READY");

  const gen = await generateFromSession(sessionId);
  assert.equal(gen.problems.length, 4);

  const s = getSession(sessionId);
  assert.equal(s.state, "SAVED");
});

test("e2e edge: problem_count > 7 (without difficulty) does not complete the spec", async (t) => {
  installStubs(t);

  const { sessionId } = createSession("practice");

  const msg = await processSessionMessage(sessionId, "Create 8 problems in SQL with stdout style. Topics: filtering");
  assert.equal(msg.accepted, true);
  assert.equal(msg.done, false);
  assert.equal(msg.state, "CLARIFYING");
  assert.equal(msg.questionKey, "problem_count");
});

test("e2e edge: problem_count > 7 with difficulty shorthand clamps to 7", async (t) => {
  installStubs(t);

  const { sessionId } = createSession("practice");

  const msg = await processSessionMessage(sessionId, "Create 8 easy problems in SQL with stdout style. Topics: filtering");
  assert.equal(msg.accepted, true);
  assert.equal(msg.done, true);
  assert.equal(msg.state, "READY");
  assert.equal(msg.spec.problem_count, 7);

  const gen = await generateFromSession(sessionId);
  assert.equal(gen.problems.length, 7);

  const s = getSession(sessionId);
  assert.equal(s.state, "SAVED");
});
