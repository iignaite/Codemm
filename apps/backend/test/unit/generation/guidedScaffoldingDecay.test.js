require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { generateProblemsFromPlan } = require("../../../src/generation");

test("guided scaffolding: decays across problems", async () => {
  const plan = [
    {
      index: 0,
      difficulty: "easy",
      topics: ["graphs"],
      language: "java",
      problem_style: "return",
      constraints: "No extra constraints.",
      test_case_count: 8,
      pedagogy: { scaffold_level: 80, learning_goal: "Kruskal's Algorithm", hints_enabled: true },
    },
    {
      index: 1,
      difficulty: "easy",
      topics: ["graphs"],
      language: "java",
      problem_style: "return",
      constraints: "No extra constraints.",
      test_case_count: 8,
      pedagogy: { scaffold_level: 60, learning_goal: "Kruskal's Algorithm", hints_enabled: true },
    },
    {
      index: 2,
      difficulty: "easy",
      topics: ["graphs"],
      language: "java",
      problem_style: "return",
      constraints: "No extra constraints.",
      test_case_count: 8,
      pedagogy: { scaffold_level: 30, learning_goal: "Kruskal's Algorithm", hints_enabled: true },
    },
    {
      index: 3,
      difficulty: "easy",
      topics: ["graphs"],
      language: "java",
      problem_style: "return",
      constraints: "No extra constraints.",
      test_case_count: 8,
      pedagogy: { scaffold_level: 10, learning_goal: "Kruskal's Algorithm", hints_enabled: true },
    },
  ];

  const reference_solution = `
public class GraphAlgo {
  public int a() { return 1; }
  public int b() { return 2; }
  public int c() { return 3; }
  public int d() { return 4; }
  public int e() { return 5; }
}
`.trim();

  const baseDraft = {
    language: "java",
    id: "p",
    title: "Example",
    description: "Example description.",
    constraints: plan[0].constraints,
    sample_inputs: [],
    sample_outputs: [],
    difficulty: "easy",
    topic_tag: "graphs",
    test_suite: "class Dummy {}",
    starter_code: reference_solution,
    reference_solution,
  };

  let n = 0;
  const { problems } = await generateProblemsFromPlan(plan, {
    deps: {
      generateSingleProblem: async () => ({ draft: { ...baseDraft, id: `p${n++}` }, meta: { llmOutputHash: "x" } }),
      validateReferenceSolution: async () => {},
      runTestStrengthGate: async () => {},
    },
  });

  const markerCounts = problems.map((p) => (p.starter_code.match(/BEGIN STUDENT TODO/g) ?? []).length);
  assert.deepEqual(markerCounts, [1, 2, 4, 5]);

  assert.ok((problems[0].starter_code.match(/Hint:/g) ?? []).length > 0);
  assert.match(problems[0].starter_code, /Union-Find|DSU/i);
  assert.equal((problems[3].starter_code.match(/Hint:/g) ?? []).length, 0);
  assert.doesNotMatch(problems[3].starter_code, /Union-Find|DSU|Sort edges/i);
});
