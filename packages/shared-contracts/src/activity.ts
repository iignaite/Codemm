export type ActivityLanguageDto = "java" | "python" | "cpp" | "sql";

export type ActivityFileRoleDto = "entry" | "support" | "readonly";

export type ActivityWorkspaceFileDto = {
  path: string;
  role: ActivityFileRoleDto;
  content: string;
};

export type ActivityWorkspaceDto = {
  files: ActivityWorkspaceFileDto[];
  entrypoint?: string;
};

export type ActivityProblemDto = {
  language?: ActivityLanguageDto;
  id: string;
  title: string;
  description: string;
  starter_code?: string;
  classSkeleton?: string;
  test_suite?: string;
  testSuite?: string;
  workspace?: ActivityWorkspaceDto;
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

export type ActivityStatusDto = "DRAFT" | "INCOMPLETE" | "PUBLISHED";

export type ActivityDetailDto = {
  id: string;
  title: string;
  prompt: string;
  problems: ActivityProblemDto[];
  createdAt: string;
  status?: ActivityStatusDto;
  timeLimitSeconds?: number | null;
  threadId?: string | null;
  failedSlotIndexes?: number[];
  failedSlotCount?: number;
};

export type ActivitySummaryDto = {
  id: string;
  title: string;
  status?: string;
  time_limit_seconds?: number | null;
  created_at: string;
};

export type ActivityListResponseDto = {
  activities: ActivitySummaryDto[];
};

export type ActivityResponseDto = {
  activity: ActivityDetailDto;
};

export type UpdateActivityResponseDto = ActivityResponseDto;

export type PublishActivityResponseDto = { ok: true };
