require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { generateProblemsFromPlan } = require("../../../src/generation");

test("generation: pipeline can finalize multiple languages (reference artifacts discarded)", async () => {
  const plan = [
    {
      index: 0,
      language: "cpp",
      difficulty: "easy",
      topics: ["graphs"],
      problem_style: "return",
      constraints: "C++20, g++ (GNU), standard library only.",
    },
    {
      index: 1,
      language: "python",
      difficulty: "easy",
      topics: ["strings"],
      problem_style: "return",
      constraints: "Python 3.11, deterministic.",
    },
    {
      index: 2,
      language: "sql",
      difficulty: "easy",
      topics: ["filtering"],
      problem_style: "return",
      constraints: "SQLite 3, read-only queries only.",
    },
    {
      index: 3,
      language: "java",
      difficulty: "easy",
      topics: ["arrays"],
      problem_style: "return",
      constraints: "Java 17, JUnit 5, no package declarations.",
    },
  ];

  const runSlotPipeline = async ({ slot }) => {
    if (slot.language === "cpp") {
      return {
        envelope: {},
        draft: {
          language: "cpp",
          id: "cpp-smoke-1",
          title: "Add Two Numbers",
          description: "Return a+b.",
          starter_code:
            '#include <bits/stdc++.h>\\n\\nint solve(int a, int b) {\\n  // TODO\\n  return 0;\\n}\\n',
          reference_solution:
            '#include <bits/stdc++.h>\\n\\nint solve(int a, int b) {\\n  return a + b;\\n}\\n',
          test_suite: `#include <bits/stdc++.h>
#include "solution.cpp"
static int __codem_failures = 0;
#define RUN_TEST(name, ...) do { \\
  try { __VA_ARGS__; std::cout << "[PASS] " << (name) << "\\n"; } \\
  catch (const std::exception&) { std::cout << "[FAIL] " << (name) << "\\n"; __codem_failures++; } \\
  catch (...) { std::cout << "[FAIL] " << (name) << "\\n"; __codem_failures++; } \\
} while (0)
int main() {
  RUN_TEST("test_case_1", { if (solve(1, 2) != 3) throw std::runtime_error("fail"); });
  RUN_TEST("test_case_2", { if (solve(0, 0) != 0) throw std::runtime_error("fail"); });
  RUN_TEST("test_case_3", { if (solve(-1, 2) != 1) throw std::runtime_error("fail"); });
  RUN_TEST("test_case_4", { if (solve(10, -3) != 7) throw std::runtime_error("fail"); });
  RUN_TEST("test_case_5", { if (solve(100, 23) != 123) throw std::runtime_error("fail"); });
  RUN_TEST("test_case_6", { if (solve(-5, -6) != -11) throw std::runtime_error("fail"); });
  RUN_TEST("test_case_7", { if (solve(7, 8) != 15) throw std::runtime_error("fail"); });
  RUN_TEST("test_case_8", { if (solve(2147483640, 7) != 2147483647) throw std::runtime_error("fail"); });
  return __codem_failures ? 1 : 0;
}
`,
          constraints: slot.constraints,
          sample_inputs: [],
          sample_outputs: [],
          difficulty: slot.difficulty,
          topic_tag: slot.topics[0],
        },
        meta: { llmOutputHash: "stub", promptTemplateId: "test", routePlan: null },
      };
    }

    if (slot.language === "python") {
      return {
        envelope: {},
        draft: {
          language: "python",
          id: "py-smoke-1",
          title: "Echo Length",
          description: "Return len(s).",
          starter_code: "def solve(s: str) -> int:\n    # TODO\n    raise NotImplementedError\n",
          reference_solution: "def solve(s: str) -> int:\n    return len(s)\n",
          test_suite: `import pytest
from solution import solve

def test_case_1(): assert solve("") == 0
def test_case_2(): assert solve("a") == 1
def test_case_3(): assert solve("abc") == 3
def test_case_4(): assert solve("hello") == 5
def test_case_5(): assert solve("  ") == 2
def test_case_6(): assert solve("🙂") == 1
def test_case_7(): assert solve("line\\nbreak") == 10
def test_case_8(): assert solve("x" * 20) == 20
`,
          constraints: slot.constraints,
          sample_inputs: [],
          sample_outputs: [],
          difficulty: slot.difficulty,
          topic_tag: slot.topics[0],
        },
        meta: { llmOutputHash: "stub", promptTemplateId: "test", routePlan: null },
      };
    }

    if (slot.language === "sql") {
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
        envelope: {},
        draft: {
          language: "sql",
          id: "sql-smoke-1",
          title: "Select V",
          description: "Return v for id=1.",
          starter_code: "SELECT v FROM t WHERE id = 1;",
          reference_solution: "SELECT v FROM t WHERE id = 1;",
          test_suite: JSON.stringify(suite),
          constraints: slot.constraints,
          sample_inputs: [],
          sample_outputs: [],
          difficulty: slot.difficulty,
          topic_tag: slot.topics[0],
        },
        meta: { llmOutputHash: "stub", promptTemplateId: "test", routePlan: null },
      };
    }

    // java
    return {
      envelope: {},
      draft: {
        language: "java",
        id: "java-smoke-1",
        title: "Sum Array",
        description: "Return sum of array.",
        starter_code: `
public class SumArray {
  public int solve(int[] a) {
    // TODO
    return 0;
  }
}
`.trim(),
        reference_solution: `
public class SumArray {
  public int solve(int[] a) {
    int s = 0;
    for (int x : a) s += x;
    return s;
  }
}
`.trim(),
        test_suite: `
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

public class SumArrayTest {
  @Test void test_case_1(){ assertEquals(0, new SumArray().solve(new int[]{})); }
  @Test void test_case_2(){ assertEquals(1, new SumArray().solve(new int[]{1})); }
  @Test void test_case_3(){ assertEquals(3, new SumArray().solve(new int[]{1,2})); }
  @Test void test_case_4(){ assertEquals(6, new SumArray().solve(new int[]{1,2,3})); }
  @Test void test_case_5(){ assertEquals(-3, new SumArray().solve(new int[]{-1,-2})); }
  @Test void test_case_6(){ assertEquals(0, new SumArray().solve(new int[]{-1, 1})); }
  @Test void test_case_7(){ assertEquals(10, new SumArray().solve(new int[]{2,2,2,2,2})); }
  @Test void test_case_8(){ assertEquals(7, new SumArray().solve(new int[]{7,0,0})); }
}
`.trim(),
        constraints: slot.constraints,
        sample_inputs: [],
        sample_outputs: [],
        difficulty: slot.difficulty,
        topic_tag: slot.topics[0],
      },
      meta: { llmOutputHash: "stub", promptTemplateId: "test", routePlan: null },
    };
  };

  const result = await generateProblemsFromPlan(plan, {
    deps: { runSlotPipeline },
  });

  assert.equal(result.problems.length, 4);
  for (const p of result.problems) {
    assert.equal("reference_solution" in p, false);
    assert.equal("reference_workspace" in p, false);
  }
});
