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
    const topic = topicsMatch?.[1]?.trim().split(/[,\n]/)[0]?.trim() || "arrays";
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

  function javaDraft(slotIndex) {
    return {
      id: `java-e2e-${slotIndex}`,
      title: `Adder ${slotIndex}`,
      description: "Print a + b.",
      starter_code: `
public class Adder {
  public void solve(int a, int b) {
    // TODO
    System.out.println(0);
  }
}
`.trim(),
      reference_solution: `
public class Adder {
  public void solve(int a, int b) {
    System.out.println(a + b);
  }
}
`.trim(),
      test_suite: `
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import java.io.*;

public class AdderTest {
  private String run(int a, int b) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    PrintStream prev = System.out;
    System.setOut(new PrintStream(out));
    try { new Adder().solve(a, b); }
    finally { System.setOut(prev); }
    return out.toString().trim();
  }

  @Test void test_case_1(){ assertEquals("3", run(1,2)); }
  @Test void test_case_2(){ assertEquals("0", run(0,0)); }
  @Test void test_case_3(){ assertEquals("-1", run(-2,1)); }
  @Test void test_case_4(){ assertEquals("7", run(10,-3)); }
  @Test void test_case_5(){ assertEquals("123", run(100,23)); }
  @Test void test_case_6(){ assertEquals("-11", run(-5,-6)); }
  @Test void test_case_7(){ assertEquals("15", run(7,8)); }
  @Test void test_case_8(){ assertEquals("2147483647", run(2147483640, 7)); }
}
`.trim(),
      constraints: "Java 17, JUnit 5, no package declarations.",
      sample_inputs: ["a=1, b=2"],
      sample_outputs: ["3"],
      difficulty: "easy",
      topic_tag: "arrays",
    };
  }

  return installGenerationStub(t, {
    language,
    buildDialogueResponse,
    buildDraft: javaDraft,
    judgeResult: { success: false, passedTests: [], failedTests: ["baseline"] },
  });
}

test("e2e activity generation (java): 2/4/7 problems (stdout-only)", async (t) => {
  const { calls } = installStubs(t, "java");

  const counts = [2, 4, 7];

  for (const problem_count of counts) {
    await t.test(`count=${problem_count} style=stdout`, async () => {
      calls.length = 0;

      const { sessionId } = createSession("practice");
      const prompt = `Create ${problem_count} easy problems in Java. Topics: arrays`;

      const msgRes = await processSessionMessage(sessionId, prompt);
      assert.equal(msgRes.accepted, true);
      assert.equal(msgRes.done, true);
      assert.equal(msgRes.state, "READY");
      assert.equal(msgRes.spec.language, "java");
      assert.equal(msgRes.spec.problem_count, problem_count);
      assert.equal(msgRes.spec.problem_style, "stdout");

      const genRes = await generateFromSession(sessionId);
      assert.ok(genRes.activityId);
      assert.equal(genRes.problems.length, problem_count);
      for (const p of genRes.problems) {
        assert.equal(p.language, "java");
        assert.equal("reference_solution" in p, false);
        assert.equal("reference_workspace" in p, false);
      }

      // Stored activity has correct problem count.
      const stored = activityDb.findById(genRes.activityId);
      assert.ok(stored);
      const storedProblems = JSON.parse(stored.problems);
      assert.equal(storedProblems.length, problem_count);

      const session = getSession(sessionId);
      assert.equal(session.state, "SAVED");
    });
  }
});
