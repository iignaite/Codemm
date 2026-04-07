import crypto from "crypto";
import { GeneratedProblemDraftSchema, type GeneratedProblemDraft } from "../../contracts/problem";
import type { ProblemSlot } from "../../planner/types";
import { JavaSourceNoPackageSchema, isValidJUnit5TestSuiteCountRange, javaTestSuiteCapturesStdout, javaTestSuiteSetsStdin } from "../../languages/java/rules";
import { hasJavaStructuralTopics } from "../../languages/java/structuralTopics";
import { PythonSourceSchema, isValidPytestTestSuiteForStyle } from "../../languages/python/rules";
import { CppSourceSchema, isValidCppTestSuite } from "../../languages/cpp/rules";
import { SqlQuerySchema, isValidSqlTestSuite } from "../../languages/sql/rules";
import { getJudgeCompileTimeoutMs, getJudgeExecutionTimeoutMs, getJudgeTimeoutMs } from "../../judge/docker";
import type { RepairStrategy } from "@codemm/shared-contracts";

type FindingSeverity = "info" | "warn" | "error";

export type ValidationFinding = {
  code: string;
  severity: FindingSeverity;
  message: string;
};

export type ValidatedExecutionBundle = {
  language: GeneratedProblemDraft["language"];
  normalizedStarterArtifact: string;
  normalizedReferenceArtifact: string;
  normalizedTestArtifact: string;
  artifactHashes: {
    starter?: string;
    reference?: string;
    tests?: string;
    description?: string;
  };
  staticFindings: ValidationFinding[];
  riskScore: number;
  executionBudgetProfile: Record<string, unknown>;
  repairStrategy?: RepairStrategy | null;
  slotPromptLineage: {
    slotIndex: number;
    language: string;
    topicSignature: string;
    problemStyle: string;
    llmOutputHash?: string | null;
  };
  draft: GeneratedProblemDraft;
  bundleHash: string;
};

export class ExecutionBundleValidationError extends Error {
  kind:
    | "generation_schema_error"
    | "static_rule_violation"
    | "api_shape_mismatch"
    | "complexity_risk_exceeded";
  findings: ValidationFinding[];
  riskScore: number;

  constructor(
    message: string,
    opts: {
      kind:
        | "generation_schema_error"
        | "static_rule_violation"
        | "api_shape_mismatch"
        | "complexity_risk_exceeded";
      findings: ValidationFinding[];
      riskScore: number;
    }
  ) {
    super(message);
    this.name = "ExecutionBundleValidationError";
    this.kind = opts.kind;
    this.findings = opts.findings;
    this.riskScore = opts.riskScore;
  }
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function topicSignature(slot: ProblemSlot): string {
  return [...slot.topics].sort().join("|");
}

function normalizeStyle(raw: string): "stdout" | "return" | "mixed" {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "stdout" || value === "mixed") return value;
  return "return";
}

function detectHighRiskNonTermination(source: string): string[] {
  const text = String(source ?? "");
  const findings: string[] = [];
  if (/\bwhile\s*\(\s*true\s*\)/.test(text) || /\bfor\s*\(\s*;\s*;\s*\)/.test(text)) findings.push("unbounded_loop");
  if (/\bwhile\s+True\s*:/.test(text)) findings.push("unbounded_loop");
  if (/\bloop\s*\{/.test(text)) findings.push("unbounded_loop");
  if (/\bThread\s*\.\s*sleep\s*\(/.test(text) || /\btime\s*\.\s*sleep\s*\(/.test(text)) findings.push("sleep_call");
  return findings;
}

function buildBudgetProfile(language: GeneratedProblemDraft["language"]) {
  const base: Record<string, unknown> = {
    overallTimeoutMs: getJudgeTimeoutMs(),
    executeTimeoutMs: getJudgeExecutionTimeoutMs(),
  };
  if (language === "java" || language === "cpp") {
    base.compileTimeoutMs = getJudgeCompileTimeoutMs();
  }
  return base;
}

function getReferenceArtifact(draft: GeneratedProblemDraft): string {
  if ("reference_solution" in draft && typeof draft.reference_solution === "string") {
    return draft.reference_solution;
  }
  if ("reference_workspace" in draft) {
    return draft.reference_workspace.files
      .map((file: { path: string; content: string }) => `// ${file.path}\n${file.content}`)
      .join("\n\n");
  }
  return "";
}

function getStarterArtifact(draft: GeneratedProblemDraft): string {
  if ("starter_code" in draft && typeof draft.starter_code === "string") return draft.starter_code;
  if ("workspace" in draft) {
    return draft.workspace.files
      .map((file: { path: string; content: string }) => `// ${file.path}\n${file.content}`)
      .join("\n\n");
  }
  return "";
}

function pushSchemaIssues(findings: ValidationFinding[], issues: { message: string }[], code: string) {
  for (const issue of issues) {
    findings.push({ code, severity: "error", message: issue.message });
  }
}

export function buildValidatedExecutionBundle(args: {
  slot: ProblemSlot;
  draft: GeneratedProblemDraft;
  repairStrategy?: RepairStrategy | null;
  llmOutputHash?: string | null;
}): ValidatedExecutionBundle {
  const findings: ValidationFinding[] = [];
  const parsed = GeneratedProblemDraftSchema.safeParse(args.draft);
  if (!parsed.success) {
    pushSchemaIssues(findings, parsed.error.issues, "generation_schema");
    const firstMessage = parsed.error.issues[0]?.message ?? "Draft failed generation schema validation.";
    const lower = firstMessage.toLowerCase();
    const kind =
      lower.includes("stdin") || lower.includes("must not") || lower.includes("read-only select")
        ? "static_rule_violation"
        : lower.includes("test_suite") || lower.includes("must define") || lower.includes("entrypoint")
          ? "api_shape_mismatch"
          : "generation_schema_error";
    throw new ExecutionBundleValidationError(
      firstMessage,
      {
        kind,
        findings,
        riskScore: 100,
      }
    );
  }

  const draft = parsed.data;
  const style = normalizeStyle(args.slot.problem_style);
  const starterArtifact = getStarterArtifact(draft);
  const referenceSource = getReferenceArtifact(draft);

  const highRisk = detectHighRiskNonTermination(referenceSource);
  let riskScore = highRisk.length * 35;
  if (style === "stdout") riskScore += 5;
  if (draft.language === "java" && hasJavaStructuralTopics(args.slot.topics)) riskScore += 5;

  if (draft.language === "java") {
    const sourceResult = JavaSourceNoPackageSchema.safeParse(referenceSource);
    if (!sourceResult.success) pushSchemaIssues(findings, sourceResult.error.issues, "java_source");
    if (!isValidJUnit5TestSuiteCountRange(draft.test_suite, 1, args.slot.test_case_count)) {
      findings.push({
        code: "java_test_suite_shape",
        severity: "error",
        message: `Java test suite must have 1-${args.slot.test_case_count} JUnit 5 tests with non-trivial assertions.`,
      });
    }
    if (style === "stdout" && !javaTestSuiteCapturesStdout(draft.test_suite)) {
      findings.push({
        code: "java_stdout_capture_missing",
        severity: "error",
        message: "Java stdout-style slots must capture and assert stdout deterministically.",
      });
    }
    if (/\bScanner\s*\(|\bSystem\s*\.\s*in\b/.test(referenceSource) && !javaTestSuiteSetsStdin(draft.test_suite)) {
      findings.push({
        code: "java_stdin_api_mismatch",
        severity: "error",
        message: "Java reference reads stdin but tests do not provide deterministic stdin.",
      });
    }
  } else if (draft.language === "python") {
    const sourceResult = PythonSourceSchema.safeParse(referenceSource);
    if (!sourceResult.success) pushSchemaIssues(findings, sourceResult.error.issues, "python_source");
    if (!isValidPytestTestSuiteForStyle(draft.test_suite, style, args.slot.test_case_count)) {
      findings.push({
        code: "python_test_suite_shape",
        severity: "error",
        message: `Python pytest suite does not match the ${style} contract for ${args.slot.test_case_count} tests.`,
      });
    }
  } else if (draft.language === "cpp") {
    const sourceResult = CppSourceSchema.safeParse(referenceSource);
    if (!sourceResult.success) pushSchemaIssues(findings, sourceResult.error.issues, "cpp_source");
    if (!isValidCppTestSuite(draft.test_suite, args.slot.test_case_count)) {
      findings.push({
        code: "cpp_test_suite_shape",
        severity: "error",
        message: `C++ test suite must define exactly ${args.slot.test_case_count} deterministic tests and include solution.cpp.`,
      });
    }
  } else if (draft.language === "sql") {
    const sourceResult = SqlQuerySchema.safeParse(referenceSource);
    if (!sourceResult.success) pushSchemaIssues(findings, sourceResult.error.issues, "sql_source");
    if (!isValidSqlTestSuite(draft.test_suite, args.slot.test_case_count)) {
      findings.push({
        code: "sql_test_suite_shape",
        severity: "error",
        message: `SQL test suite JSON must define exactly ${args.slot.test_case_count} deterministic cases.`,
      });
    }
  }

  for (const code of highRisk) {
    findings.push({
      code,
      severity: code === "unbounded_loop" ? "error" : "warn",
      message:
        code === "unbounded_loop"
          ? "Detected an unbounded loop pattern before execution."
          : "Detected a sleep call that increases timeout risk.",
    });
  }

  const blocking = findings.filter((finding) => finding.severity === "error");
  if (blocking.length > 0) {
    const first = blocking[0]!;
    const kind =
      first.code.includes("test_suite") || first.code.includes("api_mismatch")
        ? "api_shape_mismatch"
        : first.code === "unbounded_loop"
          ? "complexity_risk_exceeded"
          : first.code.includes("schema")
            ? "generation_schema_error"
            : "static_rule_violation";
    throw new ExecutionBundleValidationError(first.message, {
      kind,
      findings,
      riskScore: Math.min(100, Math.max(20, riskScore)),
    });
  }

  const bundleHash = sha256(
    JSON.stringify({
      language: draft.language,
      starter: starterArtifact,
      reference: referenceSource,
      tests: draft.test_suite,
      title: draft.title,
      constraints: draft.constraints,
      topics: args.slot.topics,
      style,
      repairStrategy: args.repairStrategy ?? null,
    })
  );

  return {
    language: draft.language,
    normalizedStarterArtifact: starterArtifact,
    normalizedReferenceArtifact: referenceSource,
    normalizedTestArtifact: draft.test_suite,
    artifactHashes: {
      starter: sha256(starterArtifact),
      reference: sha256(referenceSource),
      tests: sha256(draft.test_suite),
      description: sha256(draft.description),
    },
    staticFindings: findings,
    riskScore: Math.min(100, Math.max(0, riskScore)),
    executionBudgetProfile: buildBudgetProfile(draft.language),
    repairStrategy: args.repairStrategy ?? null,
    slotPromptLineage: {
      slotIndex: args.slot.index,
      language: args.slot.language,
      topicSignature: topicSignature(args.slot),
      problemStyle: style,
      ...(args.llmOutputHash ? { llmOutputHash: args.llmOutputHash } : {}),
    },
    draft,
    bundleHash,
  };
}
