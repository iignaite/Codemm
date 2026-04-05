import crypto from "crypto";
import { createCodemmCompletion, type CompletionMeta } from "../../infra/llm";
import type { SlotSkeleton, SlotStageResult, SlotTests } from "../../contracts/slotPipeline";
import type { ProblemSlot } from "../../planner/types";
import { isValidCppTestSuite } from "../../languages/cpp/rules";
import { isValidJUnit5TestSuiteCountRange } from "../../languages/java/rules";
import { isValidPytestTestSuiteForStyle } from "../../languages/python/rules";
import { isValidSqlTestSuite } from "../../languages/sql/rules";
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
        ? "Each test must call solve(...), then assert on capsys.readouterr().out."
        : style === "mixed"
          ? "Each test must assert solve(...) == expected and assert on captured stdout."
          : "Each test must assert solve(...) == expected.",
      "Do not print in tests. Do not use randomness.",
    ].join("\n");
  }
  if (slot.language === "cpp") {
    return [
      "Return JSON: {\"test_suite\":\"...\"}.",
      "Include #include \"solution.cpp\" and define main().",
      "Use the RUN_TEST variadic macro and exactly 8 cases named test_case_1..test_case_8.",
      style === "stdout"
        ? "Capture std::cout output and assert on printed output."
        : style === "mixed"
          ? "Assert both returned values and captured std::cout output."
          : "Assert returned values only.",
      "Tests must print [PASS]/[FAIL] lines.",
    ].join("\n");
  }
  return [
    "Return JSON: {\"test_suite\":\"...\"}.",
    "Produce valid JSON for the SQL suite schema with schema_sql and exactly 8 cases named test_case_1..test_case_8.",
    "Each case must define seed_sql and expected columns/rows.",
  ].join("\n");
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
    throw new Error(`Test suite validation failed for ${slot.language}.`);
  }
  return {
    value: { test_suite: testSuite },
    ...(completion.meta ? { llm: completion.meta as CompletionMeta } : {}),
    llmOutputHash: sha256(raw),
    promptTemplateId: TESTS_PROMPT_TEMPLATE_ID,
    artifactHash: sha256(testSuite),
  };
}
