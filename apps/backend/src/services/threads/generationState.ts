import type {
  GenerationFailureKind,
  GenerationRunStatus,
  GenerationSlotStage,
  GenerationSlotTerminalStatus,
  ThreadState,
} from "@codemm/shared-contracts";
import type { GenerationOutcome } from "../../contracts/generationOutcome";

export type SlotExecutionFailure = {
  kind: GenerationFailureKind;
  code: string;
  message: string;
  stage: GenerationSlotStage;
  title?: string;
  llmOutputHash?: string;
};

export type SlotExecutionResult =
  | {
      slotIndex: number;
      terminalStatus: "SUCCEEDED";
      retries: number;
      problem: any;
      outcome: GenerationOutcome;
      title?: string;
    }
  | {
      slotIndex: number;
      terminalStatus: Exclude<GenerationSlotTerminalStatus, "SUCCEEDED">;
      retries: number;
      outcome: GenerationOutcome;
      failure: SlotExecutionFailure;
      title?: string;
    };

export function mapRunStatusToThreadState(status: GenerationRunStatus): ThreadState {
  if (status === "COMPLETED") return "COMPLETED";
  if (status === "PARTIAL_SUCCESS") return "PARTIAL_SUCCESS";
  if (status === "HARD_FAILURE") return "HARD_FAILURE";
  if (status === "RETRYABLE_FAILURE" || status === "ABORTED") return "RETRYABLE_FAILURE";
  if (status === "RUNNING") return "GENERATING";
  return "GENERATE_PENDING";
}

export function deriveRunStatus(results: SlotExecutionResult[]): GenerationRunStatus {
  const succeeded = results.filter((result) => result.terminalStatus === "SUCCEEDED").length;
  const hardFailures = results.filter((result) => result.terminalStatus === "HARD_FAILURE").length;
  const retryableFailures = results.filter((result) => result.terminalStatus === "RETRYABLE_FAILURE").length;
  const skipped = results.filter((result) => result.terminalStatus === "SKIPPED").length;

  if (results.length > 0 && succeeded === results.length) return "COMPLETED";
  if (succeeded > 0 && succeeded + hardFailures + retryableFailures + skipped === results.length) return "PARTIAL_SUCCESS";
  if (hardFailures > 0 && succeeded === 0 && retryableFailures === 0) return "HARD_FAILURE";
  if (retryableFailures > 0 || skipped === results.length) return "RETRYABLE_FAILURE";
  return "HARD_FAILURE";
}
