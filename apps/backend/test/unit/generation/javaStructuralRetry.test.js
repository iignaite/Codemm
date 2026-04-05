require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { generateProblemsFromPlan } = require("../../../src/generation");

function installJavaGeneratorStub(t) {
  let n = 0;

  const invalidDraft = {
    language: "java",
    id: "java-bad-1",
    title: "Billing",
    description: "Compute billing cost.",
    starter_code: `
public class Billing {
  public void solve(String plan, int minutes) {
    // TODO
    System.out.println(0);
  }
}
`.trim(),
    reference_solution: `
public class Billing {
  public void solve(String plan, int minutes) {
    System.out.println(minutes);
  }
}
`.trim(),
    test_suite: `
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import java.io.*;

public class BillingTest {
  private String run(String plan, int minutes) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    PrintStream prev = System.out;
    System.setOut(new PrintStream(out));
    try { new Billing().solve(plan, minutes); }
    finally { System.setOut(prev); }
    return out.toString().trim();
  }

  @Test void test_case_1(){ assertEquals("3", run("basic", 3)); }
  @Test void test_case_2(){ assertEquals("3", run("premium", 3)); }
  @Test void test_case_3(){ assertEquals("0", run("basic", 0)); }
  @Test void test_case_4(){ assertEquals("0", run("premium", 0)); }
  @Test void test_case_5(){ assertEquals("1", run("basic", 1)); }
  @Test void test_case_6(){ assertEquals("1", run("premium", 1)); }
  @Test void test_case_7(){ assertEquals("2", run("basic", 2)); }
  @Test void test_case_8(){ assertEquals("2", run("premium", 2)); }
}
`.trim(),
    constraints: "Java 17, JUnit 5, no package declarations.",
    sample_inputs: ["plan=basic, minutes=3"],
    sample_outputs: ["3"],
    difficulty: "hard",
    topic_tag: "polymorphism",
  };

  const validDraft = {
    language: "java",
    id: "java-good-1",
    title: "Billing",
    description: "Compute billing cost.",
    starter_code: `
public class Billing {
  public void solve(String plan, int minutes) {
    // TODO
    System.out.println(0);
  }
}

interface PricingPlan {
  int cost(int minutes);
}

class BasicPlan implements PricingPlan {
  public int cost(int minutes) { return 0; }
}

class PremiumPlan implements PricingPlan {
  public int cost(int minutes) { return 0; }
}
`.trim(),
    reference_solution: `
public class Billing {
  public void solve(String plan, int minutes) {
    PricingPlan p = plan.equals("premium") ? new PremiumPlan() : new BasicPlan();
    System.out.println(p.cost(minutes));
  }
}

interface PricingPlan {
  int cost(int minutes);
}

class BasicPlan implements PricingPlan {
  public int cost(int minutes) { return minutes; }
}

class PremiumPlan implements PricingPlan {
  public int cost(int minutes) { return minutes * 2; }
}
`.trim(),
    test_suite: `
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import java.io.*;

public class BillingTest {
  @Test void test_case_1(){ PricingPlan p = new BasicPlan(); assertEquals(3, p.cost(3)); }
  @Test void test_case_2(){ PricingPlan p = new PremiumPlan(); assertEquals(6, p.cost(3)); }
  private String run(String plan, int minutes) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    PrintStream prev = System.out;
    System.setOut(new PrintStream(out));
    try { new Billing().solve(plan, minutes); }
    finally { System.setOut(prev); }
    return out.toString().trim();
  }

  @Test void test_case_3(){ assertEquals("3", run("basic", 3)); }
  @Test void test_case_4(){ assertEquals("6", run("premium", 3)); }
  @Test void test_case_5(){ assertEquals("0", run("basic", 0)); }
  @Test void test_case_6(){ assertEquals("0", run("premium", 0)); }
  @Test void test_case_7(){ assertEquals("1", run("basic", 1)); }
  @Test void test_case_8(){ assertEquals("2", run("premium", 1)); }
}
`.trim(),
    constraints: "Java 17, JUnit 5, no package declarations.",
    sample_inputs: ["plan=basic, minutes=3"],
    sample_outputs: ["3"],
    difficulty: "hard",
    topic_tag: "polymorphism",
  };

  return {
    generateSingleProblem: async () => {
      const payload = n++ === 0 ? invalidDraft : validDraft;
      return { draft: payload, meta: { llmOutputHash: `stub-${n}` } };
    },
    getCalls: () => n,
  };
}

test("generation: java structural topic violation triggers retry and can recover", async (t) => {
  const { generateSingleProblem, getCalls } = installJavaGeneratorStub(t);

  const plan = [
    {
      index: 0,
      language: "java",
      difficulty: "hard",
      topics: ["polymorphism"],
      problem_style: "stdout",
      constraints: "Java 17, JUnit 5, no package declarations.",
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
