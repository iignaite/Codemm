require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { generateSingleProblem } = require("../../../src/generation/perSlotGenerator");

function installPythonGeneratorStub(t, drafts) {
  const codex = require("../../../src/infra/llm/codemmProvider");
  const originalCreateCodemm = codex.createCodemmCompletion;
  let n = 0;

  const stub = async ({ system }) => {
    if (String(system).includes("Python problem generator")) {
      const payload = drafts[Math.min(n, drafts.length - 1)];
      n++;
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    }
    throw new Error(`Unexpected LLM call in test (system=${String(system).slice(0, 80)})`);
  };

  codex.createCodemmCompletion = stub;

  t.after(() => {
    codex.createCodemmCompletion = originalCreateCodemm;
  });

  return { getCalls: () => n };
}

test("constraints locking: mismatched constraints triggers contract failure", async (t) => {
  const slot = {
    index: 0,
    language: "python",
    difficulty: "hard",
    topics: ["arrays"],
    problem_style: "return",
    constraints: "Python 3.11, pytest, standard library only, no filesystem access, no networking, time limit enforced.",
    test_case_count: 8,
  };

  const bad = {
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

  installPythonGeneratorStub(t, [bad]);

  await assert.rejects(
    () => generateSingleProblem(slot),
    (e) => {
      assert.match(String(e && e.message), /Invalid constraints/i);
      return true;
    }
  );
});

