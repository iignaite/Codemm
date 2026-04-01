import type { FileRole, LanguageId } from "@/lib/languages";

export type Problem = {
  language?: LanguageId;
  id: string;
  title: string;
  description: string;
  starter_code?: string;
  classSkeleton?: string;
  test_suite?: string;
  testSuite?: string;
  workspace?: {
    files: { path: string; role: FileRole; content: string }[];
    entrypoint?: string;
  };
  constraints: string;
  sample_inputs?: string[];
  sampleInputs?: string[];
  sample_outputs?: string[];
  sampleOutputs?: string[];
  difficulty?: string;
  topic_tag?: string;
  pedagogy?: {
    scaffold_level?: number;
    learning_goal?: string;
    hints_enabled?: boolean;
  };
};

export type Activity = {
  id: string;
  title: string;
  prompt: string;
  problems: Problem[];
  createdAt: string;
  status?: "DRAFT" | "PUBLISHED";
  timeLimitSeconds?: number | null;
};

export type JudgeResult = {
  success: boolean;
  passedTests: string[];
  failedTests: string[];
  stdout: string;
  stderr: string;
  executionTimeMs?: number;
  exitCode?: number;
  timedOut?: boolean;
  testCaseDetails?: Array<{
    name: string;
    passed: boolean;
    input?: string;
    expectedOutput?: string;
    actualOutput?: string;
    message?: string;
  }>;
};

export type RunResult = {
  stdout: string;
  stderr: string;
};

export type CodeFiles = Record<string, string>;

export type ProblemStatus = "not_started" | "in_progress" | "passed" | "failed";

export type FeedbackState = {
  problemId: string;
  kind: "run" | "tests";
  atIso: string;
  result: JudgeResult | RunResult;
};

export type PersistedTimerStateV1 = {
  v: 1;
  mode: "countup" | "countdown";
  limitSeconds: number | null;
  baseSeconds: number;
  startedAtMs: number | null;
};
