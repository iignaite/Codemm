import type {
  ActivityDetailDto,
  ActivityFileRoleDto,
  ActivityLanguageDto,
  ActivityProblemDto,
  JudgeRunResultDto,
  JudgeSubmitResultDto,
} from "@codemm/shared-contracts";

export type Activity = ActivityDetailDto;
export type FileRole = ActivityFileRoleDto;
export type LanguageId = ActivityLanguageDto;
export type Problem = ActivityProblemDto;
export type RunResult = JudgeRunResultDto;
export type JudgeResult = JudgeSubmitResultDto;

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
