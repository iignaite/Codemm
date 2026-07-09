require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { installGenerationStub } = require("../../helpers/installGenerationStub");
const { generateProblemsFromPlan } = require("../../../src/generation");
const { GenerationSlotFailureError } = require("../../../src/generation/errors");
const { applyGuidedScaffoldingAsync } = require("../../../src/generation/scaffolding");

function javaSlot(overrides = {}) {
  return {
    index: 0,
    difficulty: "easy",
    topics: ["arrays"],
    language: "java",
    problem_style: "return",
    constraints: "Java 17, JUnit 5, no package declarations.",
    test_case_count: 8,
    ...overrides,
  };
}

function javaDraft(slotIndex) {
  return {
    id: `java-pipeline-${slotIndex}`,
    title: `Adder ${slotIndex}`,
    description: "Print a + b.",
    starter_code: [
      "public class Adder {",
      "  public void solve(int a, int b) {",
      "    // TODO",
      "    System.out.println(0);",
      "  }",
      "}",
    ].join("\n"),
    reference_solution: [
      "public class Adder {",
      "  public void solve(int a, int b) {",
      "    System.out.println(a + b);",
      "  }",
      "}",
    ].join("\n"),
    test_suite: `import org.junit.jupiter.api.Test;
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
}`,
    constraints: "Java 17, JUnit 5, no package declarations.",
    sample_inputs: ["a=1, b=2"],
    sample_outputs: ["3"],
    difficulty: "easy",
    topic_tag: "arrays",
  };
}

function installJavaStub(t) {
  return installGenerationStub(t, {
    language: "java",
    buildDraft: javaDraft,
    judgeResult: { success: false, passedTests: [], failedTests: ["baseline"] },
  });
}

test("staged pipeline: emits per-slot event ordering for a successful slot", async (t) => {
  installJavaStub(t);

  const events = [];
  const result = await generateProblemsFromPlan([javaSlot()], { onProgress: (ev) => events.push(ev) });

  assert.equal(result.problems.length, 1);
  assert.equal(result.outcomes[0].success, true);

  const types = events.map((e) => (e.type === "slot_stage_started" || e.type === "slot_stage_finished" ? `${e.type}:${e.stage}` : e.type));
  assert.deepEqual(types, [
    "slot_started",
    "problem_started",
    "route_selected",
    "slot_stage_started:skeleton",
    "slot_stage_finished:skeleton",
    "route_selected",
    "slot_stage_started:tests",
    "slot_stage_finished:tests",
    "route_selected",
    "route_selected",
    "slot_stage_started:reference",
    "slot_stage_finished:reference",
    "slot_stage_started:validate",
    "slot_stage_finished:validate",
    "slot_attempt_summary",
    "slot_evidence",
    "slot_completed",
    "problem_validated",
  ]);

  const summary = events.find((e) => e.type === "slot_attempt_summary");
  assert.equal(summary.status, "success");
});

test("staged pipeline: retries a stage once before succeeding", async (t) => {
  installJavaStub(t);

  const codex = require("../../../src/infra/llm/codemmProvider");
  const inner = codex.createCodemmCompletion;
  let skeletonCalls = 0;
  codex.createCodemmCompletion = async (req) => {
    if (String(req.system).includes("skeleton planner")) {
      skeletonCalls++;
      if (skeletonCalls === 1) {
        return { content: [{ type: "text", text: "not json at all" }] };
      }
    }
    return inner(req);
  };
  t.after(() => {
    codex.createCodemmCompletion = inner;
  });

  const events = [];
  const result = await generateProblemsFromPlan([javaSlot()], { onProgress: (ev) => events.push(ev) });

  assert.equal(result.problems.length, 1);
  assert.equal(skeletonCalls, 2, "skeleton stage retried exactly once");
  const skeletonFinishes = events.filter((e) => e.type === "slot_stage_finished" && e.stage === "skeleton");
  assert.ok(skeletonFinishes.some((e) => e.status === "failed"));
  assert.ok(skeletonFinishes.some((e) => e.status === "success"));
});

test("staged pipeline: persistent stage failure is terminal and surfaces failure events", async (t) => {
  installJavaStub(t);

  const codex = require("../../../src/infra/llm/codemmProvider");
  const inner = codex.createCodemmCompletion;
  codex.createCodemmCompletion = async (req) => {
    if (String(req.system).includes("skeleton planner")) {
      return { content: [{ type: "text", text: "still not json" }] };
    }
    return inner(req);
  };
  t.after(() => {
    codex.createCodemmCompletion = inner;
  });

  const events = [];
  await assert.rejects(
    generateProblemsFromPlan([javaSlot()], { onProgress: (ev) => events.push(ev) }),
    (err) => err instanceof GenerationSlotFailureError
  );

  assert.ok(events.some((e) => e.type === "slot_failed_terminal"));
  assert.ok(events.some((e) => e.type === "problem_failed"));
});

test("guided scaffolding: decays across scaffold levels", async () => {
  const reference_solution = [
    "public class GraphAlgo {",
    "  public int a() { return 1; }",
    "  public int b() { return 2; }",
    "  public int c() { return 3; }",
    "  public int d() { return 4; }",
    "  public int e() { return 5; }",
    "}",
  ].join("\n");

  const baseDraft = {
    language: "java",
    id: "p",
    title: "Example",
    description: "Example description.",
    constraints: "No extra constraints.",
    sample_inputs: [],
    sample_outputs: [],
    difficulty: "easy",
    topic_tag: "graphs",
    test_suite: "class Dummy {}",
    starter_code: reference_solution,
    reference_solution,
  };

  const levels = [80, 60, 30, 10];
  const scaffolded = [];
  for (const [i, scaffold_level] of levels.entries()) {
    const slot = javaSlot({
      index: i,
      topics: ["graphs"],
      constraints: "No extra constraints.",
      pedagogy: { scaffold_level, learning_goal: "Kruskal's Algorithm", hints_enabled: true },
    });
    scaffolded.push(await applyGuidedScaffoldingAsync({ ...baseDraft, id: `p${i}` }, slot));
  }

  const markerCounts = scaffolded.map((p) => (p.starter_code.match(/BEGIN STUDENT TODO/g) ?? []).length);
  assert.deepEqual(markerCounts, [1, 2, 4, 5]);

  assert.ok((scaffolded[0].starter_code.match(/Hint:/g) ?? []).length > 0);
  assert.match(scaffolded[0].starter_code, /Union-Find|DSU/i);
  assert.equal((scaffolded[3].starter_code.match(/Hint:/g) ?? []).length, 0);
  assert.doesNotMatch(scaffolded[3].starter_code, /Union-Find|DSU|Sort edges/i);
});
