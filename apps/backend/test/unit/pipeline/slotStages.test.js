require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { SlotPipelineTerminalError, __test__ } = require("../../../src/pipeline/slotStages");

function makeJavaSlot(topics = ["encapsulation"]) {
  return {
    index: 0,
    language: "java",
    difficulty: "easy",
    topics,
    problem_style: "stdout",
    constraints: "Java 21, JUnit 5, standard library only.",
    test_case_count: 8,
  };
}

function makeJavaDraft(referenceSolution, testSuite) {
  return {
    language: "java",
    id: "java-encapsulation-1",
    title: "Encapsulated Music Profile",
    description: "Build a small encapsulation exercise.",
    starter_code: "public class UserProfile {\n  // TODO\n}\n",
    reference_solution: referenceSolution,
    test_suite: testSuite,
    constraints: "Java 21, JUnit 5, standard library only.",
    sample_inputs: ["sample"],
    sample_outputs: ["sample"],
    difficulty: "easy",
    topic_tag: "encapsulation",
  };
}

test("slot stages: preflight rejects stdin-driven Java structural-topic references before Docker validation", () => {
  const slot = makeJavaSlot(["encapsulation"]);
  const draft = makeJavaDraft(
    [
      "import java.util.Scanner;",
      "public class UserProfile {",
      "  private String name = \"guest\";",
      "  public static void main(String[] args) {",
      "    Scanner scanner = new Scanner(System.in);",
      "    System.out.println(scanner.nextLine());",
      "  }",
      "  public String getName() { return name; }",
      "  public void setName(String value) { this.name = value; }",
      "}",
    ].join("\n"),
    [
      "import org.junit.jupiter.api.Test;",
      "import static org.junit.jupiter.api.Assertions.*;",
      "public class UserProfileTest {",
      "  @Test void testStatefulEncapsulation() {",
      "    UserProfile profile = new UserProfile();",
      "    profile.setName(\"A\");",
      "    assertEquals(\"A\", profile.getName());",
      "  }",
      "}",
    ].join("\n")
  );

  assert.throws(
    () => __test__.preflightValidateDraft({ slot, draft, stage: "reference" }),
    (error) => {
      assert.ok(error instanceof SlotPipelineTerminalError);
      assert.equal(error.stage, "reference");
      assert.equal(error.kind, "contract");
      assert.match(error.message, /stdin reads/i);
      return true;
    }
  );
});

test("slot stages: preflight rejects Java structural-topic drafts that violate structural requirements", () => {
  const slot = makeJavaSlot(["encapsulation"]);
  const draft = makeJavaDraft(
    [
      "public class UserProfile {",
      "  public String name = \"guest\";",
      "  public String getName() { return name; }",
      "}",
    ].join("\n"),
    [
      "import org.junit.jupiter.api.Test;",
      "import static org.junit.jupiter.api.Assertions.*;",
      "public class UserProfileTest {",
      "  @Test void testGetterOnly() {",
      "    UserProfile profile = new UserProfile();",
      "    assertEquals(\"guest\", profile.getName());",
      "  }",
      "}",
    ].join("\n")
  );

  assert.throws(
    () => __test__.preflightValidateDraft({ slot, draft, stage: "reference" }),
    (error) => {
      assert.ok(error instanceof SlotPipelineTerminalError);
      assert.equal(error.kind, "contract");
      assert.match(error.message, /private field|public fields/i);
      return true;
    }
  );
});

test("slot stages: detects no-op repair when hash or source is unchanged", () => {
  assert.equal(
    __test__.isNoOpReferenceRepair({
      previousReferenceSource: "class A {}",
      previousReferenceHash: "abc",
      nextReferenceSource: "class B {}",
      nextReferenceHash: "abc",
    }),
    true
  );

  assert.equal(
    __test__.isNoOpReferenceRepair({
      previousReferenceSource: "class A {}",
      nextReferenceSource: " class A {} \n",
    }),
    true
  );

  assert.equal(
    __test__.isNoOpReferenceRepair({
      previousReferenceSource: "class A {}",
      previousReferenceHash: "abc",
      nextReferenceSource: "class B {}",
      nextReferenceHash: "def",
    }),
    false
  );
});

test("slot stages: preserves explicit terminal failure kinds for downstream summaries", () => {
  assert.equal(__test__.inferFailureKind({ kind: "timeout", message: "timed out" }), "timeout");
  assert.equal(__test__.inferFailureKind({ kind: "contract", message: "bad draft" }), "contract");
});
