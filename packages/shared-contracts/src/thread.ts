export type ThreadLearningMode = "practice" | "guided";

export type ThreadState =
  | "DRAFT"
  | "CLARIFYING"
  | "READY"
  | "GENERATE_PENDING"
  | "GENERATING"
  | "COMPLETED"
  | "INCOMPLETE"
  | "PARTIAL_SUCCESS"
  | "RETRYABLE_FAILURE"
  | "HARD_FAILURE";

export type ThreadMessageDto = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

export type ThreadCollectorDto = {
  currentQuestionKey: string | null;
  buffer: string[];
};

export type ThreadCommitmentDto = {
  field: string;
  value: unknown;
  locked?: boolean;
  source?: "explicit" | "implicit";
};

export type GenerationOutcomeDto = {
  slotIndex: number;
  success: boolean;
  status:
    | "SUCCEEDED"
    | "RECOVERABLE_FAILED"
    | "FATAL_FAILED"
    | "QUARANTINED"
    | "RETRYABLE_FAILURE"
    | "HARD_FAILURE"
    | "SKIPPED";
  retries: number;
  failureKind?: string;
  failureCode?: string;
  message?: string;
  appliedFallback?: string;
};

export type ThreadSummaryDto = {
  id: string;
  state: string;
  learning_mode: string | null;
  created_at: string;
  updated_at: string;
  activity_id: string | null;
  last_message: string | null;
  last_message_at: string | null;
  message_count: number;
};

export type ThreadDetailDto = {
  threadId: string;
  state: ThreadState | string;
  learning_mode: ThreadLearningMode;
  instructions_md: string | null;
  spec: Record<string, unknown>;
  messages: ThreadMessageDto[];
  collector: ThreadCollectorDto;
  confidence: Record<string, number>;
  commitments: ThreadCommitmentDto[];
  generationOutcomes: GenerationOutcomeDto[];
  intentTrace: unknown[];
  latestGenerationRunId?: string | null;
  latestGenerationRunStatus?: string | null;
};

export type CreateThreadResponseDto = {
  threadId: string;
  state: ThreadState | string;
  learning_mode: ThreadLearningMode;
  nextQuestion: string;
  questionKey: string | null;
  done: false;
  next_action: "ask";
  assistant_summary?: string;
  assumptions?: string[];
};

export type UpdateThreadInstructionsResponseDto = { ok: true };

export type PostThreadMessageResponseDto =
  | {
      accepted: false;
      state: ThreadState | string;
      nextQuestion: string;
      questionKey: string | null;
      done: false;
      error: string;
      spec: Record<string, unknown>;
      assistant_summary?: string;
      assumptions?: string[];
      next_action?: string;
    }
  | {
      accepted: true;
      state: ThreadState | string;
      nextQuestion: string;
      questionKey: string | null;
      done: boolean;
      spec: Record<string, unknown>;
      patch: Array<{
        op: "add" | "replace" | "remove";
        path: string;
        value?: unknown;
      }>;
      assistant_summary?: string;
      assumptions?: string[];
      next_action?: string;
    };

export type ThreadGenerationSubscriptionDto = {
  subId: string;
  buffered: unknown[];
  runId?: string;
};

export type GenerateThreadResponseDto = {
  activityId: string;
  problemCount: number;
  runId: string;
};

export type ThreadListResponseDto = {
  threads: ThreadSummaryDto[];
};
