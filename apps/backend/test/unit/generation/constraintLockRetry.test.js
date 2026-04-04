require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { generateProblemsFromPlan } = require("../../../src/generation");

function installPythonGeneratorStub(t, drafts) {
  let n = 0;

  return {
    generateSingleProblem: async () => {
      const payload = drafts[Math.min(n, drafts.length - 1)];
      n++;
      return { draft: payload, meta: { llmOutputHash: `stub-${n}` } };
    },
    getCalls: () => n,
  };
}

test("generation: constraint mismatch triggers retry and can recover", async (t) => {
  const slotConstraints =
    "Python 3.11, pytest, standard library only, no filesystem access, no networking, time limit enforced.";

  const bad = {
    language: "python",
    id: "py-bad-1",
    title: "Echo",
    description: "Return the input number.",
    starter_code: "def solve(x):\n    # TODO\n    raise NotImplementedError\n",
    reference_solution: "def solve(x):\n    return x\n",
    test_suite: `import pytest
from solution import solve

def test_case_1(): assert solve(1) == 1
def test_case_2(): assert solve(2) == 2
def test_case_3(): assert solve(3) == 3
def test_case_4(): assert solve(4) == 4
def test_case_5(): assert solve(5) == 5
def test_case_6(): assert solve(6) == 6
def test_case_7(): assert solve(7) == 7
def test_case_8(): assert solve(8) == 8
`,
    constraints: "WRONG",
    sample_inputs: ["x=1"],
    sample_outputs: ["1"],
    difficulty: "hard",
    topic_tag: "arrays",
  };

  const good = { ...bad, id: "py-good-1", constraints: slotConstraints };

  const { generateSingleProblem, getCalls } = installPythonGeneratorStub(t, [bad, good]);

  const plan = [
    {
      index: 0,
      language: "python",
      difficulty: "hard",
      topics: ["arrays"],
      problem_style: "return",
      constraints: slotConstraints,
      test_case_count: 8,
    },
  ];

  const result = await generateProblemsFromPlan(plan, {
    deps: {
      generateSingleProblem,
      validateReferenceSolution: async () => {},
      runTestStrengthGate: async () => {},
    },
  });

  assert.equal(result.problems.length, 1);
  assert.equal(getCalls(), 2);
});
