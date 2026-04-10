require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { generateProblemsFromPlan } = require("../../../src/generation");

function makePlan(count = 3) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    language: "python",
    difficulty: "easy",
    topics: [`topic-${index}`],
    problem_style: "return",
    constraints: "Python 3.11, deterministic.",
  }));
}

function makeDraft(slotIndex) {
  return {
    language: "python",
    id: `problem-${slotIndex}`,
    title: `Problem ${slotIndex}`,
    description: `Solve slot ${slotIndex}.`,
    starter_code: "def solve(x):\n    return x\n",
    reference_solution: `def solve(x):\n    return ${slotIndex}\n`,
    test_suite: "from solution import solve\n\ndef test_case_1():\n    assert solve(1) == 1\n",
    constraints: "Python 3.11, deterministic.",
    sample_inputs: [],
    sample_outputs: [],
    difficulty: "easy",
    topic_tag: `topic-${slotIndex}`,
  };
}

test("generation: targeted rerun preserves successful slots and repairs only failed slot indexes", async () => {
  const plan = makePlan(3);
  const resumeProblems = [
    { ...makeDraft(0), reference_solution: undefined },
    { ...makeDraft(2), reference_solution: undefined },
  ];
  const resumeOutcomes = [
    { slotIndex: 0, success: true, status: "SUCCEEDED", retries: 0 },
    {
      slotIndex: 1,
      success: false,
      status: "RETRYABLE_FAILURE",
      retries: 0,
      failureKind: "time_budget_exceeded",
      failureCode: "TIME_BUDGET_EXCEEDED",
      message: "timed out",
    },
    { slotIndex: 2, success: true, status: "SUCCEEDED", retries: 0 },
  ];

  const visited = [];
  const result = await generateProblemsFromPlan(plan, {
    resume: { problems: resumeProblems, outcomes: resumeOutcomes },
    targetSlotIndexes: [1],
    deps: {
      runSlotPipeline: async ({ slot }) => {
        visited.push(slot.index);
        return {
          envelope: {},
          draft: makeDraft(slot.index),
          meta: { llmOutputHash: `hash-${slot.index}`, promptTemplateId: "test", routePlan: null },
        };
      },
    },
  });

  assert.deepEqual(visited, [1]);
  assert.deepEqual(
    result.slotResults.map((slot) => [slot.slotIndex, slot.terminalStatus]),
    [
      [0, "SUCCEEDED"],
      [1, "SUCCEEDED"],
      [2, "SUCCEEDED"],
    ],
  );
  assert.deepEqual(
    result.problems.map((problem) => problem.title),
    ["Problem 0", "Problem 1", "Problem 2"],
  );
  assert.equal(result.outcomes.length, 3);
});

test("generation: bounded concurrency runs multiple slots in parallel but preserves ordered output", async () => {
  const plan = makePlan(4);
  let inFlight = 0;
  let maxInFlight = 0;

  const result = await generateProblemsFromPlan(plan, {
    concurrency: 2,
    deps: {
      runSlotPipeline: async ({ slot }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 25));
        inFlight -= 1;
        return {
          envelope: {},
          draft: makeDraft(slot.index),
          meta: { llmOutputHash: `hash-${slot.index}`, promptTemplateId: "test", routePlan: null },
        };
      },
    },
  });

  assert.equal(maxInFlight, 2);
  assert.deepEqual(
    result.slotResults.map((slot) => slot.slotIndex),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    result.problems.map((problem) => problem.title),
    ["Problem 0", "Problem 1", "Problem 2", "Problem 3"],
  );
});
