import crypto from "crypto";
import { createCodemmCompletion } from "../infra/llm";
import type { CompletionMeta } from "../infra/llm";
import { tryParseJson } from "../utils/jsonParser";
import { buildDefaultClassSkeleton, inferClassName } from "../utils/javaCodegen";
import {
  hasBrittleWhitespaceStringExpectations,
  isValidJUnit5TestSuite,
  javaTestSuiteCapturesStdout,
  javaTestSuiteSetsStdin,
} from "../languages/java/rules";
import { assertJavaStructuralTopicRequirements } from "../languages/java/structuralTopics";
import { diagnoseCppTestSuite, hasCppStdoutWrites, looksLikeCppTestSuiteCapturesStdout } from "../languages/cpp/rules";
import { hasPythonStdoutWrites, isValidPytestTestSuiteForStyle } from "../languages/python/rules";
import { GeneratedProblemDraftSchema, type GeneratedProblemDraft } from "../contracts/problem";
import type { ProblemSlot } from "../planner/types";
import { buildSlotPromptWithContext, getSystemPromptForSlot } from "./prompts";
import { trace, traceText } from "../utils/trace";
import { GenerationContractError } from "./errors";
import { getTopLevelPublicTypeNames, javaUsesStdout, javaUsesStdin } from "../utils/javaSource";
import type { SlotPromptContext } from "../languages/types";
import { coerceSqlTestSuiteToJsonString } from "../languages/sql/rules";
import { ObligationViolationError, type ObligationId } from "./obligations";
import { demoteExtraTopLevelPublicTypes, promoteOneTopLevelTypeToPublic, rewriteJavaTopLevelPublicClassName } from "../utils/javaRewrite";
import { buildJavaStdinSampleDrivenJUnitTestSuite, computeJavaStdoutSamplesByExecutingReference } from "../languages/java/sampleDrivenTests";

const MAX_TOKENS = 5000;
const TEMPERATURE = 0.3;
const REPAIR_TEMPERATURE = 0.4;

type ProblemStyle = "stdout" | "return" | "mixed";
function normalizeProblemStyle(raw: string): ProblemStyle {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "stdout" || s === "return" || s === "mixed") return s;
  if (s.includes("stdout")) return "stdout";
  if (s.includes("mixed")) return "mixed";
  return "return";
}

function stripCppComments(source: string): string {
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlock.replace(/\/\/.*$/gm, "");
}

function extractCppSolveSignature(referenceSolution: string): string | null {
  const src = String(referenceSolution ?? "");
  if (!src.trim()) return null;

  // Best-effort: match a solve(...) function definition (brace may be on same line).
  const reSameLine =
    /(^|\n)\s*([A-Za-z_][\w:<>\s*&]+?)\s+solve\s*\(([\s\S]*?)\)\s*(?:const\s*)?\{/m;
  const m1 = reSameLine.exec(src);
  const m = m1;
  if (!m) return null;

  const returnType = m[2]?.replace(/\s+/g, " ").trim();
  const params = m[3]?.replace(/\s+/g, " ").trim();
  if (!returnType || params == null) return null;
  return `${returnType} solve(${params})`;
}

function synthesizeCppStarterCodeFromReference(args: { referenceSolution: string; fallbackTopic: string }): string | null {
  const signature = extractCppSolveSignature(args.referenceSolution);
  if (!signature) return null;

  return `#include <bits/stdc++.h>

${signature} {
  // BEGIN STUDENT TODO
  // TODO: Implement the missing core logic (${args.fallbackTopic}).
  // Hint: Use the problem description as your spec.
  // Hint: Let the tests drive edge cases.
  // END STUDENT TODO
  throw std::runtime_error("TODO");
}
`;
}

export const __test__ = {
  stripCppComments,
  extractCppSolveSignature,
  synthesizeCppStarterCodeFromReference,
};

function sanitizeJavaStringLiteralsBoundaryWhitespace(testSuite: string): { testSuite: string; changed: boolean } {
  // Deterministic de-brittling: remove leading/trailing *space/tab* characters in Java string literals.
  // This aligns with `hasBrittleWhitespaceStringExpectations()` (which rejects literals like " Bob ").
  //
  // We intentionally do NOT try to interpret escapes; we only trim literal boundary characters.
  let changed = false;
  const out = String(testSuite ?? "").replace(/"((?:\\.|[^"\\])*)"/g, (_m, inner: string) => {
    const raw = inner ?? "";
    if (!/\S/.test(raw)) return `"${raw}"`; // ignore all-whitespace strings (allowed by rule)
    const trimmed = raw.replace(/^[ \t]+|[ \t]+$/g, "");
    if (trimmed === raw) return `"${raw}"`;
    changed = true;
    return `"${trimmed}"`;
  });
  return { testSuite: out, changed };
}

function summarizeJUnitFailures(output: string): string[] {
  const text = String(output ?? "");
  const lines = text.split(/\r?\n/);
  const out: string[] = [];

  for (const line of lines) {
    const m =
      /^\|\s+.*--\s+([A-Za-z0-9_]+)\([^)]*\)\s+\[X\].*expected:\s*<([^>]*)>\s*but was:\s*<([^>]*)>/i.exec(line) ||
      /^\s*=>.*expected:\s*<([^>]*)>\s*but was:\s*<([^>]*)>/i.exec(line);
    if (!m) continue;
    if (m.length === 4) {
      out.push(`${m[1]}: expected "${m[2]}", got "${m[3]}"`);
    } else if (m.length === 3) {
      out.push(`expected "${m[1]}", got "${m[2]}"`);
    }
    if (out.length >= 10) break;
  }

  // Also surface failing test names even if no expected/actual is shown in-line.
  if (out.length === 0) {
    for (const line of lines) {
      const name = /^\|\s+.*--\s+([A-Za-z0-9_]+)\([^)]*\)\s+\[X\]/.exec(line)?.[1];
      if (name) out.push(`${name}: failed`);
      if (out.length >= 10) break;
    }
  }

  return out;
}

async function repairJavaReferenceSolution(args: {
  slot: ProblemSlot;
  draft: Extract<GeneratedProblemDraft, { language: "java"; reference_solution: string }>;
  errorMessage: string;
  judgeStdout?: string;
  judgeStderr?: string;
  ctx?: SlotPromptContext;
}): Promise<{ reference_solution: string; llmOutputHash: string; llm?: CompletionMeta }> {
  const title = args.draft.title;
  const failures = summarizeJUnitFailures(`${args.judgeStdout ?? ""}\n${args.judgeStderr ?? ""}`);

  const system = `
You are Codemm's Java reference solution repairer.

Your job:
- Fix ONLY the hidden reference_solution so it passes the provided JUnit test_suite.
- Do NOT change the test_suite.
- Do NOT change the problem description/constraints.

Hard rules:
- Java 17, no package declarations.
- reference_solution must declare at most ONE top-level public type.
- Return ONLY valid JSON (no markdown/no prose) with this exact schema:
  { "reference_solution": "..." }
- Encode newlines as "\\n" (single backslash).
`;

  const stdoutSnippet = String(args.judgeStdout ?? "").slice(0, 2400);
  const stderrSnippet = String(args.judgeStderr ?? "").slice(0, 2400);
  const errorMessage = String(args.errorMessage ?? "").slice(0, 800);
  const failureSummary = failures.length ? `\nFailing assertions summary:\n- ${failures.join("\n- ")}\n` : "";

  const user = `
Title: ${title}
Difficulty: ${args.slot.difficulty}
Topics: ${args.slot.topics.join(", ")}
Problem style: ${args.slot.problem_style}
Constraints: ${args.draft.constraints}
${args.ctx?.domain ? `Scenario seed: ${args.ctx.domain}\n` : ""}${args.ctx?.avoidDomains?.length ? `Avoid repeating domains: ${args.ctx.avoidDomains.join(", ")}\n` : ""}${args.ctx?.avoidTitles?.length ? `Avoid reusing titles too similar to: ${args.ctx.avoidTitles.join(" | ")}\n` : ""}

Description:
${args.draft.description}

Starter code (student-facing; keep semantics consistent):
${args.draft.starter_code}

JUnit test_suite (DO NOT CHANGE):
${args.draft.test_suite}
${failureSummary}

Last failure reason:
${errorMessage}

Docker/JUnit output (may be truncated):
STDOUT:
${stdoutSnippet || "(empty)"}

STDERR:
${stderrSnippet || "(empty)"}

Previous reference_solution (you must change it to make tests pass):
${args.draft.reference_solution}

Return JSON: {"reference_solution":"..."} only.
`;

  const completion = await createCodemmCompletion({
    system,
    user,
    temperature: REPAIR_TEMPERATURE,
    maxTokens: MAX_TOKENS,
  });

  const text = completion.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  const llmOutputHash = sha256(text);
  const parsed = tryParseJson(text) as any;
  const repaired = typeof parsed?.reference_solution === "string" ? parsed.reference_solution.trim() : "";
  if (!repaired) throw new Error("Java reference_solution repair failed: missing reference_solution.");
  return { reference_solution: repaired, llmOutputHash, ...(completion.meta ? { llm: completion.meta } : {}) };
}

export type RepairContext = {
  previousDraft?: GeneratedProblemDraft;
  previousRaw?: string;
  errorMessage?: string;
  judgeStdout?: string;
  judgeStderr?: string;
};

export type GeneratedDraftWithMeta = {
  draft: GeneratedProblemDraft;
  meta: { llmOutputHash: string; llm?: CompletionMeta; rewrites?: Array<{ id: string; applied: boolean; detail?: string }> };
};

async function repairCppTestSuite(args: {
  slot: ProblemSlot;
  title: string;
  description: string;
  constraints: string;
  starterCode: string;
  referenceSolution: string;
  previousTestSuite: string;
  errorMessage: string;
}): Promise<string> {
  const style = normalizeProblemStyle(args.slot.problem_style);
  const system = `
You are Codemm's C++ test suite repairer.

Your job:
- Produce a VALID C++20 test.cpp for a problem, using the required harness.
- The test suite MUST compile against solution.cpp and MUST be deterministic.

Hard rules:
- Return ONLY valid JSON (no markdown, no code fences, no prose)
- Output schema: { "test_suite": "..." }
- test_suite must be based on this exact template (copy/paste; only edit inside the TODO blocks):
  #include <bits/stdc++.h>
  #include "solution.cpp"

  static int __codem_failures = 0;
  #define RUN_TEST(name, ...) do { \\
    try { __VA_ARGS__; std::cout << "[PASS] " << (name) << "\\\\n"; } \\
    catch (const std::exception&) { std::cout << "[FAIL] " << (name) << "\\\\n"; __codem_failures++; } \\
    catch (...) { std::cout << "[FAIL] " << (name) << "\\\\n"; __codem_failures++; } \\
  } while (0)

  int main() {
    RUN_TEST("test_case_1", { /* TODO */ });
    RUN_TEST("test_case_2", { /* TODO */ });
    RUN_TEST("test_case_3", { /* TODO */ });
    RUN_TEST("test_case_4", { /* TODO */ });
    RUN_TEST("test_case_5", { /* TODO */ });
    RUN_TEST("test_case_6", { /* TODO */ });
    RUN_TEST("test_case_7", { /* TODO */ });
    RUN_TEST("test_case_8", { /* TODO */ });
    return __codem_failures ? 1 : 0;
  }

Additional rules:
- Each TODO block must contain deterministic assertions (use std::runtime_error on failure).
- Problem style for this activity is "${style}":
  - return: tests should call solve(...) and compare returned values.
  - stdout: tests should call solve(...), capture std::cout output (redirect rdbuf), and compare printed output.
  - mixed: tests should compare BOTH the returned value and captured std::cout output.
`.trim();

  const user = `
Slot:
${JSON.stringify({ difficulty: args.slot.difficulty, topics: args.slot.topics, style: args.slot.problem_style })}

Title:
${args.title}

Description:
${args.description}

Constraints:
${args.constraints}

Starter code (learner edits):
${args.starterCode}

Reference solution (must pass all tests):
${args.referenceSolution}

Previous invalid test_suite:
${args.previousTestSuite}

Error:
${args.errorMessage}

Return JSON: {"test_suite":"..."} only.
`.trim();

  const completion = await createCodemmCompletion({
    system,
    user,
    temperature: 0.2,
    maxTokens: 2400,
  });

  const text = completion.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  traceText("generation.cpp.testSuite.repair.raw", text, { extra: { slotIndex: args.slot.index } });
  const parsed = tryParseJson(text) as any;
  const repaired = typeof parsed?.test_suite === "string" ? parsed.test_suite.trim() : "";
  if (!repaired) throw new Error("C++ test_suite repair failed: missing test_suite.");
  return repaired;
}

async function repairPythonTestSuite(args: {
  slot: ProblemSlot;
  title: string;
  description: string;
  constraints: string;
  starterCode: string;
  referenceSolution: string;
  previousTestSuite: string;
  errorMessage: string;
}): Promise<string> {
  const style = normalizeProblemStyle(args.slot.problem_style);
  const system = `
You are Codemm's Python pytest test suite repairer.

Your job:
- Produce a VALID pytest test suite for the given problem.
- The suite MUST be deterministic and MUST pass against the provided reference_solution.

Hard rules:
- Return ONLY valid JSON (no markdown, no code fences, no prose)
- Output schema: { "test_suite": "..." }
- Python 3.11, pytest
- test_suite MUST start with:
  import pytest
  from solution import solve
- Exactly 8 tests named: test_case_1 ... test_case_8
- Tests MUST NOT use input(), print(), open(), randomness, or pytest.approx

Problem style for this activity is "${style}":
- return: each test must assert solve(...) == expected
- stdout: each test must call solve(...), then use capsys.readouterr() and assert on captured.out
- mixed: each test must assert solve(...) == expected AND assert captured.out (after calling solve)
`.trim();

  const user = `
Slot:
${JSON.stringify({ difficulty: args.slot.difficulty, topics: args.slot.topics, style: args.slot.problem_style })}

Title:
${args.title}

Description:
${args.description}

Constraints:
${args.constraints}

Starter code (learner edits):
${args.starterCode}

Reference solution (must pass all tests):
${args.referenceSolution}

Previous invalid test_suite:
${args.previousTestSuite}

Error:
${args.errorMessage}

Return JSON: {"test_suite":"..."} only.
`.trim();

  const completion = await createCodemmCompletion({
    system,
    user,
    temperature: 0,
    maxTokens: 2000,
  });

  const text = completion.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  traceText("generation.python.testSuite.repair.raw", text, { extra: { slotIndex: args.slot.index } });
  const parsed = tryParseJson(text) as any;
  const repaired = typeof parsed?.test_suite === "string" ? parsed.test_suite.trim() : "";
  if (!repaired) throw new Error("Python test_suite repair failed: missing test_suite.");
  return repaired;
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function coerceNonEmptySamplePairs(
  raw: any,
  fallbackLabel: string
): { sampleInputs: string[]; sampleOutputs: string[]; changed: boolean } {
  const placeholder = "(see problem description)";
  const rawInputs = Array.isArray(raw?.sample_inputs) ? raw.sample_inputs : [];
  const rawOutputs = Array.isArray(raw?.sample_outputs) ? raw.sample_outputs : [];

  const inputs = rawInputs
    .map((x: any) => String(x ?? "").trim())
    .filter(Boolean)
    .slice(0, 10);
  const outputs = rawOutputs
    .map((x: any) => String(x ?? "").trim())
    .filter(Boolean)
    .slice(0, 10);

  let nextInputs = inputs;
  let nextOutputs = outputs;
  let changed = false;

  if (nextInputs.length === 0) {
    nextInputs = [`${fallbackLabel}: ${placeholder}`];
    changed = true;
  }
  if (nextOutputs.length === 0) {
    nextOutputs = [placeholder];
    changed = true;
  }

  if (nextInputs.length !== nextOutputs.length) {
    nextInputs = [nextInputs[0] ?? `${fallbackLabel}: ${placeholder}`];
    nextOutputs = [nextOutputs[0] ?? placeholder];
    changed = true;
  }

  return { sampleInputs: nextInputs, sampleOutputs: nextOutputs, changed };
}

function inferPrimaryClassName(starterCode: string, fallback: string): string {
  const topLevelPublic = getTopLevelPublicTypeNames(starterCode)[0];
  if (topLevelPublic) return topLevelPublic;
  return inferClassName(starterCode, fallback);
}

function mapJavaStructuralTopicErrorToObligationId(message: string): ObligationId | null {
  const m = /Structural topic requirement failed \((polymorphism|inheritance|abstraction|encapsulation|composition)\)/i.exec(
    String(message ?? "")
  );
  const key = m?.[1]?.toLowerCase();
  if (!key) return null;
  return `java.structural_topic.${key}` as ObligationId;
}

function assertJavaLegacyDraftInvariants(slot: ProblemSlot, draft: Extract<GeneratedProblemDraft, { language: "java"; reference_solution: string }>) {
  if (!("starter_code" in draft)) return;

  const starterCode = String((draft as any).starter_code ?? "");
  const testSuite = String((draft as any).test_suite ?? "");
  const referenceSolution = String((draft as any).reference_solution ?? "");

  const starterPublicTypes = getTopLevelPublicTypeNames(starterCode);
  if (starterPublicTypes.length !== 1) {
    throw new Error("starter_code must declare exactly one top-level public type.");
  }
  const className = inferPrimaryClassName(starterCode, `Problem${slot.index + 1}`);

  const expectedTestClassName = `${className}Test`;
  const actualTestClassName = inferPrimaryClassName(testSuite, expectedTestClassName);
  if (actualTestClassName !== expectedTestClassName) {
    throw new Error(`Test suite class name "${actualTestClassName}" must match "${expectedTestClassName}".`);
  }

  if (/^\s*package\s+/m.test(referenceSolution)) {
    throw new Error(`reference_solution for slot ${slot.index} contains package declaration.`);
  }
  const refPublicTypes = getTopLevelPublicTypeNames(referenceSolution);
  if (refPublicTypes.length !== 1) {
    throw new Error("reference_solution must declare exactly one top-level public type.");
  }
  const refClassName = inferPrimaryClassName(referenceSolution, "");
  if (refClassName !== className) {
    throw new Error(
      `reference_solution class name "${refClassName}" does not match starter_code class name "${className}".`
    );
  }

  // Avoid pathological patterns that are guaranteed to fail compilation.
  if (/\bwhile\s*\(\s*false\s*\)\s*\{?/.test(referenceSolution)) {
    throw new Error('reference_solution must not include "while(false)" (unreachable statement).');
  }
}

function hasJavaMainMethod(source: string): boolean {
  const s = String(source ?? "");
  const withoutBlockComments = s.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLineComments = withoutBlockComments.replace(/\/\/.*$/gm, "");
  return /public\s+static\s+void\s+main\s*\(\s*(?:final\s+)?String\s*(?:(?:\[\s*\]|\.\.\.)\s*\w+|\w+\s*\[\s*\])\s*\)/.test(
    withoutLineComments
  );
}

function hasJavaStructuralTopics(topics: string[]): boolean {
  const lower = topics.map((t) => String(t ?? "").toLowerCase());
  const keys = ["polymorphism", "inheritance", "abstraction", "encapsulation", "composition"];
  return keys.some((k) => lower.some((t) => t.includes(k)));
}

function assertJavaFilenameMatchesPublicClass(filename: string, source: string) {
  const publicType = getTopLevelPublicTypeNames(source)[0];
  if (!publicType) return; // no public top-level type is okay
  const expected = filename.replace(/\.java$/i, "");
  if (publicType !== expected) {
    throw new Error(`Public type "${publicType}" must match filename "${filename}".`);
  }
}

function getWorkspaceTargetFile(draft: any): { path: string; role: string; content: string } | null {
  const files = draft?.workspace?.files;
  if (!Array.isArray(files) || files.length === 0) return null;
  const nonEntry = files.find((f: any) => f && typeof f === "object" && f.role !== "entry");
  return (nonEntry ?? files[0]) as any;
}

function buildJavaRepairPrompt(slot: ProblemSlot, repair: RepairContext, ctx?: SlotPromptContext): string {
  const previousJson =
    repair.previousDraft != null ? JSON.stringify(repair.previousDraft, null, 2) : null;
  const stdoutSnippet = (repair.judgeStdout ?? "").slice(0, 1600);
  const stderrSnippet = (repair.judgeStderr ?? "").slice(0, 1600);
  const rawSnippet = (repair.previousRaw ?? "").slice(0, 2400);
  const errorMessage = (repair.errorMessage ?? "").slice(0, 600);
  const isContractRepair = !repair.previousDraft && !stdoutSnippet && !stderrSnippet;

  if (isContractRepair) {
    return `You previously generated a problem JSON for this slot, but it FAILED deterministic validation (before any Docker/JUnit run).

Slot requirements:
- Difficulty: ${slot.difficulty}
- Topics: ${slot.topics.join(", ")}
- Problem style: ${slot.problem_style}
- Constraints: ${slot.constraints}
- Java 17, no package declarations
- test_suite must have exactly 8 @Test methods (JUnit 5)
${ctx?.domain ? `\nScenario seed: ${ctx.domain}\n` : ""}
${ctx?.avoidDomains?.length ? `Avoid repeating domains: ${ctx.avoidDomains.join(", ")}\n` : ""}
${ctx?.avoidTitles?.length ? `Avoid reusing titles too similar to: ${ctx.avoidTitles.join(" | ")}\n` : ""}

Validation failure reason:
${errorMessage || "(not provided)"}

Hard structure rules (do not violate):
- Return ONLY valid JSON (no markdown, no code fences, no prose).
- If using legacy fields: starter_code + reference_solution must be valid Java 17 with no package declarations.
- If using workspace fields: workspace + reference_workspace must be valid Java 17 with no package declarations, and reference_workspace must include the same file paths as workspace.
- Each Java file must not declare more than one public class.
- Keep exactly 8 @Test methods.
- If asserting on strings, do NOT use assertEquals() with string literals that have leading/trailing spaces. If whitespace behavior matters, normalize the actual value first (e.g. actual.trim()).

Here is your previous output (may be truncated):
${rawSnippet || "(not provided)"}

Goal:
- Return corrected JSON with the exact same fields.
- Keep id/title/description/starter_code stable when possible.
- Fix test_suite structure and/or brittle assertions to satisfy validation.

Return ONLY valid JSON. No markdown. No code fences. No prose.`;
  }

  const failedArtifact = repair.previousDraft
    ? ("reference_workspace" in repair.previousDraft ? "reference_workspace" : "reference_solution")
    : "reference_solution";

  return `You previously generated a problem JSON for this slot, but the ${failedArtifact} FAILED when executed against the test_suite in Docker/JUnit.

Slot requirements:
- Difficulty: ${slot.difficulty}
- Topics: ${slot.topics.join(", ")}
- Problem style: ${slot.problem_style}
- Constraints: ${slot.constraints}
- Java 17, no package declarations
- test_suite must have exactly 8 @Test methods (JUnit 5)
${ctx?.domain ? `\nScenario seed: ${ctx.domain}\n` : ""}
${ctx?.avoidDomains?.length ? `Avoid repeating domains: ${ctx.avoidDomains.join(", ")}\n` : ""}
${ctx?.avoidTitles?.length ? `Avoid reusing titles too similar to: ${ctx.avoidTitles.join(" | ")}\n` : ""}

Failure output (may include the real assertion failure):
STDOUT:
${stdoutSnippet || "(empty)"}

STDERR:
${stderrSnippet || "(empty)"}

Error reason:
${errorMessage || "(not provided)"}

Hard structure rules (do not violate):
- If using legacy fields: starter_code + reference_solution must be valid Java 17 with no package declarations.
- If using workspace fields: workspace + reference_workspace must be valid Java 17 with no package declarations, and reference_workspace must include the same file paths as workspace.
- Each Java file must not declare more than one public class.
- Keep exactly 8 @Test methods.
- Avoid brittle whitespace expectations like assertEquals(" Bob  White ", ...) unless the problem explicitly specifies whitespace behavior.

Here is your previous output (may be truncated):
${rawSnippet || "(not provided)"}

Here is your previous JSON (preferred to edit if present):
${previousJson || "(not provided)"}

Goal:
- Return corrected JSON with the exact same fields.
- Prefer keeping id/title/description/starter_code stable.
- Prefer fixing the reference solution artifact to satisfy the existing tests.
- Only change test_suite if it is clearly inconsistent with the description or contains an obvious mistake; otherwise keep tests stable.
- The final test_suite + reference artifact MUST compile and MUST pass in Docker/JUnit.
- Keep tests meaningful (no trivial assertions).

Return ONLY valid JSON. No markdown. No code fences. No prose.`;
}

function buildPythonRepairPrompt(slot: ProblemSlot, repair: RepairContext, ctx?: SlotPromptContext): string {
  const previousJson =
    repair.previousDraft != null ? JSON.stringify(repair.previousDraft, null, 2) : null;
  const stdoutSnippet = (repair.judgeStdout ?? "").slice(0, 1600);
  const stderrSnippet = (repair.judgeStderr ?? "").slice(0, 1600);
  const rawSnippet = (repair.previousRaw ?? "").slice(0, 2400);
  const errorMessage = (repair.errorMessage ?? "").slice(0, 600);

  return `You previously generated a problem JSON for this slot, but the reference_solution FAILED when executed against the test_suite in Docker/pytest.

Slot requirements:
- Difficulty: ${slot.difficulty}
- Topics: ${slot.topics.join(", ")}
- Problem style: ${slot.problem_style}
- Constraints: ${slot.constraints}
- Python 3.11
- test_suite must use pytest and define exactly 8 tests named test_case_1..test_case_8

${ctx?.domain ? `\nScenario seed: ${ctx.domain}\n` : ""}
${ctx?.avoidDomains?.length ? `Avoid repeating domains: ${ctx.avoidDomains.join(", ")}\n` : ""}
${ctx?.avoidTitles?.length ? `Avoid reusing titles too similar to: ${ctx.avoidTitles.join(" | ")}\n` : ""}

Failure output:
STDOUT:
${stdoutSnippet || "(empty)"}

STDERR:
${stderrSnippet || "(empty)"}

Error reason:
${errorMessage || "(not provided)"}

Hard structure rules (do not violate):
- starter_code and reference_solution must define solve(...)
- solve(...) must NOT read from stdin (no input(), no sys.stdin.*) and must not use networking or randomness
- For problem_style=return: solve(...) must NOT print; tests must assert solve(...) == expected
- For problem_style=stdout: solve(...) should print the answer; tests must capture stdout via capsys and assert on captured.out
- For problem_style=mixed: solve(...) should return the answer AND print it; tests must assert both return and captured.out
- test_suite must import solve via: from solution import solve
- No print-based tests, no randomness, no pytest.approx
- Keep exactly 8 tests: test_case_1..test_case_8

Here is your previous output (may be truncated):
${rawSnippet || "(not provided)"}

Here is your previous JSON (preferred to edit if present):
${previousJson || "(not provided)"}

Goal:
- Return corrected JSON with the exact same fields.
- Prefer keeping id/title/description/starter_code stable.
- You MAY update test_suite and/or reference_solution, but the final pair MUST pass in Docker/pytest.

Return ONLY valid JSON. No markdown. No code fences. No prose.`;
}

function buildCppRepairPrompt(slot: ProblemSlot, repair: RepairContext, ctx?: SlotPromptContext): string {
  const previousJson =
    repair.previousDraft != null ? JSON.stringify(repair.previousDraft, null, 2) : null;
  const stdoutSnippet = (repair.judgeStdout ?? "").slice(0, 1600);
  const stderrSnippet = (repair.judgeStderr ?? "").slice(0, 1600);
  const rawSnippet = (repair.previousRaw ?? "").slice(0, 2400);
  const errorMessage = (repair.errorMessage ?? "").slice(0, 600);

  return `You previously generated a problem JSON for this slot, but the reference_solution FAILED when executed against the test_suite in Docker/g++.

Slot requirements:
- Difficulty: ${slot.difficulty}
- Topics: ${slot.topics.join(", ")}
- Problem style: ${slot.problem_style}
- Constraints: ${slot.constraints}
- C++20 (g++)
- test_suite must include exactly 8 RUN_TEST("test_case_1".. "test_case_8", ...) tests

${ctx?.domain ? `\nScenario seed: ${ctx.domain}\n` : ""}
${ctx?.avoidDomains?.length ? `Avoid repeating domains: ${ctx.avoidDomains.join(", ")}\n` : ""}
${ctx?.avoidTitles?.length ? `Avoid reusing titles too similar to: ${ctx.avoidTitles.join(" | ")}\n` : ""}

Failure output:
STDOUT:
${stdoutSnippet || "(empty)"}

STDERR:
${stderrSnippet || "(empty)"}

Error reason:
${errorMessage || "(not provided)"}

Hard structure rules (do not violate):
- starter_code and reference_solution must define solve(...) (no main())
- test_suite must #include "solution.cpp" and define main()
- Keep exactly 8 tests: test_case_1..test_case_8 using RUN_TEST("test_case_N", { ... })
- IMPORTANT: RUN_TEST must be a VARIADIC macro: #define RUN_TEST(name, ...) ... __VA_ARGS__ ...
  (otherwise commas inside test blocks break compilation)
- Tests must be deterministic.
- solve(...) must NOT read from stdin (no cin/scanf/getline/etc).
- For problem_style=return: tests should compare returned values (no output capture).
- For problem_style=stdout: tests should capture std::cout output (redirect rdbuf) and compare printed output.
- For problem_style=mixed: tests should compare BOTH the returned value and captured std::cout output.
- Tests must print one line per test: [PASS] test_case_N or [FAIL] test_case_N

Here is your previous output (may be truncated):
${rawSnippet || "(not provided)"}

Here is your previous JSON (preferred to edit if present):
${previousJson || "(not provided)"}

Goal:
- Return corrected JSON with the exact same fields.
- Prefer keeping id/title/description/starter_code stable.
- You MAY update test_suite and/or reference_solution, but the final pair MUST pass in Docker/g++.

Return ONLY valid JSON. No markdown. No code fences. No prose.`;
}

function buildSqlRepairPrompt(slot: ProblemSlot, repair: RepairContext, ctx?: SlotPromptContext): string {
  const previousJson =
    repair.previousDraft != null ? JSON.stringify(repair.previousDraft, null, 2) : null;
  const stdoutSnippet = (repair.judgeStdout ?? "").slice(0, 1600);
  const stderrSnippet = (repair.judgeStderr ?? "").slice(0, 1600);
  const rawSnippet = (repair.previousRaw ?? "").slice(0, 2400);
  const errorMessage = (repair.errorMessage ?? "").slice(0, 600);

  return `You previously generated a problem JSON for this slot, but the reference_solution FAILED when executed against the test_suite in Docker/SQLite.

Slot requirements:
- Difficulty: ${slot.difficulty}
- Topics: ${slot.topics.join(", ")}
- Problem style: ${slot.problem_style}
- Constraints: ${slot.constraints}
- SQLite 3
- test_suite must be valid JSON with schema_sql + exactly 8 cases: test_case_1..test_case_8

${ctx?.domain ? `\nScenario seed: ${ctx.domain}\n` : ""}
${ctx?.avoidDomains?.length ? `Avoid repeating domains: ${ctx.avoidDomains.join(", ")}\n` : ""}
${ctx?.avoidTitles?.length ? `Avoid reusing titles too similar to: ${ctx.avoidTitles.join(" | ")}\n` : ""}

Failure output:
STDOUT:
${stdoutSnippet || "(empty)"}

STDERR:
${stderrSnippet || "(empty)"}

Error reason:
${errorMessage || "(not provided)"}

Hard structure rules (do not violate):
- starter_code and reference_solution must be a single read-only query (WITH/SELECT only)
- test_suite must be valid JSON (not code); include schema_sql + 8 cases
- Each case expected.columns must match actual output column names
- KEY FIX: If "Expected rows" mismatches "Actual rows" by order, you MUST add "ORDER BY" to the query and set "order_matters": true.
- KEY FIX: If "Actual rows" are empty or wrong, check your JOIN/WHERE logic.

Here is your previous output (may be truncated):
${rawSnippet || "(not provided)"}

Here is your previous JSON (preferred to edit if present):
${previousJson || "(not provided)"}

Goal:
- Return corrected JSON with the exact same fields.
- Prefer keeping id/title/description/starter_code stable.
- You MAY update test_suite and/or reference_solution, but the final pair MUST pass in Docker/SQLite.

Return ONLY valid JSON. No markdown. No code fences. No prose.`;
}

function buildRepairPrompt(slot: ProblemSlot, repair: RepairContext, ctx?: SlotPromptContext): string {
  if (slot.language === "python") return buildPythonRepairPrompt(slot, repair, ctx);
  if (slot.language === "cpp") return buildCppRepairPrompt(slot, repair, ctx);
  if (slot.language === "sql") return buildSqlRepairPrompt(slot, repair, ctx);
  return buildJavaRepairPrompt(slot, repair, ctx);
}

/**
 * Generate a single problem for the given slot via one Codex LLM call.
 *
 * Returns GeneratedProblemDraft (includes reference_solution).
 * Validates JSON shape and test suite structure.
 * Does NOT validate reference solution via Docker (that's the next step).
 * Does NOT retry (caller handles retries).
 *
 * Throws on any validation failure.
 */
export async function generateSingleProblem(
  slot: ProblemSlot,
  opts?: { repair?: RepairContext; promptContext?: SlotPromptContext }
): Promise<GeneratedDraftWithMeta> {
  // Validation-time repair: if Docker/JUnit rejected the reference artifact, don't regenerate the entire
  // problem JSON. Repair the reference artifact directly (smaller search space => fewer non-healing loops).
  if (slot.language === "java" && opts?.repair?.previousDraft && "reference_solution" in opts.repair.previousDraft) {
    const prev = opts.repair.previousDraft as Extract<
      GeneratedProblemDraft,
      { language: "java"; reference_solution: string }
    >;
    const { reference_solution, llmOutputHash, llm } = await repairJavaReferenceSolution({
      slot,
      draft: prev,
      errorMessage: opts.repair.errorMessage ?? "reference solution failed Docker validation",
      ...(typeof opts.repair.judgeStdout === "string" ? { judgeStdout: opts.repair.judgeStdout } : {}),
      ...(typeof opts.repair.judgeStderr === "string" ? { judgeStderr: opts.repair.judgeStderr } : {}),
      ...(typeof opts.promptContext !== "undefined" ? { ctx: opts.promptContext } : {}),
    });
    if (reference_solution.trim() === prev.reference_solution.trim()) {
      throw new Error("Java reference_solution repair made no changes.");
    }
    const nextDraft: GeneratedProblemDraft = { ...prev, reference_solution };
    const result = GeneratedProblemDraftSchema.safeParse(nextDraft);
    if (!result.success) {
      const first = result.error.issues[0];
      throw new Error(`Java reference_solution repair produced invalid draft: ${first?.message ?? "unknown error"}`);
    }
    // Ensure repaired draft still satisfies deterministic Java invariants before running Docker again.
    assertJavaLegacyDraftInvariants(slot, result.data as any);
    return { draft: result.data, meta: { llmOutputHash, ...(llm ? { llm } : {}) } };
  }

  const prompt = opts?.repair
    ? buildRepairPrompt(slot, opts.repair, opts.promptContext)
    : buildSlotPromptWithContext(slot, opts?.promptContext);
  trace("generation.slot.start", { slotIndex: slot.index, difficulty: slot.difficulty, repair: Boolean(opts?.repair) });
  traceText("generation.prompt", prompt, { extra: { slotIndex: slot.index, repair: Boolean(opts?.repair) } });

  let llmMeta: CompletionMeta | undefined;
  const completion = await createCodemmCompletion({
    system: getSystemPromptForSlot(slot),
    user: prompt,
    temperature: opts?.repair ? REPAIR_TEMPERATURE : TEMPERATURE,
    maxTokens: MAX_TOKENS,
  });
  llmMeta = completion.meta;

  const text = completion.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
  const llmOutputHash = sha256(text);
  traceText("generation.llm.raw", text, { extra: { slotIndex: slot.index } });

  try {
    // Parse JSON (reuse legacy robust parser)
    const parsed = tryParseJson(text);

    if (!parsed || typeof parsed !== "object") {
      throw new Error("LLM response is not a valid JSON object.");
    }

    // Normalize fields (defensive, same pattern as legacy agent)
    const raw = parsed as any;

    if (slot.language === "python") {
      if (raw.workspace || raw.reference_workspace) {
        throw new Error("Python generation does not support workspace problems yet.");
      }

      const baseId =
        typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : crypto.randomUUID();

      const title =
        typeof raw.title === "string" && raw.title.trim()
          ? raw.title.trim()
          : `Problem for ${slot.topics[0] ?? "Python"}`;

      const description =
        typeof raw.description === "string" && raw.description.trim()
          ? raw.description.trim()
          : `Problem description for ${title}.`;

      let starterCode =
        typeof raw.starter_code === "string" && raw.starter_code.trim() ? raw.starter_code.trim() : "";
      if (!starterCode.trim()) {
        starterCode = "def solve(x):\n    # TODO: implement\n    raise NotImplementedError\n";
      }

      let testSuite =
        typeof raw.test_suite === "string" && raw.test_suite.trim() ? raw.test_suite.trim() : "";
      // Note: if the LLM omitted test_suite (or returned an invalid one), we attempt a one-shot
      // repair later after schema validation.

      const referenceSolution =
        typeof raw.reference_solution === "string" && raw.reference_solution.trim()
          ? raw.reference_solution.trim()
          : "";
      if (!referenceSolution.trim()) {
        throw new Error(`Missing reference_solution for slot ${slot.index}.`);
      }

      const rawConstraints = typeof raw.constraints === "string" ? raw.constraints.trim() : "";
      if (rawConstraints && rawConstraints !== slot.constraints) {
        throw new Error(`Invalid constraints for slot ${slot.index}: must match slot.constraints exactly.`);
      }
      const constraints = slot.constraints;

      const samples = coerceNonEmptySamplePairs(raw, "example input");
      const sampleInputs = samples.sampleInputs;
      const sampleOutputs = samples.sampleOutputs;

      const difficulty = slot.difficulty;
      const topicTag = slot.topics[0] ?? "oop";

      const draft: GeneratedProblemDraft = {
        language: "python",
        id: baseId,
        title,
        description,
        starter_code: starterCode,
        test_suite: testSuite,
        reference_solution: referenceSolution,
        constraints,
        sample_inputs: sampleInputs,
        sample_outputs: sampleOutputs,
        difficulty,
        topic_tag: topicTag,
      };

      let result = GeneratedProblemDraftSchema.safeParse(draft);
      if (!result.success) {
        const testSuiteIssue = result.error.issues.some((i) => i.path?.[0] === "test_suite");
        const otherIssues = result.error.issues.some((i) => i.path?.[0] !== "test_suite");

        // Deterministic self-heal pass: if only test_suite is invalid, ask the LLM to repair it.
        if (testSuiteIssue && !otherIssues) {
          const msg =
            result.error.issues
              .slice(0, 6)
              .map((i) => `${i.path?.length ? i.path.join(".") : "root"}: ${i.message}`)
              .join(" | ") || "unknown error";

          const repairedTestSuite = await repairPythonTestSuite({
            slot,
            title,
            description,
            constraints,
            starterCode,
            referenceSolution,
            previousTestSuite: testSuite,
            errorMessage: msg,
          });
          const repairedDraft: GeneratedProblemDraft = { ...draft, test_suite: repairedTestSuite };
          result = GeneratedProblemDraftSchema.safeParse(repairedDraft);
          if (result.success) {
            trace("generation.python.testSuite.repaired", { slotIndex: slot.index, title });
          } else {
            const firstError = result.error.issues[0];
            throw new Error(
              `Generated problem for slot ${slot.index} failed schema validation after Python test_suite repair: ${firstError?.message ?? "unknown error"}`
            );
          }
        } else {
          const firstError = result.error.issues[0];
          throw new Error(
            `Generated problem for slot ${slot.index} failed schema validation: ${firstError?.message ?? "unknown error"}`
          );
        }
      }

      const style = normalizeProblemStyle(slot.problem_style);
      const parsed = result.data;
      if (!("reference_solution" in parsed)) {
        throw new Error("Internal error: expected Python draft to include reference_solution.");
      }

      if (!isValidPytestTestSuiteForStyle(parsed.test_suite, style, 8)) {
        throw new Error(
          `Invalid test_suite for slot ${slot.index}: does not match problem_style=${style} requirements.`
        );
      }
      if (style === "return") {
        if (hasPythonStdoutWrites(parsed.reference_solution)) {
          throw new Error(
            `Invalid reference_solution for slot ${slot.index}: problem_style=return must not write to stdout (no print/sys.stdout).`
          );
        }
      } else {
        if (!hasPythonStdoutWrites(parsed.reference_solution)) {
          throw new Error(
            `Invalid reference_solution for slot ${slot.index}: problem_style=${style} must write the final answer to stdout (print/sys.stdout).`
          );
        }
      }

      trace("generation.draft.meta", { slotIndex: slot.index, title, language: "python", difficulty, topicTag });
      return { draft: parsed, meta: { llmOutputHash, ...(llmMeta ? { llm: llmMeta } : {}) } };
    }

    if (slot.language === "cpp") {
      if (raw.workspace || raw.reference_workspace) {
        throw new Error("C++ generation does not support workspace problems yet.");
      }

      const baseId =
        typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : crypto.randomUUID();

      const title =
        typeof raw.title === "string" && raw.title.trim()
          ? raw.title.trim()
          : `Problem for ${slot.topics[0] ?? "C++"}`;

      const description =
        typeof raw.description === "string" && raw.description.trim()
          ? raw.description.trim()
          : `Problem description for ${title}.`;

      let starterCode =
        typeof raw.starter_code === "string" && raw.starter_code.trim() ? raw.starter_code.trim() : "";
      if (!starterCode.trim()) {
        starterCode =
          '#include <bits/stdc++.h>\\n\\n// Implement solve(...) below.\\n// Avoid I/O in solve().\\nauto solve(auto x) { (void)x; return 0; }\\n';
      }

      let testSuite =
        typeof raw.test_suite === "string" && raw.test_suite.trim() ? raw.test_suite.trim() : "";
      if (!testSuite.trim()) {
        throw new Error(`Invalid test_suite for slot ${slot.index}: missing.`);
      }

      const referenceSolution =
        typeof raw.reference_solution === "string" && raw.reference_solution.trim()
          ? raw.reference_solution.trim()
          : "";
      if (!referenceSolution.trim()) {
        throw new Error(`Missing reference_solution for slot ${slot.index}.`);
      }

      // Starter code must include a real solve(...) definition (comments don't count).
      // If the model only returned includes + a comment, deterministically synthesize a minimal
      // starter implementation based on the reference_solution signature (without leaking the solution body).
      if (!/\bsolve\s*\(/.test(stripCppComments(starterCode))) {
        const synthesized = synthesizeCppStarterCodeFromReference({
          referenceSolution,
          fallbackTopic: slot.topics[0] ?? "cpp",
        });
        if (synthesized) {
          starterCode = synthesized.trim();
        }
      }

      const rawConstraints = typeof raw.constraints === "string" ? raw.constraints.trim() : "";
      if (rawConstraints && rawConstraints !== slot.constraints) {
        throw new Error(`Invalid constraints for slot ${slot.index}: must match slot.constraints exactly.`);
      }
      const constraints = slot.constraints;

      const samples = coerceNonEmptySamplePairs(raw, "example input");
      const sampleInputs = samples.sampleInputs;
      const sampleOutputs = samples.sampleOutputs;

      const difficulty = slot.difficulty;
      const topicTag = slot.topics[0] ?? "oop";

      const draft: GeneratedProblemDraft = {
        language: "cpp",
        id: baseId,
        title,
        description,
        starter_code: starterCode,
        test_suite: testSuite,
        reference_solution: referenceSolution,
        constraints,
        sample_inputs: sampleInputs,
        sample_outputs: sampleOutputs,
        difficulty,
        topic_tag: topicTag,
      };

      let result = GeneratedProblemDraftSchema.safeParse(draft);
      if (!result.success) {
        const testSuiteIssue = result.error.issues.some((i) => i.path?.[0] === "test_suite");
        const diagnostics = testSuiteIssue ? diagnoseCppTestSuite(draft.test_suite) : undefined;
        if (diagnostics) {
          const maybeIncludeSnippet = process.env.CODEMM_TRACE_TEST_SUITES === "1";
          trace("generation.cpp.testSuite.invalid", {
            slotIndex: slot.index,
            checks: diagnostics,
            ...(maybeIncludeSnippet ? { testSuiteSnippet: draft.test_suite.slice(0, 2000) } : {}),
          });
        }

        const msg =
          result.error.issues
            .slice(0, 6)
            .map((i) => `${i.path?.length ? i.path.join(".") : "root"}: ${i.message}`)
            .join(" | ") || "unknown error";
        const msgWithDiagnostics =
          diagnostics ? `${msg} | cpp_test_suite_checks=${JSON.stringify(diagnostics)}` : msg;

        // One deterministic self-heal pass: if only test_suite is invalid, ask the LLM to repair the test suite
        // (keeps the overall problem stable while enforcing the strict harness contract).
        const failedTestSuite = testSuiteIssue;
        if (failedTestSuite) {
          const repairedTestSuite = await repairCppTestSuite({
            slot,
            title,
            description,
            constraints,
            starterCode,
            referenceSolution,
            previousTestSuite: testSuite,
            errorMessage: msgWithDiagnostics,
          });
          const repairedDraft: GeneratedProblemDraft = { ...draft, test_suite: repairedTestSuite };
          result = GeneratedProblemDraftSchema.safeParse(repairedDraft);
          if (result.success) {
            trace("generation.cpp.testSuite.repaired", { slotIndex: slot.index, title });
          } else {
            const repairedDiagnostics = diagnoseCppTestSuite(repairedTestSuite);
            const maybeIncludeSnippet = process.env.CODEMM_TRACE_TEST_SUITES === "1";
            trace("generation.cpp.testSuite.repair_invalid", {
              slotIndex: slot.index,
              checks: repairedDiagnostics,
              ...(maybeIncludeSnippet ? { testSuiteSnippet: repairedTestSuite.slice(0, 2000) } : {}),
            });

            throw new Error(
              `Generated problem for slot ${slot.index} failed schema validation after C++ test_suite repair: ${msgWithDiagnostics} | repaired_cpp_test_suite_checks=${JSON.stringify(repairedDiagnostics)}`
            );
          }
        }

        if (!result.success) {
          throw new Error(
            `Generated problem for slot ${slot.index} failed schema validation: ${msgWithDiagnostics}`
          );
        }
      }

      trace("generation.draft.meta", { slotIndex: slot.index, title, language: "cpp", difficulty, topicTag });
      const style = normalizeProblemStyle(slot.problem_style);
      const parsed = result.data;
      if (!("reference_solution" in parsed)) {
        throw new Error("Internal error: expected C++ draft to include reference_solution.");
      }
      if (style === "return") {
        if (hasCppStdoutWrites(parsed.reference_solution)) {
          throw new Error(
            `Invalid reference_solution for slot ${slot.index}: problem_style=return must not write to stdout/stderr (no cout/cerr/printf).`
          );
        }
        if (looksLikeCppTestSuiteCapturesStdout(parsed.test_suite)) {
          throw new Error(
            `Invalid test_suite for slot ${slot.index}: problem_style=return should not capture stdout; compare returned values instead.`
          );
        }
      } else {
        if (!hasCppStdoutWrites(parsed.reference_solution)) {
          throw new Error(
            `Invalid reference_solution for slot ${slot.index}: problem_style=${style} must write the final answer to stdout (use std::cout).`
          );
        }
        if (!looksLikeCppTestSuiteCapturesStdout(parsed.test_suite)) {
          throw new Error(
            `Invalid test_suite for slot ${slot.index}: problem_style=${style} must capture std::cout output and assert on it (redirect rdbuf).`
          );
        }
      }
      return { draft: parsed, meta: { llmOutputHash, ...(llmMeta ? { llm: llmMeta } : {}) } };
    }

    if (slot.language === "sql") {
      if (raw.workspace || raw.reference_workspace) {
        throw new Error("SQL generation does not support workspace problems.");
      }

      const baseId =
        typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : crypto.randomUUID();

      const title =
        typeof raw.title === "string" && raw.title.trim()
          ? raw.title.trim()
          : `Problem for ${slot.topics[0] ?? "SQL"}`;

      const description =
        typeof raw.description === "string" && raw.description.trim()
          ? raw.description.trim()
          : `Problem description for ${title}.`;

      let starterCode =
        typeof raw.starter_code === "string" && raw.starter_code.trim() ? raw.starter_code.trim() : "";
      if (!starterCode.trim()) starterCode = "SELECT 1;";

      const testSuite = coerceSqlTestSuiteToJsonString((raw as any).test_suite, 8);
      if (!testSuite.trim()) {
        throw new Error(`Invalid test_suite for slot ${slot.index}: missing.`);
      }

      const referenceSolution =
        typeof raw.reference_solution === "string" && raw.reference_solution.trim()
          ? raw.reference_solution.trim()
          : "";
      if (!referenceSolution.trim()) {
        throw new Error(`Missing reference_solution for slot ${slot.index}.`);
      }

      const rawConstraints = typeof raw.constraints === "string" ? raw.constraints.trim() : "";
      if (rawConstraints && rawConstraints !== slot.constraints) {
        throw new Error(`Invalid constraints for slot ${slot.index}: must match slot.constraints exactly.`);
      }
      const constraints = slot.constraints;

      const samples = coerceNonEmptySamplePairs(raw, "example input");
      const sampleInputs = samples.sampleInputs;
      const sampleOutputs = samples.sampleOutputs;

      const difficulty = slot.difficulty;
      const topicTag = slot.topics[0] ?? "oop";

      const draft: GeneratedProblemDraft = {
        language: "sql",
        id: baseId,
        title,
        description,
        starter_code: starterCode,
        test_suite: testSuite,
        reference_solution: referenceSolution,
        constraints,
        sample_inputs: sampleInputs,
        sample_outputs: sampleOutputs,
        difficulty,
        topic_tag: topicTag,
      };

      const result = GeneratedProblemDraftSchema.safeParse(draft);
      if (!result.success) {
        const firstError = result.error.issues[0];
        throw new Error(
          `Generated problem for slot ${slot.index} failed schema validation: ${firstError?.message ?? "unknown error"}`
        );
      }

      trace("generation.draft.meta", { slotIndex: slot.index, title, language: "sql", difficulty, topicTag });
      return { draft: result.data, meta: { llmOutputHash, ...(llmMeta ? { llm: llmMeta } : {}) } };
    }

    // Workspace variant (Phase B): accept workspace + reference_workspace.
    if (raw.workspace && raw.reference_workspace) {
      const rewrites: Array<{ id: string; applied: boolean; detail?: string }> = [];
      const title =
        typeof raw.title === "string" && raw.title.trim()
          ? raw.title.trim()
          : `Problem for ${slot.topics[0] ?? "Java"}`;

      const description =
        typeof raw.description === "string" && raw.description.trim()
          ? raw.description.trim()
          : `Problem description for ${title}.`;

      let testSuite =
        typeof raw.test_suite === "string" && raw.test_suite.trim() ? raw.test_suite.trim() : "";
      if (!isValidJUnit5TestSuite(testSuite, 8)) {
        throw new Error(
          `Invalid test_suite for slot ${slot.index}: must have exactly 8 @Test methods, JUnit 5 imports, no package, and non-trivial assertions.`
        );
      }
      if (hasBrittleWhitespaceStringExpectations(testSuite)) {
        const sanitized = sanitizeJavaStringLiteralsBoundaryWhitespace(testSuite);
        if (sanitized.changed && !hasBrittleWhitespaceStringExpectations(sanitized.testSuite)) {
          // Deterministically de-brittle common whitespace patterns rather than wasting an LLM retry.
          // This is safe because (by policy) whitespace behavior is not intended to be the core of the task.
          // If a whitespace-specific problem is ever desired, it must be explicitly specified in the prompt/template.
          testSuite = sanitized.testSuite;
        } else {
          throw new Error(
            `Invalid test_suite for slot ${slot.index}: avoid assertEquals() against string literals with leading/trailing whitespace (brittle).`
          );
        }
      }

      const target = getWorkspaceTargetFile(raw);
      if (!target || typeof target.path !== "string") {
        throw new Error("workspace must include at least one file.");
      }

      const targetClassName = target.path.replace(/\.java$/i, "");
      const expectedTestClassName = `${targetClassName}Test`;
      {
        const renamed = rewriteJavaTopLevelPublicClassName({ source: testSuite, expectedName: expectedTestClassName });
        if (renamed.changed) {
          testSuite = renamed.source;
          rewrites.push({
            id: "java.rename_test_class",
            applied: true,
            detail: `Renamed public test class "${renamed.previousName}" -> "${expectedTestClassName}".`,
          });
        }
        const actualTestClassName = inferPrimaryClassName(testSuite, expectedTestClassName);
        if (actualTestClassName !== expectedTestClassName) {
          throw new ObligationViolationError(
            `Test suite class name "${actualTestClassName}" must match "${expectedTestClassName}".`,
            { obligationId: "java.test_class_matches_target" }
          );
        }
      }

      // Do not require tests to explicitly reference the target type at contract-time.
      // The real guardrail is Docker validation of the reference workspace against the test suite.
      // Overly strict string matching here causes repeated retries without improving correctness.

      // Enforce structural topic requirements for selected Java OOP topics (deterministic, narrow).
      try {
        const refCombined = (raw.reference_workspace.files as any[])
          .filter((f) => f && typeof f.content === "string")
          .map((f) => String(f.content))
          .join("\n\n");
        if (/\bwhile\s*\(\s*false\s*\)\s*\{?/.test(refCombined)) {
          throw new ObligationViolationError('reference workspace must not include "while(false)" (unreachable).', {
            obligationId: "java.no_while_false",
          });
        }
        assertJavaStructuralTopicRequirements({
          topics: slot.topics,
          referenceSource: refCombined,
          testSuite,
        });
      } catch (e: any) {
        if (e instanceof ObligationViolationError) throw e;
        const innerMsg = e?.message ?? String(e);
        const mapped = mapJavaStructuralTopicErrorToObligationId(innerMsg);
        const fallback: ObligationId =
          (slot.topics.some((t) => String(t).toLowerCase().includes("inheritance")) && "java.structural_topic.inheritance") ||
          (slot.topics.some((t) => String(t).toLowerCase().includes("abstraction")) && "java.structural_topic.abstraction") ||
          (slot.topics.some((t) => String(t).toLowerCase().includes("encapsulation")) && "java.structural_topic.encapsulation") ||
          (slot.topics.some((t) => String(t).toLowerCase().includes("composition")) && "java.structural_topic.composition") ||
          "java.structural_topic.polymorphism";
        throw new ObligationViolationError(
          `Java topic structure validation failed for slot ${slot.index}: ${innerMsg}`,
          { obligationId: mapped ?? fallback }
        );
      }

      // stdout-only enforcement: reference + tests must be output-driven (not return-only).
      if (!javaUsesStdout((raw.reference_workspace.files as any[]).map((f: any) => String(f?.content ?? "")).join("\n\n"))) {
        throw new ObligationViolationError(
          "For stdout-style Java problems, reference solution must write the final answer to stdout (System.out.print/println/printf).",
          { obligationId: "java.stdout_solution_prints" }
        );
      }
      if (!javaTestSuiteCapturesStdout(testSuite)) {
        throw new ObligationViolationError(
          "For stdout-style Java problems, test_suite must capture stdout and assert on the printed output.",
          { obligationId: "java.stdout_tests_capture" }
        );
      }

      // Ensure file constraints: at most one public class per file + filename matches public class.
      for (const file of raw.workspace.files as any[]) {
        if (!file || typeof file.path !== "string" || typeof file.content !== "string") continue;
        const keep = String(file.path).replace(/\.java$/i, "");
        const rewritten = demoteExtraTopLevelPublicTypes(file.content, { keepName: keep });
        if (rewritten.changed) {
          file.content = rewritten.source;
          rewrites.push({
            id: "java.demote_extra_public_types",
            applied: true,
            detail: `Demoted extra public types in "${file.path}".`,
          });
        }
        if (getTopLevelPublicTypeNames(file.content).length > 1) {
          throw new ObligationViolationError(`File "${file.path}" must not declare more than one top-level public type.`, {
            obligationId: "java.single_public_type_per_unit",
          });
        }
        assertJavaFilenameMatchesPublicClass(file.path, file.content);
      }

      for (const file of raw.reference_workspace.files as any[]) {
        if (!file || typeof file.path !== "string" || typeof file.content !== "string") continue;
        const keep = String(file.path).replace(/\.java$/i, "");
        const rewritten = demoteExtraTopLevelPublicTypes(file.content, { keepName: keep });
        if (rewritten.changed) {
          file.content = rewritten.source;
          rewrites.push({
            id: "java.demote_extra_public_types",
            applied: true,
            detail: `Demoted extra public types in "${file.path}".`,
          });
        }
        if (getTopLevelPublicTypeNames(file.content).length > 1) {
          throw new ObligationViolationError(`File "${file.path}" must not declare more than one top-level public type.`, {
            obligationId: "java.single_public_type_per_unit",
          });
        }
        assertJavaFilenameMatchesPublicClass(file.path, file.content);
      }

      // Ensure reference workspace has same file paths.
      const studentPaths = new Set((raw.workspace.files as any[]).map((f) => String(f.path)));
      const refPaths = new Set((raw.reference_workspace.files as any[]).map((f) => String(f.path)));
      if (studentPaths.size !== refPaths.size) {
        throw new Error("reference_workspace must include the same file paths as workspace.");
      }
      for (const p of studentPaths) {
        if (!refPaths.has(p)) {
          throw new Error("reference_workspace must include the same file paths as workspace.");
        }
      }

      const rawConstraints = typeof raw.constraints === "string" ? raw.constraints.trim() : "";
      if (rawConstraints && rawConstraints !== slot.constraints) {
        throw new Error(`Invalid constraints for slot ${slot.index}: must match slot.constraints exactly.`);
      }
      const constraints = slot.constraints;

      const samples = coerceNonEmptySamplePairs(raw, "stdin");
      const sampleInputs = samples.sampleInputs;
      const sampleOutputs = samples.sampleOutputs;
      if (samples.changed) {
        rewrites.push({ id: "samples.autofill", applied: true, detail: "Filled missing/mismatched sample_inputs/sample_outputs." });
      }

      const difficulty = slot.difficulty;
      const topicTag = slot.topics[0] ?? "oop";

      const draft: GeneratedProblemDraft = {
        language: "java",
        id:
          typeof raw.id === "string" && raw.id.trim()
            ? raw.id.trim()
            : crypto.randomUUID(),
        title,
        description,
        workspace: raw.workspace,
        reference_workspace: raw.reference_workspace,
        test_suite: testSuite,
        constraints,
        sample_inputs: sampleInputs,
        sample_outputs: sampleOutputs,
        difficulty,
        topic_tag: topicTag,
      };

      const result = GeneratedProblemDraftSchema.safeParse(draft);
      if (!result.success) {
        const firstError = result.error.issues[0];
        throw new Error(
          `Generated problem for slot ${slot.index} failed schema validation: ${firstError?.message ?? "unknown error"}`
        );
      }

      trace("generation.draft.meta", { slotIndex: slot.index, title, className: targetClassName, difficulty, topicTag });
      return { draft: result.data, meta: { llmOutputHash, ...(llmMeta ? { llm: llmMeta } : {}), rewrites } };
    }

    const baseId =
      typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : crypto.randomUUID();

    const title =
      typeof raw.title === "string" && raw.title.trim()
        ? raw.title.trim()
        : `Problem for ${slot.topics[0] ?? "Java"}`;

    const description =
      typeof raw.description === "string" && raw.description.trim()
        ? raw.description.trim()
        : `Problem description for ${title}.`;

    const rewrites: Array<{ id: string; applied: boolean; detail?: string }> = [];

    let starterCode =
      typeof raw.starter_code === "string" && raw.starter_code.trim() ? raw.starter_code.trim() : "";

    {
      const rewritten = demoteExtraTopLevelPublicTypes(starterCode);
      if (rewritten.changed) {
        starterCode = rewritten.source;
        rewrites.push({
          id: "java.demote_extra_public_types",
          applied: true,
          detail: "Demoted extra top-level public types in starter_code.",
        });
      }
    }

    // If starter_code missing or has package, synthesize
    let className = inferPrimaryClassName(starterCode, `Problem${slot.index + 1}`);
    if (!starterCode.trim() || /^\s*package\s+/m.test(starterCode)) {
      starterCode = buildDefaultClassSkeleton(className);
      className = inferPrimaryClassName(starterCode, `Problem${slot.index + 1}`);
    }

    let starterPublicTypes = getTopLevelPublicTypeNames(starterCode);
    if (starterPublicTypes.length > 1) {
      throw new ObligationViolationError("starter_code must not declare more than one top-level public type.", {
        obligationId: "java.single_public_type_per_unit",
      });
    }
    if (starterPublicTypes.length === 0) {
      const promoted = promoteOneTopLevelTypeToPublic(starterCode, { keepName: className });
      if (promoted.changed) {
        starterCode = promoted.source;
        rewrites.push({
          id: "java.promote_public_type",
          applied: true,
          detail: `Promoted top-level type "${promoted.promotedName ?? className}" to public.`,
        });
        starterPublicTypes = getTopLevelPublicTypeNames(starterCode);
      }
    }
    if (starterPublicTypes.length === 0) {
      throw new ObligationViolationError("starter_code must declare exactly one top-level public type.", {
        obligationId: "java.single_public_type_per_unit",
      });
    }

    let testSuite =
      typeof raw.test_suite === "string" && raw.test_suite.trim() ? raw.test_suite.trim() : "";

    let referenceSolution =
      typeof raw.reference_solution === "string" && raw.reference_solution.trim()
        ? raw.reference_solution.trim()
        : "";

    if (!referenceSolution.trim()) {
      throw new Error(`Missing reference_solution for slot ${slot.index}.`);
    }

    {
      const rewritten = demoteExtraTopLevelPublicTypes(referenceSolution, { keepName: className });
      if (rewritten.changed) {
        referenceSolution = rewritten.source;
        rewrites.push({
          id: "java.demote_extra_public_types",
          applied: true,
          detail: "Demoted extra top-level public types in reference_solution.",
        });
      }
    }

    let refPublicTypes = getTopLevelPublicTypeNames(referenceSolution);
    if (refPublicTypes.length > 1) {
      throw new ObligationViolationError("reference_solution must not declare more than one top-level public type.", {
        obligationId: "java.single_public_type_per_unit",
      });
    }
    if (refPublicTypes.length === 0) {
      const promoted = promoteOneTopLevelTypeToPublic(referenceSolution, { keepName: className });
      if (promoted.changed) {
        referenceSolution = promoted.source;
        rewrites.push({
          id: "java.promote_public_type",
          applied: true,
          detail: `Promoted top-level type "${promoted.promotedName ?? className}" to public in reference_solution.`,
        });
        refPublicTypes = getTopLevelPublicTypeNames(referenceSolution);
      }
    }
    if (refPublicTypes.length === 0) {
      throw new ObligationViolationError("reference_solution must declare exactly one top-level public type.", {
        obligationId: "java.single_public_type_per_unit",
      });
    }

    // Ensure reference solution has no package
    if (/^\s*package\s+/m.test(referenceSolution)) {
      throw new Error(`reference_solution for slot ${slot.index} contains package declaration.`);
    }

    // Avoid pathological patterns that are guaranteed to fail compilation.
    if (/\bwhile\s*\(\s*false\s*\)\s*\{?/.test(referenceSolution)) {
      throw new ObligationViolationError('reference_solution must not include "while(false)" (unreachable statement).', {
        obligationId: "java.no_while_false",
      });
    }

    // Ensure reference solution matches class name (prefer public class too)
    const refClassName = inferPrimaryClassName(referenceSolution, "");
    if (refClassName !== className) {
      throw new ObligationViolationError(
        `reference_solution class name "${refClassName}" does not match starter_code class name "${className}".`,
        { obligationId: "java.primary_type_matches_target" }
      );
    }

    // Ensure test class name matches starter_code class name + "Test"
    const expectedTestClassName = `${className}Test`;

    // If the reference solution reads stdin, we either enforce a stdin-aware test suite,
    // or (when no structural topics are required) deterministically derive tests from sample I/O.
    const usesStdin = javaUsesStdin(referenceSolution);
    const requiresStructuralTopics = hasJavaStructuralTopics(slot.topics);
    if (usesStdin && requiresStructuralTopics) {
      throw new ObligationViolationError(
        "stdin reads (Scanner/System.in) are not allowed for Java structural-topic slots (encapsulation/inheritance/polymorphism/etc). Use pure methods and deterministic unit tests instead.",
        { obligationId: "java.stdin_disallowed_for_structural_topics" }
      );
    }

    if (usesStdin && !hasJavaMainMethod(referenceSolution)) {
      throw new ObligationViolationError(
        "stdin-driven Java problems must provide a public static void main(String[] args) entrypoint so tests can execute deterministically.",
        { obligationId: "java.stdin_requires_main" }
      );
    }

    let sampleInputs: string[] | null = null;
    let sampleOutputs: string[] | null = null;

    if (usesStdin) {
      const stdinSamples = Array.isArray((raw as any).sample_inputs)
        ? (raw as any).sample_inputs
            .map((x: any) => String(x ?? "").replace(/\r\n/g, "\n"))
            .filter((x: string) => x.trim().length > 0)
        : [];
      if (stdinSamples.length < 8) {
        throw new ObligationViolationError(
          `stdin-driven Java problems must include at least 8 non-empty sample_inputs (each is a full stdin transcript). Got ${stdinSamples.length}.`,
          { obligationId: "java.stdin_tests_provide" }
        );
      }

      const { stdoutSamples } = await computeJavaStdoutSamplesByExecutingReference({
        referenceSolution,
        stdinSamples,
        maxSamples: 8,
      });

      testSuite = buildJavaStdinSampleDrivenJUnitTestSuite({
        testClassName: expectedTestClassName,
        mainClassName: className,
        cases: Array.from({ length: 8 }, (_, i) => ({
          stdin: stdinSamples[i] ?? "",
          expectedStdout: stdoutSamples[i] ?? "",
        })),
      });

      rewrites.push({
        id: "java.tests.from_samples",
        applied: true,
        detail: "Rebuilt test_suite deterministically from sample_inputs by executing the reference_solution in Docker.",
      });
      sampleInputs = stdinSamples.slice(0, 8);
      sampleOutputs = stdoutSamples.slice(0, 8);
    }

    // Validate test suite structure strictly (after potential deterministic rebuild).
    if (!isValidJUnit5TestSuite(testSuite, 8)) {
      throw new Error(
        `Invalid test_suite for slot ${slot.index}: must have exactly 8 @Test methods, JUnit 5 imports, no package, and non-trivial assertions.`
      );
    }
    if (hasBrittleWhitespaceStringExpectations(testSuite)) {
      const sanitized = sanitizeJavaStringLiteralsBoundaryWhitespace(testSuite);
      if (sanitized.changed && !hasBrittleWhitespaceStringExpectations(sanitized.testSuite)) {
        testSuite = sanitized.testSuite;
      } else {
        throw new Error(
          `Invalid test_suite for slot ${slot.index}: avoid assertEquals() against string literals with leading/trailing whitespace (brittle).`
        );
      }
    }

    {
      const renamed = rewriteJavaTopLevelPublicClassName({ source: testSuite, expectedName: expectedTestClassName });
      if (renamed.changed) {
        testSuite = renamed.source;
        rewrites.push({
          id: "java.rename_test_class",
          applied: true,
          detail: `Renamed public test class "${renamed.previousName}" -> "${expectedTestClassName}".`,
        });
      }
      const actualTestClassName = inferPrimaryClassName(testSuite, expectedTestClassName);
      if (actualTestClassName !== expectedTestClassName) {
        throw new ObligationViolationError(
          `Test suite class name "${actualTestClassName}" must match "${expectedTestClassName}".`,
          { obligationId: "java.test_class_matches_target" }
        );
      }
    }

    // Enforce structural topic requirements for selected Java OOP topics (deterministic, narrow).
    try {
      assertJavaStructuralTopicRequirements({
        topics: slot.topics,
        referenceSource: referenceSolution,
        testSuite,
      });
    } catch (e: any) {
      if (e instanceof ObligationViolationError) throw e;
      const innerMsg = e?.message ?? String(e);
      const mapped = mapJavaStructuralTopicErrorToObligationId(innerMsg);
      const fallback: ObligationId =
        (slot.topics.some((t) => String(t).toLowerCase().includes("inheritance")) && "java.structural_topic.inheritance") ||
        (slot.topics.some((t) => String(t).toLowerCase().includes("abstraction")) && "java.structural_topic.abstraction") ||
        (slot.topics.some((t) => String(t).toLowerCase().includes("encapsulation")) && "java.structural_topic.encapsulation") ||
        (slot.topics.some((t) => String(t).toLowerCase().includes("composition")) && "java.structural_topic.composition") ||
        "java.structural_topic.polymorphism";
      throw new ObligationViolationError(
        `Java topic structure validation failed for slot ${slot.index}: ${innerMsg}`,
        { obligationId: mapped ?? fallback }
      );
    }

    // stdout-only enforcement: reference + tests must be output-driven (not return-only).
    if (!javaUsesStdout(referenceSolution)) {
      throw new ObligationViolationError(
        "For stdout-style Java problems, reference_solution must write the final answer to stdout (System.out.print/println/printf).",
        { obligationId: "java.stdout_solution_prints" }
      );
    }
    if (!javaTestSuiteCapturesStdout(testSuite)) {
      throw new ObligationViolationError(
        "For stdout-style Java problems, test_suite must capture stdout and assert on the printed output.",
        { obligationId: "java.stdout_tests_capture" }
      );
    }
    if (usesStdin && !javaTestSuiteSetsStdin(testSuite)) {
      throw new ObligationViolationError(
        "For stdin-driven Java problems, test_suite must set deterministic stdin (System.setIn / ByteArrayInputStream) before executing the code.",
        { obligationId: "java.stdin_tests_provide" }
      );
    }

    const rawConstraints = typeof raw.constraints === "string" ? raw.constraints.trim() : "";
    if (rawConstraints && rawConstraints !== slot.constraints) {
      throw new Error(`Invalid constraints for slot ${slot.index}: must match slot.constraints exactly.`);
    }
    const constraints = slot.constraints;

    if (!sampleInputs || !sampleOutputs) {
      const samples = coerceNonEmptySamplePairs(raw, "stdin");
      sampleInputs = samples.sampleInputs;
      sampleOutputs = samples.sampleOutputs;
      if (samples.changed) {
        rewrites.push({ id: "samples.autofill", applied: true, detail: "Filled missing/mismatched sample_inputs/sample_outputs." });
      }
    }

    const difficulty = slot.difficulty;
    const topicTag = slot.topics[0] ?? "oop";

    const draft: GeneratedProblemDraft = {
      language: "java",
      id: baseId,
      title,
      description,
      starter_code: starterCode,
      test_suite: testSuite,
      reference_solution: referenceSolution,
      constraints,
      sample_inputs: sampleInputs,
      sample_outputs: sampleOutputs,
      difficulty,
      topic_tag: topicTag,
    };
    trace("generation.draft.meta", { slotIndex: slot.index, title, className, difficulty, topicTag });

    // Validate against GeneratedProblemDraftSchema
    const result = GeneratedProblemDraftSchema.safeParse(draft);
    if (!result.success) {
      const firstError = result.error.issues[0];
      throw new Error(
        `Generated problem for slot ${slot.index} failed schema validation: ${firstError?.message ?? "unknown error"}`
      );
    }

    return { draft: result.data, meta: { llmOutputHash, ...(llmMeta ? { llm: llmMeta } : {}), rewrites } };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const obligationId = err instanceof ObligationViolationError ? err.obligationId : undefined;
    throw new GenerationContractError(msg, {
      slotIndex: slot.index,
      llmOutputHash,
      rawSnippet: text.slice(0, 2400),
      ...(llmMeta ? { llm: llmMeta } : {}),
      ...(obligationId ? { obligationId } : {}),
    });
  }
}
