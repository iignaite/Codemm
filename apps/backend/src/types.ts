import type { JudgeFailureCategoryDto } from "@codemm/shared-contracts";

/**
 * Shared types for Codemm v1.0.
 */

export interface JudgeResult {
  success: boolean;
  passedTests: string[];
  failedTests: string[];
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  exitCode?: number;
  timedOut?: boolean;
  failureCategory?: JudgeFailureCategoryDto;
  timeoutStage?: "compile" | "execute" | "overall";
  outputLimitExceeded?: boolean;
}

/**
 * Legacy GeneratedProblem shape (used for parsing old activities from DB).
 * New v1.0 problems use contracts/problem.ts GeneratedProblem schema.
 */
export interface LegacyGeneratedProblem {
  id: string;
  title: string;
  description: string;
  classSkeleton: string;
  testSuite: string;
  constraints: string;
  sampleInputs: string[];
  sampleOutputs: string[];
}
