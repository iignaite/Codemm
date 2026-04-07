import type { GeneratedProblemDraft } from "../contracts/problem";
import type { JudgeResult } from "../types";
import { traceText } from "../utils/trace";
import type { GenerationFailureKind } from "./errors";
import { getLanguageProfile } from "../languages/profiles";

export class ReferenceSolutionValidationError extends Error {
  judgeStdout: string;
  judgeStderr: string;
  exitCode: number | undefined;
  kind: GenerationFailureKind;
  failureCategory: string | undefined;
  timeoutStage: "compile" | "execute" | "overall" | undefined;
  watchdogSource: "inner" | "outer" | "unknown" | undefined;
  parsedFailures: Record<string, unknown> | undefined;
  budgetProfile: Record<string, unknown> | undefined;
  judgeResult: JudgeResult | undefined;

  constructor(
    message: string,
    opts: {
      stdout: string;
      stderr: string;
      exitCode?: number;
      kind: GenerationFailureKind;
      failureCategory?: string;
      timeoutStage?: "compile" | "execute" | "overall";
      watchdogSource?: "inner" | "outer" | "unknown";
      parsedFailures?: Record<string, unknown>;
      budgetProfile?: Record<string, unknown>;
      judgeResult?: JudgeResult;
    }
  ) {
    super(message);
    this.name = "ReferenceSolutionValidationError";
    this.judgeStdout = opts.stdout;
    this.judgeStderr = opts.stderr;
    this.exitCode = opts.exitCode;
    this.kind = opts.kind;
    this.failureCategory = opts.failureCategory;
    this.timeoutStage = opts.timeoutStage;
    this.watchdogSource = opts.watchdogSource;
    this.parsedFailures = opts.parsedFailures;
    this.budgetProfile = opts.budgetProfile;
    this.judgeResult = opts.judgeResult;
  }
}

/**
 * Validate that the reference_solution compiles and passes all tests via Docker.
 *
 * Throws on:
 * - Compile errors
 * - Test failures (reference solution must pass all tests)
 *
 * Returns void on success.
 *
 * After this validation passes, the caller MUST discard reference_solution
 * before persisting the problem.
 */
export async function validateReferenceSolution(draft: GeneratedProblemDraft): Promise<JudgeResult> {
  const profile = getLanguageProfile(draft.language);
  if (!profile.judgeAdapter) {
    throw new Error(`No judge adapter configured for "${draft.language}".`);
  }

  const result =
    "reference_solution" in draft
      ? await profile.judgeAdapter.judge({ kind: "code", code: draft.reference_solution, testSuite: draft.test_suite })
      : await profile.judgeAdapter.judge({
          kind: "files",
          files: Object.fromEntries(
            draft.reference_workspace.files.map((f: { path: string; content: string }) => [f.path, f.content])
          ),
          testSuite: draft.test_suite,
        });
  traceText("generation.judge.stdout", result.stdout ?? "", { extra: { title: draft.title } });
  traceText("generation.judge.stderr", result.stderr ?? "", { extra: { title: draft.title } });

  const stdoutLower = (result.stdout || "").toLowerCase();
  const stderrLower = (result.stderr || "").toLowerCase();
  const combinedLower = `${stdoutLower}\n${stderrLower}`;

  if (result.failureCategory === "TIME_BUDGET_EXCEEDED" || result.failureCategory === "EXEC_TIMEOUT" || result.timedOut) {
    throw new ReferenceSolutionValidationError(
      `Reference solution timed out for "${draft.title}".`,
      {
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        kind: "timeout",
        ...(result.failureCategory ? { failureCategory: result.failureCategory } : {}),
        ...(result.timeoutStage ? { timeoutStage: result.timeoutStage } : {}),
        ...(result.watchdogSource ? { watchdogSource: result.watchdogSource } : {}),
        ...(result.parsedFailures ? { parsedFailures: result.parsedFailures } : {}),
        ...(result.budgetProfile ? { budgetProfile: result.budgetProfile } : {}),
        judgeResult: result,
      }
    );
  }

  if (result.failureCategory === "OUTPUT_LIMIT_EXCEEDED" || result.failureCategory === "OUTPUT_LIMIT") {
    throw new ReferenceSolutionValidationError(
      `Reference solution exceeded output limits for "${draft.title}".`,
      {
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        kind: "infra",
        ...(result.failureCategory ? { failureCategory: result.failureCategory } : {}),
        ...(result.parsedFailures ? { parsedFailures: result.parsedFailures } : {}),
        ...(result.budgetProfile ? { budgetProfile: result.budgetProfile } : {}),
        judgeResult: result,
      }
    );
  }

  if (result.failureCategory === "JUDGE_INFRA_FAILURE" || result.failureCategory === "INFRA_ERROR") {
    throw new ReferenceSolutionValidationError(
      `Reference solution validation hit judge infrastructure failure for "${draft.title}".`,
      {
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        kind: "infra",
        ...(result.failureCategory ? { failureCategory: result.failureCategory } : {}),
        ...(result.parsedFailures ? { parsedFailures: result.parsedFailures } : {}),
        ...(result.budgetProfile ? { budgetProfile: result.budgetProfile } : {}),
        judgeResult: result,
      }
    );
  }

  const hasCompileError =
    draft.language === "java"
      ? /\berror:|cannot find symbol|class, interface, or enum expected/.test(combinedLower)
    : draft.language === "python"
      ? /\b(syntaxerror|indentationerror|taberror|modulenotfounderror|importerror)\b/.test(combinedLower)
    : /\berror:|undefined reference|ld returned|collect2:/i.test(combinedLower);

  // SQL: treat sqlite parser/operational errors as compile-like.
  const hasSqlError =
    draft.language === "sql"
      ? /\b(operationalerror|syntax error|no such table|no such column)\b/.test(combinedLower)
      : false;

  if (result.failureCategory === "COMPILE_FAILURE" || result.failureCategory === "COMPILE_ERROR" || hasCompileError || hasSqlError) {
    const snippet = `${result.stderr || result.stdout || ""}`.slice(0, 1200);
    const fallback = snippet || `No compiler output captured (exitCode=${result.exitCode ?? "unknown"}).`;
    throw new ReferenceSolutionValidationError(
      `Reference solution failed to compile for "${draft.title}": ${fallback}`,
      {
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        kind: "compile",
        ...(result.failureCategory ? { failureCategory: result.failureCategory } : {}),
        ...(result.parsedFailures ? { parsedFailures: result.parsedFailures } : {}),
        ...(result.budgetProfile ? { budgetProfile: result.budgetProfile } : {}),
        judgeResult: result,
      }
    );
  }

  // Check that tests pass
  if (result.failureCategory === "TEST_FAILURE" || !result.success) {
    const stdout = result.stdout || "";
    const stderr = result.stderr || "";
    const likelyJUnitFailure =
      /Failures\s*\(\d+\):|\[X\]|AssertionFailedError|org\.opentest4j/i.test(stdout);
    const snippetSource = likelyJUnitFailure ? stdout : stdout.length >= stderr.length ? stdout : stderr;
    const snippet = `${snippetSource || ""}`.slice(0, 1200);
    const fallback = snippet || `No JUnit output captured (exitCode=${result.exitCode ?? "unknown"}).`;
    throw new ReferenceSolutionValidationError(
      `Reference solution failed tests for "${draft.title}": ${fallback}`,
      {
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        kind: "tests",
        ...(result.failureCategory ? { failureCategory: result.failureCategory } : {}),
        ...(result.parsedFailures ? { parsedFailures: result.parsedFailures } : {}),
        ...(result.budgetProfile ? { budgetProfile: result.budgetProfile } : {}),
        judgeResult: result,
      }
    );
  }

  // Success: reference solution compiles and passes all tests.
  // Caller must discard reference_solution before persistence.
  return result;
}
