require("../../helpers/setupDb");
const { installGenerationStub } = require("../../helpers/installGenerationStub");

const test = require("node:test");
const assert = require("node:assert/strict");

const { activityDb } = require("../../../src/database");
const { createSession, processSessionMessage, generateFromSession, getSession } = require("../../../src/services/sessionService");

const LANGUAGE_CASES = {
  java: {
    topic: "arrays",
    promptLanguage: "Java",
    buildDraft(slotIndex) {
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
    },
  },
  python: {
    topic: "strings",
    promptLanguage: "Python",
    buildDraft(slotIndex) {
      return {
        id: `py-e2e-${slotIndex}`,
        title: `Print Len ${slotIndex}`,
        description: "Print len(s).",
        starter_code: "def solve(s: str) -> None:\n    # TODO\n    raise NotImplementedError\n",
        reference_solution: "def solve(s: str) -> None:\n    print(len(s))\n",
        test_suite: `import pytest
from solution import solve

def test_case_1(capsys): solve(""); captured = capsys.readouterr(); assert captured.out.strip() == "0"
def test_case_2(capsys): solve("a"); captured = capsys.readouterr(); assert captured.out.strip() == "1"
def test_case_3(capsys): solve("abc"); captured = capsys.readouterr(); assert captured.out.strip() == "3"
def test_case_4(capsys): solve("hello"); captured = capsys.readouterr(); assert captured.out.strip() == "5"
def test_case_5(capsys): solve("  "); captured = capsys.readouterr(); assert captured.out.strip() == "2"
def test_case_6(capsys): solve("🙂"); captured = capsys.readouterr(); assert captured.out.strip() == "1"
def test_case_7(capsys): solve("line\\nbreak"); captured = capsys.readouterr(); assert captured.out.strip() == "10"
def test_case_8(capsys): solve("x" * 20); captured = capsys.readouterr(); assert captured.out.strip() == "20"
`,
        constraints:
          "Python 3.11, pytest, standard library only, no filesystem access, no networking, time limit enforced.",
        sample_inputs: ['s = "abc"'],
        sample_outputs: ["3"],
        difficulty: "easy",
        topic_tag: "strings",
      };
    },
  },
  cpp: {
    topic: "graphs",
    promptLanguage: "C++",
    buildDraft(slotIndex) {
      return {
        id: `cpp-e2e-${slotIndex}`,
        title: `Print Adder ${slotIndex}`,
        description: "Print a+b.",
        starter_code:
          '#include <bits/stdc++.h>\\n\\nvoid solve(int a, int b) {\\n  // TODO\\n}\\n',
        reference_solution:
          '#include <bits/stdc++.h>\\n\\nvoid solve(int a, int b) {\\n  std::cout << (a + b) << "\\\\n";\\n}\\n',
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
    },
  },
  sql: {
    topic: "filtering",
    promptLanguage: "SQL",
    buildDraft(slotIndex) {
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
    },
  },
};

function parseRequestedCountAndTopic(msg, fallbackTopic) {
  const text = String(msg || "");
  const lower = text.toLowerCase();
  const countMatch = lower.match(/\b(\d+)\s+(?:problems?|questions?)\b/);
  const count = countMatch ? Number(countMatch[1]) : 1;
  const topicsMatch = text.match(/\btopics?\s*:\s*([A-Za-z0-9 _-]+)/i);
  const topic = topicsMatch?.[1]?.trim().split(/[,\n]/)[0]?.trim() || fallbackTopic;
  return { count, topic };
}

function installLanguageStubs(t, language) {
  const config = LANGUAGE_CASES[language];
  return installGenerationStub(t, {
    language,
    buildDialogueResponse(latestUserMessage) {
      const { count, topic } = parseRequestedCountAndTopic(latestUserMessage, config.topic);
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
    },
    buildDraft: config.buildDraft,
    judgeResult: { success: false, passedTests: [], failedTests: ["baseline"] },
  });
}

test("e2e activity generation matrix: java/python/cpp/sql (stdout-only)", async (t) => {
  const counts = [2, 4, 7];

  for (const [language, config] of Object.entries(LANGUAGE_CASES)) {
    await t.test(language, async (tLang) => {
      const { calls } = installLanguageStubs(tLang, language);

      for (const problemCount of counts) {
        await tLang.test(`count=${problemCount}`, async () => {
          calls.length = 0;

          const { sessionId } = createSession("practice");
          const prompt = `Create ${problemCount} easy problems in ${config.promptLanguage}. Topics: ${config.topic}`;

          const msgRes = await processSessionMessage(sessionId, prompt);
          assert.equal(msgRes.accepted, true);
          assert.equal(msgRes.done, true);
          assert.equal(msgRes.state, "READY");
          assert.equal(msgRes.spec.language, language);
          assert.equal(msgRes.spec.problem_count, problemCount);
          assert.equal(msgRes.spec.problem_style, "stdout");

          const genRes = await generateFromSession(sessionId);
          assert.ok(genRes.activityId);
          assert.equal(genRes.problems.length, problemCount);
          for (const problem of genRes.problems) {
            assert.equal(problem.language, language);
            assert.equal("reference_solution" in problem, false);
            assert.equal("reference_workspace" in problem, false);
          }

          const stored = activityDb.findById(genRes.activityId);
          assert.ok(stored);
          const storedProblems = JSON.parse(stored.problems);
          assert.equal(storedProblems.length, problemCount);

          const session = getSession(sessionId);
          assert.equal(session.state, "COMPLETED");
          assert.equal(session.latestGenerationRunStatus, "COMPLETED");
        });
      }
    });
  }
});
