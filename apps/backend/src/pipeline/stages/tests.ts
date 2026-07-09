import crypto from "crypto";
import { createCodemmCompletion, type CompletionMeta } from "../../infra/llm";
import type { SlotSkeleton, SlotStageResult, SlotTests } from "../../contracts/slotPipeline";
import type { ProblemSlot } from "../../planner/types";
import { diagnoseCppTestSuite, isValidCppTestSuite } from "../../languages/cpp/rules";
import { isValidJUnit5TestSuiteCountRange } from "../../languages/java/rules";
import { isValidPytestTestSuiteForStyle } from "../../languages/python/rules";
import { diagnoseSqlTestSuite, isValidSqlTestSuite } from "../../languages/sql/rules";
import { tryParseJson } from "../../utils/jsonParser";

export const TESTS_PROMPT_TEMPLATE_ID = "slot-tests:v1";

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function normalizeStyle(raw: string): "stdout" | "return" | "mixed" {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "stdout" || value === "mixed") return value;
  return "return";
}

function buildLanguageInstructions(slot: ProblemSlot): string {
  const style = normalizeStyle(slot.problem_style);
  if (slot.language === "java") {
    return [
      "Return JSON: {\"test_suite\":\"...\"}.",
      "Use JUnit 5 with exactly 8 @Test methods.",
      "Import org.junit.jupiter.api.Test and static org.junit.jupiter.api.Assertions.*.",
      "No package declarations.",
      "The test class name must be the target class name + Test.",
      style === "stdout"
        ? "Capture stdout and assert printed output."
        : style === "mixed"
          ? "Assert both return values and printed output."
          : "Assert method behavior deterministically.",
    ].join("\n");
  }
  if (slot.language === "python") {
    return [
      "Return JSON: {\"test_suite\":\"...\"}.",
      "Use pytest with exactly 8 tests named test_case_1..test_case_8.",
      "Import solve via: from solution import solve.",
      style === "stdout"
        ? 'Every test must have the exact signature "def test_case_N(capsys):", call solve(...), then assert on capsys.readouterr().out.'
        : style === "mixed"
          ? "Each test must assert solve(...) == expected and assert on captured stdout via capsys."
          : "Each test must assert solve(...) == expected.",
      "Do not print in tests. Do not use randomness.",
    ].join("\n");
  }
  if (slot.language === "cpp") {
    return [
      "Return JSON: {\"test_suite\":\"...\"}.",
      "The test_suite must follow EXACTLY this harness shape (adapt only the assertions):",
      "```cpp",
      "#include <bits/stdc++.h>",
      '#include "solution.cpp"',
      "static int failures = 0;",
      '#define RUN_TEST(name, ...) do { if (__VA_ARGS__) { std::cout << \"[PASS] \" << name << std::endl; } else { std::cout << \"[FAIL] \" << name << std::endl; failures++; } } while (0)',
      style === "stdout"
        ? "std::string captureSolve(/* solve args */) { std::ostringstream oss; auto* old = std::cout.rdbuf(oss.rdbuf()); solve(/* args */); std::cout.rdbuf(old); return oss.str(); }"
        : "// call solve(...) directly and compare returned values",
      "int main() {",
      '  RUN_TEST("test_case_1", /* boolean expression asserting expected behavior */);',
      "  // ... exactly 8 RUN_TEST cases named test_case_1 through test_case_8 ...",
      '  RUN_TEST("test_case_8", /* boolean expression */);',
      "  return failures == 0 ? 0 : 1;",
      "}",
      "```",
      "Hard requirements: the variadic RUN_TEST macro exactly as shown; exactly 8 cases named test_case_1..test_case_8; [PASS]/[FAIL] output.",
    ].join("\n");
  }
  return [
    "Return JSON: {\"test_suite\":\"...\"}.",
    "The test_suite value must be a STRING containing JSON of EXACTLY this shape:",
    '{"schema_sql":"CREATE TABLE ...;","cases":[{"name":"test_case_1","seed_sql":"INSERT INTO ...;","expected":{"columns":["col1"],"rows":[["value",1]]}}]}',
    "Hard requirements: a non-empty schema_sql string; exactly 8 cases named test_case_1..test_case_8; every case has seed_sql (string) and expected with non-empty columns (string[]) and rows (arrays of values).",
  ].join("\n");
}

/** Specific, actionable reason a suite was rejected — fed back into the retry prompt. */
export function diagnoseTestSuite(slot: ProblemSlot, testSuite: string): string {
  if (!testSuite.trim()) return "The response contained no test_suite string.";
  if (slot.language === "cpp") {
    const d = diagnoseCppTestSuite(testSuite);
    const issues: string[] = [];
    if (!d.includesSolutionCpp) issues.push('missing #include "solution.cpp"');
    if (!d.hasMain) issues.push("missing int main()");
    if (d.hasRunTestCalls && !d.hasVariadicRunTestMacro) issues.push("RUN_TEST macro must be variadic (#define RUN_TEST(name, ...))");
    if (!d.hasPassFailOutput) issues.push("tests must print [PASS]/[FAIL] lines");
    if (d.foundTestNumbers.length !== 8) {
      issues.push(`expected exactly 8 cases named test_case_1..test_case_8, found ${d.foundTestNumbers.length} (${d.foundTestNumbers.join(",") || "none"})`);
    }
    return issues.join("; ") || "structural validation failed";
  }
  if (slot.language === "sql") {
    const issues = diagnoseSqlTestSuite(testSuite, 8);
    return issues.join("; ") || "structural validation failed";
  }
  if (slot.language === "java") {
    return "suite must be a JUnit 5 class with 1..8 @Test methods, no package declaration, class name = target class + Test";
  }
  return `suite must be pytest with exactly 8 tests named test_case_1..test_case_8 matching problem style "${slot.problem_style}"`;
}

export function validateTestSuite(slot: ProblemSlot, testSuite: string): boolean {
  if (slot.language === "java") return isValidJUnit5TestSuiteCountRange(testSuite, 1, 8);
  if (slot.language === "python") return isValidPytestTestSuiteForStyle(testSuite, slot.problem_style, 8);
  if (slot.language === "cpp") return isValidCppTestSuite(testSuite, 8);
  return isValidSqlTestSuite(testSuite, 8);
}

export async function generateTests(args: {
  slot: ProblemSlot;
  skeleton: SlotSkeleton;
  previousTests?: string;
  errorMessage?: string;
  attempt: number;
}): Promise<SlotStageResult<SlotTests>> {
  const { slot, skeleton } = args;
  const system = `
You are Codemm's test artifact generator.

Return ONLY valid JSON and follow the exact schema requested by the user prompt.
Do not include explanations, markdown, or extra keys.
`.trim();
  const repairBlock =
    typeof args.previousTests === "string" && args.previousTests.trim()
      ? `\nPrevious invalid test suite:\n${args.previousTests}\n${args.errorMessage ? `Failure reason:\n${args.errorMessage}\n` : ""}`
      : "";

  const user = `
Create the test artifact for this slot.

Language: ${slot.language}
Difficulty: ${slot.difficulty}
Topics: ${slot.topics.join(", ")}
Problem style: ${slot.problem_style}
Constraints: ${slot.constraints}

Title: ${skeleton.title}
Description:
${skeleton.description}

Samples:
${skeleton.sample_inputs.map((input, index) => `- Input ${index + 1}: ${input}\n  Output ${skeleton.sample_outputs[index] ?? ""}`).join("\n")}
${repairBlock}

${buildLanguageInstructions(slot)}
`.trim();

  const completion = await createCodemmCompletion({
    system,
    user,
    role: "tests",
    attempt: args.attempt,
    temperature: 0.15,
    maxTokens: 2600,
  });
  const raw = completion.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  const parsed = tryParseJson(raw) as { test_suite?: unknown } | null;
  const testSuite = typeof parsed?.test_suite === "string" ? parsed.test_suite.trim() : "";
  if (!testSuite || !validateTestSuite(slot, testSuite)) {
    const error = new Error(`Test suite validation failed for ${slot.language}: ${diagnoseTestSuite(slot, testSuite)}`);
    (error as Error & { testSuite?: string }).testSuite = testSuite || raw.slice(0, 4000);
    throw error;
  }
  return {
    value: { test_suite: testSuite },
    ...(completion.meta ? { llm: completion.meta as CompletionMeta } : {}),
    llmOutputHash: sha256(raw),
    promptTemplateId: TESTS_PROMPT_TEMPLATE_ID,
    artifactHash: sha256(testSuite),
  };
}
