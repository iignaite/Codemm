require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildValidatedExecutionBundle,
  ExecutionBundleValidationError,
} = require("../../../src/generation/services/executionBundle");

function makeSlot(overrides = {}) {
  return {
    index: 0,
    language: "python",
    difficulty: "easy",
    topics: ["functions"],
    problem_style: "return",
    constraints: "Python 3.11, pytest, standard library only, no filesystem access, no networking, time limit enforced.",
    test_case_count: 8,
    ...overrides,
  };
}

test("execution bundle rejects python stdin-driven references before judge execution", () => {
  const slot = makeSlot();
  const draft = {
    language: "python",
    id: "py-1",
    title: "Add One",
    description: "Return x + 1.",
    starter_code: "def solve(x):\n    raise NotImplementedError\n",
    reference_solution: "def solve(x):\n    value = input()\n    return int(value) + 1\n",
    test_suite: [
      "import pytest",
      "from solution import solve",
      "def test_case_1(): assert solve(1) == 2",
      "def test_case_2(): assert solve(2) == 3",
      "def test_case_3(): assert solve(3) == 4",
      "def test_case_4(): assert solve(4) == 5",
      "def test_case_5(): assert solve(5) == 6",
      "def test_case_6(): assert solve(6) == 7",
      "def test_case_7(): assert solve(7) == 8",
      "def test_case_8(): assert solve(8) == 9",
    ].join("\n"),
    constraints: slot.constraints,
    sample_inputs: ["1"],
    sample_outputs: ["2"],
    difficulty: "easy",
    topic_tag: "functions",
  };

  assert.throws(
    () => buildValidatedExecutionBundle({ slot, draft }),
    (error) => {
      assert.ok(error instanceof ExecutionBundleValidationError);
      assert.equal(error.kind, "static_rule_violation");
      assert.match(error.message, /stdin/i);
      return true;
    }
  );
});

test("execution bundle rejects obvious non-terminating loops before judge execution", () => {
  const slot = makeSlot({
    language: "cpp",
    topics: ["loops"],
    constraints: "C++20, g++ (GNU), standard library only, no filesystem access, no networking, deterministic behavior.",
  });
  const draft = {
    language: "cpp",
    id: "cpp-1",
    title: "Loop Forever",
    description: "Count values.",
    starter_code: "#include <bits/stdc++.h>\nint solve() { return 0; }\n",
    reference_solution: "#include <bits/stdc++.h>\nint solve() { while (true) {} return 0; }\n",
    test_suite: [
      '#include "solution.cpp"',
      "#include <iostream>",
      "#define RUN_TEST(name, ...) do { bool ok = (__VA_ARGS__); std::cout << (ok ? \"[PASS] \" : \"[FAIL] \") << name << \"\\n\"; } while (0)",
      "bool test_case_1() { return solve() == 0; }",
      "bool test_case_2() { return solve() == 0; }",
      "bool test_case_3() { return solve() == 0; }",
      "bool test_case_4() { return solve() == 0; }",
      "bool test_case_5() { return solve() == 0; }",
      "bool test_case_6() { return solve() == 0; }",
      "bool test_case_7() { return solve() == 0; }",
      "bool test_case_8() { return solve() == 0; }",
      "int main() {",
      '  RUN_TEST("test_case_1", test_case_1());',
      '  RUN_TEST("test_case_2", test_case_2());',
      '  RUN_TEST("test_case_3", test_case_3());',
      '  RUN_TEST("test_case_4", test_case_4());',
      '  RUN_TEST("test_case_5", test_case_5());',
      '  RUN_TEST("test_case_6", test_case_6());',
      '  RUN_TEST("test_case_7", test_case_7());',
      '  RUN_TEST("test_case_8", test_case_8());',
      "}",
    ].join("\n"),
    constraints: slot.constraints,
    sample_inputs: ["0"],
    sample_outputs: ["0"],
    difficulty: "easy",
    topic_tag: "loops",
  };

  assert.throws(
    () => buildValidatedExecutionBundle({ slot, draft }),
    (error) => {
      assert.ok(error instanceof ExecutionBundleValidationError);
      assert.equal(error.kind, "complexity_risk_exceeded");
      assert.match(error.message, /unbounded loop/i);
      return true;
    }
  );
});

test("execution bundle builds normalized hashes and budget profile for a valid java draft", () => {
  const slot = makeSlot({
    language: "java",
    topics: ["encapsulation"],
    problem_style: "stdout",
    constraints: "Java 21, JUnit 5, standard library only.",
  });
  const draft = {
    language: "java",
    id: "java-1",
    title: "Encapsulated Counter",
    description: "Print the counter value.",
    starter_code: "public class Counter { }\n",
    reference_solution: [
      "public class Counter {",
      "  private int value;",
      "  public void increment() { value++; }",
      "  public int getValue() { return value; }",
      "  public void printValue() { System.out.println(value); }",
      "}",
    ].join("\n"),
    test_suite: [
      "import org.junit.jupiter.api.Test;",
      "import static org.junit.jupiter.api.Assertions.*;",
      "import java.io.*;",
      "public class CounterTest {",
      "  @Test void test_case_1() {",
      "    Counter counter = new Counter();",
      "    ByteArrayOutputStream out = new ByteArrayOutputStream();",
      "    System.setOut(new PrintStream(out));",
      "    counter.printValue();",
      "    assertEquals(\"0\", out.toString().trim());",
      "  }",
      "}",
    ].join("\n"),
    constraints: slot.constraints,
    sample_inputs: ["sample"],
    sample_outputs: ["0"],
    difficulty: "easy",
    topic_tag: "encapsulation",
  };

  const bundle = buildValidatedExecutionBundle({ slot, draft });
  assert.equal(bundle.language, "java");
  assert.equal(typeof bundle.bundleHash, "string");
  assert.equal(typeof bundle.artifactHashes.reference, "string");
  assert.equal(typeof bundle.executionBudgetProfile.overallTimeoutMs, "number");
});
