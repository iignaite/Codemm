require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { generateProblemsFromPlan } = require("../../../src/generation");

test("generation progress: emits per-slot event ordering", async () => {
  const events = [];

  const plan = [
    {
      index: 0,
      difficulty: "easy",
      topics: ["arrays"],
      language: "java",
      problem_style: "return",
      constraints: "No extra constraints.",
      test_case_count: 8,
    },
  ];

  const draft = {
    language: "java",
    id: "p1",
    title: "Example",
    description: "Example description.",
    constraints: "Example constraints.",
    sample_inputs: [],
    sample_outputs: [],
    difficulty: "easy",
    topic_tag: "arrays",
    test_suite: "class Dummy {}",
    starter_code: "class Solution {}",
    reference_solution: "class Solution {}",
  };

  await generateProblemsFromPlan(plan, {
    onProgress: (ev) => events.push(ev),
    deps: {
      generateSingleProblem: async () => ({ draft, meta: { llmOutputHash: "x" } }),
      validateReferenceSolution: async () => {},
      runTestStrengthGate: async () => {},
    },
  });

  assert.deepEqual(
    events.map((e) => e.type),
    [
      "slot_started",
      "problem_started",
      "slot_llm_attempt_started",
      "attempt_started",
      "slot_contract_validated",
      "slot_evidence",
      "slot_docker_validation_started",
      "validation_started",
      "slot_attempt_summary",
      "slot_completed",
      "problem_validated",
    ]
  );
});
