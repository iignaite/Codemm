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
    const topic = topicsMatch?.[1]?.trim().split(/[,\n]/)[0]?.trim() || "graphs";
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

  function cppDraft(slotIndex) {
    return {
      id: `cpp-e2e-${slotIndex}`,
      title: `Print Adder ${slotIndex}`,
      description: "Print a+b.",
      starter_code:
        '#include <bits/stdc++.h>\\n\\nvoid solve(int a, int b) {\\n  // TODO\\n}\\n',
      reference_solution:
        '#include <bits/stdc++.h>\\n\\nvoid solve(int a, int b) {\\n  std::cout << (a + b) << \"\\\\n\";\\n}\\n',
      test_suite: `#include <bits/stdc++.h>
#include "solution.cpp"
static int __codem_failures = 0;
#define RUN_TEST(name, ...) do { \\
  try { __VA_ARGS__; std::cout << "[PASS] " << (name) << "\\n"; } \\
  catch (...) { std::cout << "[FAIL] " << (name) << "\\n"; __codem_failures++; } \\
} while (0)

static std::string capture_stdout(std::function<void()> fn) {
  std::ostringstream oss;
  auto* old = std::cout.rdbuf(oss.rdbuf());
  fn();
  std::cout.rdbuf(old);
  return oss.str();
}

int main() {
  RUN_TEST("test_case_1", { auto out = capture_stdout([&]{ solve(1,2); }); if (out != "3\\n") throw std::runtime_error("fail"); });
  RUN_TEST("test_case_2", { auto out = capture_stdout([&]{ solve(0,0); }); if (out != "0\\n") throw std::runtime_error("fail"); });
  RUN_TEST("test_case_3", { auto out = capture_stdout([&]{ solve(-1,2); }); if (out != "1\\n") throw std::runtime_error("fail"); });
  RUN_TEST("test_case_4", { auto out = capture_stdout([&]{ solve(10,-3); }); if (out != "7\\n") throw std::runtime_error("fail"); });
  RUN_TEST("test_case_5", { auto out = capture_stdout([&]{ solve(100,23); }); if (out != "123\\n") throw std::runtime_error("fail"); });
  RUN_TEST("test_case_6", { auto out = capture_stdout([&]{ solve(-5,-6); }); if (out != "-11\\n") throw std::runtime_error("fail"); });
  RUN_TEST("test_case_7", { auto out = capture_stdout([&]{ solve(7,8); }); if (out != "15\\n") throw std::runtime_error("fail"); });
  RUN_TEST("test_case_8", { auto out = capture_stdout([&]{ solve(2147483640,7); }); if (out != "2147483647\\n") throw std::runtime_error("fail"); });
  return __codem_failures ? 1 : 0;
}
`,
      constraints:
        "C++20, g++ (GNU), standard library only, no filesystem access, no networking, deterministic behavior.",
      sample_inputs: ["a=1, b=2"],
      sample_outputs: ["3"],
      difficulty: "easy",
      topic_tag: "graphs",
    };
  }

  return installGenerationStub(t, {
    language,
    buildDialogueResponse,
    buildDraft: cppDraft,
    judgeResult: { success: false, passedTests: [], failedTests: ["baseline"] },
  });
}

test("e2e activity generation (cpp): 2/4/7 problems (stdout-only)", async (t) => {
  const { calls } = installStubs(t, "cpp");

  const counts = [2, 4, 7];

  for (const problem_count of counts) {
    await t.test(`count=${problem_count}`, async () => {
      calls.length = 0;

      const { sessionId } = createSession("practice");
      const prompt = `Create ${problem_count} easy problems in C++. Topics: graphs`;

      const msgRes = await processSessionMessage(sessionId, prompt);
      assert.equal(msgRes.accepted, true);
      assert.equal(msgRes.done, true);
      assert.equal(msgRes.state, "READY");
      assert.equal(msgRes.spec.language, "cpp");
      assert.equal(msgRes.spec.problem_count, problem_count);
      assert.equal(msgRes.spec.problem_style, "stdout");

      const genRes = await generateFromSession(sessionId);
      assert.ok(genRes.activityId);
      assert.equal(genRes.problems.length, problem_count);
      for (const p of genRes.problems) {
        assert.equal(p.language, "cpp");
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
