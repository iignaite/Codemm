import type { JudgeFailureCategoryDto } from "@codemm/shared-contracts";
import type { SpawnCaptureResult } from "./docker";
import type { JudgeResult } from "../types";

export const COMPILE_TIMEOUT_MARKER = "__CODEMM_COMPILE_TIMEOUT__";
export const EXEC_TIMEOUT_MARKER = "__CODEMM_EXEC_TIMEOUT__";

function stripMarkers(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== COMPILE_TIMEOUT_MARKER && line.trim() !== EXEC_TIMEOUT_MARKER)
    .join("\n")
    .trim();
}

function inferFailureCategory(args: {
  timedOut: boolean;
  outputLimitExceeded: boolean;
  stdout: string;
  stderr: string;
  timeoutStage?: "compile" | "execute" | "overall";
  passedTests: string[];
  failedTests: string[];
}): JudgeFailureCategoryDto | undefined {
  if (args.outputLimitExceeded) return "OUTPUT_LIMIT_EXCEEDED";
  if (args.timedOut || args.timeoutStage) return "TIME_BUDGET_EXCEEDED";

  const combined = `${args.stdout}\n${args.stderr}`.toLowerCase();
  if (/cannot connect to the docker daemon|docker[^a-z]+not found|permission denied|no such image|pull access denied/.test(combined)) {
    return "JUDGE_INFRA_FAILURE";
  }

  const hasStructuredTestFailure =
    args.failedTests.length > 0 ||
    args.passedTests.length > 0 ||
    /assertionfailederror|failures\s*\(\d+\):|\[x\]|===+\s*failures?\s*===+|failed\s+.*::test_/i.test(combined);
  if (hasStructuredTestFailure) return "TEST_FAILURE";

  return "COMPILE_FAILURE";
}

export function buildJudgeResult(args: {
  success: boolean;
  passedTests: string[];
  failedTests: string[];
  executionTimeMs: number;
  capture: SpawnCaptureResult;
  budgetProfile?: Record<string, unknown>;
}): JudgeResult {
  const timeoutStage =
    args.capture.stderr.includes(COMPILE_TIMEOUT_MARKER)
      ? "compile"
      : args.capture.stderr.includes(EXEC_TIMEOUT_MARKER)
        ? "execute"
        : args.capture.timedOut
          ? "overall"
          : undefined;
  const watchdogSource =
    timeoutStage === "overall" ? "outer" : timeoutStage === "compile" || timeoutStage === "execute" ? "inner" : undefined;

  const stdout = stripMarkers(args.capture.stdout);
  const stderr = stripMarkers(args.capture.stderr);
  const failureCategory = args.success
    ? undefined
    : inferFailureCategory({
        timedOut: args.capture.timedOut,
        outputLimitExceeded: args.capture.outputLimitExceeded,
        stdout,
        stderr,
        ...(timeoutStage ? { timeoutStage } : {}),
        passedTests: args.passedTests,
        failedTests: args.failedTests,
      });

  return {
    success: args.success,
    passedTests: args.passedTests,
    failedTests: args.failedTests,
    stdout,
    stderr,
    executionTimeMs: args.executionTimeMs,
    ...(typeof args.capture.exitCode === "number" ? { exitCode: args.capture.exitCode } : {}),
    ...(args.capture.timedOut ? { timedOut: true } : {}),
    ...(failureCategory ? { failureCategory } : {}),
    ...(timeoutStage ? { timeoutStage } : {}),
    ...(watchdogSource ? { watchdogSource } : {}),
    ...(args.capture.outputLimitExceeded ? { outputLimitExceeded: true } : {}),
    ...(!args.success
      ? {
          parsedFailures: {
            passedTests: args.passedTests,
            failedTests: args.failedTests,
          },
        }
      : {}),
    ...(args.budgetProfile ? { budgetProfile: args.budgetProfile } : {}),
  };
}
