require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { runTestStrengthGate, TestStrengthGateError } = require("../../../src/generation/testStrengthGate");

function mkJudgeResult(success) {
  return {
    success,
    passedTests: success ? ["t"] : [],
    failedTests: success ? [] : ["t"],
    stdout: "",
    stderr: "",
    executionTimeMs: 1,
    exitCode: success ? 0 : 1,
    timedOut: false,
  };
}

test("test strength gate: fails deterministically when starter_code baseline passes", async () => {
  const slot = {
    index: 0,
    language: "python",
    difficulty: "hard",
    topics: ["arrays"],
    problem_style: "return",
    constraints: "Python 3.11, pytest, standard library only, no filesystem access, no networking, time limit enforced.",
    test_case_count: 8,
  };

  const draft = {
    language: "python",
    id: "p1",
    title: "Gate",
    description: "desc",
    starter_code: "def solve(*args, **kwargs):\n    return 0\n",
    reference_solution: "def solve(*args, **kwargs):\n    return 1\n",
    test_suite: "import pytest\nfrom solution import solve\n\ndef test_case_1(): assert solve(1) == 1\n",
    constraints: slot.constraints,
    sample_inputs: ["x=1"],
    sample_outputs: ["1"],
    difficulty: "hard",
    topic_tag: "arrays",
  };

  let calls = 0;
  const judgeAdapter = {
    judge: async (req) => {
      calls++;
      if (req.kind === "code" && req.code === draft.starter_code) return mkJudgeResult(true);
      return mkJudgeResult(false);
    },
  };

  await assert.rejects(
    () => runTestStrengthGate(draft, slot, { judgeAdapter }),
    (e) => {
      assert.ok(e instanceof TestStrengthGateError);
      assert.equal(e.baselineId, "starter_code");
      return true;
    }
  );

  assert.equal(calls, 2);
});

test("test strength gate: passes when baselines fail", async () => {
  const slot = {
    index: 0,
    language: "python",
    difficulty: "hard",
    topics: ["arrays"],
    problem_style: "return",
    constraints: "Python 3.11, pytest, standard library only, no filesystem access, no networking, time limit enforced.",
    test_case_count: 8,
  };

  const draft = {
    language: "python",
    id: "p1",
    title: "Gate",
    description: "desc",
    starter_code: "def solve(*args, **kwargs):\n    return 0\n",
    reference_solution: "def solve(*args, **kwargs):\n    return 1\n",
    test_suite: "import pytest\nfrom solution import solve\n\ndef test_case_1(): assert solve(1) == 1\n",
    constraints: slot.constraints,
    sample_inputs: ["x=1"],
    sample_outputs: ["1"],
    difficulty: "hard",
    topic_tag: "arrays",
  };

  const judgeAdapter = { judge: async () => mkJudgeResult(false) };
  await runTestStrengthGate(draft, slot, { judgeAdapter });
});
