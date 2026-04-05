require("../../../helpers/setupDb");
const { installGenerationStub } = require("../../../helpers/installGenerationStub");

const test = require("node:test");
const assert = require("node:assert/strict");

const { activityDb } = require("../../../../src/database");
const { createSession, processSessionMessage, generateFromSession, getSession } = require("../../../../src/services/sessionService");

function installStubs(t, language) {
  function parseRequestedCountAndTopic(msg) {
    const m = String(msg || "");
    const lower = m.toLowerCase();
    const countMatch = lower.match(/\b(\d+)\s+(?:problems?|questions?)\b/);
    const count = countMatch ? Number(countMatch[1]) : 1;
    const topicsMatch = m.match(/\btopics?\s*:\s*([A-Za-z0-9 _-]+)/i);
    const topic = topicsMatch?.[1]?.trim().split(/[,\n]/)[0]?.trim() || "filtering";
    return { count, topic };
  }

  function buildDialogueResponse(latestUserMessage) {
    const { count, topic } = parseRequestedCountAndTopic(latestUserMessage);
    return {
      acknowledgement: "OK",
      inferred_intent: "Generate an activity.",
      proposedPatch: {
        language,
        problem_count: count,
        difficulty_plan: [{ difficulty: "easy", count }],
        topic_tags: [topic],
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
      id: `sql-e2e-${slotIndex}`,
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

  return installGenerationStub(t, {
    language,
    buildDialogueResponse,
    buildDraft: sqlDraft,
    judgeResult: { success: false, passedTests: [], failedTests: ["baseline"] },
  });
}

test("e2e activity generation (sql): 2/4/7 problems (stdout-only)", async (t) => {
  const { calls } = installStubs(t, "sql");

  const counts = [2, 4, 7];

  for (const problem_count of counts) {
    await t.test(`count=${problem_count}`, async () => {
      calls.length = 0;

      const { sessionId } = createSession("practice");
      const prompt = `Create ${problem_count} easy problems in SQL. Topics: filtering`;

      const msgRes = await processSessionMessage(sessionId, prompt);
      assert.equal(msgRes.accepted, true);
      assert.equal(msgRes.done, true);
      assert.equal(msgRes.state, "READY");
      assert.equal(msgRes.spec.language, "sql");
      assert.equal(msgRes.spec.problem_count, problem_count);
      assert.equal(msgRes.spec.problem_style, "stdout");

      const genRes = await generateFromSession(sessionId);
      assert.ok(genRes.activityId);
      assert.equal(genRes.problems.length, problem_count);
      for (const p of genRes.problems) {
        assert.equal(p.language, "sql");
        assert.equal("reference_solution" in p, false);
      }

      const stored = activityDb.findById(genRes.activityId);
      assert.ok(stored);
      const storedProblems = JSON.parse(stored.problems);
      assert.equal(storedProblems.length, problem_count);

      const session = getSession(sessionId);
      assert.equal(session.state, "SAVED");
    });
  }
});
