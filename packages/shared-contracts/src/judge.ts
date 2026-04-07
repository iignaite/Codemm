import type { ActivityLanguageDto } from "./activity";
import type { JudgeFailureCategoryDto } from "./generation";

export type JudgeTestCaseDetailDto = {
  name: string;
  passed: boolean;
  input?: string;
  expectedOutput?: string;
  actualOutput?: string;
  message?: string;
  location?: string;
};

export type RunResultDto = {
  stdout: string;
  stderr: string;
  formattedStdout?: string;
  formattedStderr?: string;
  runId: string;
  failureCategory?: JudgeFailureCategoryDto;
  timeoutStage?: "compile" | "execute" | "overall";
  outputLimitExceeded?: boolean;
};

export type JudgeRunResultDto = RunResultDto;

export type JudgeSubmitResultDto = {
  success: boolean;
  passedTests: string[];
  failedTests: string[];
  stdout: string;
  stderr: string;
  formattedStdout?: string;
  formattedStderr?: string;
  executionTimeMs?: number;
  exitCode?: number;
  timedOut?: boolean;
  failureCategory?: JudgeFailureCategoryDto;
  timeoutStage?: "compile" | "execute" | "overall";
  outputLimitExceeded?: boolean;
  testCaseDetails?: JudgeTestCaseDetailDto[];
  runId: string;
};

export type JudgeRunRequestDto = {
  language: ActivityLanguageDto;
  code?: string;
  files?: Record<string, string>;
  mainClass?: string;
  stdin?: string;
};

export type JudgeSubmitRequestDto = {
  language?: ActivityLanguageDto;
  testSuite: string;
  code?: string;
  files?: Record<string, string>;
  activityId?: string;
  problemId?: string;
};
