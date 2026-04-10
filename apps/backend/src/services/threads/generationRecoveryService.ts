import type { GenerationRunStatus, ThreadState } from "@codemm/shared-contracts";
import { generationRunRepository, generationSlotRunRepository } from "../../database/repositories/generationRunRepository";
import { threadRepository } from "../../database/repositories/threadRepository";
import { mapRunStatusToThreadState } from "./generationState";

function deriveRecoveredRunStatus(args: {
  successfulSlots: number;
  failedSlots: number;
  completedSlots: number;
  totalSlots: number;
}): GenerationRunStatus {
  if (args.successfulSlots > 0 && args.failedSlots > 0) return "INCOMPLETE";
  if (args.successfulSlots > 0 && args.completedSlots >= args.totalSlots) return "COMPLETED";
  return "RETRYABLE_FAILURE";
}

export function reconcileInterruptedGenerationState(): {
  reconciledRunIds: string[];
  updatedThreadIds: string[];
} {
  const reconciledRunIds: string[] = [];
  const updatedThreadIds = new Set<string>();

  for (const run of generationRunRepository.listStaleActiveRuns()) {
    generationSlotRunRepository.reconcileIncomplete(run.id);
    const slots = generationSlotRunRepository.listByRun(run.id);
    const successfulSlots = slots.filter((slot) => slot.status === "SUCCEEDED").length;
    const failedSlots = slots.filter(
      (slot) =>
        slot.status === "RETRYABLE_FAILURE" ||
        slot.status === "RECOVERABLE_FAILED" ||
        slot.status === "QUARANTINED" ||
        slot.status === "HARD_FAILURE" ||
        slot.status === "FATAL_FAILED"
    ).length;
    const completedSlots = slots.filter(
      (slot) =>
        slot.status === "SUCCEEDED" ||
        slot.status === "RETRYABLE_FAILURE" ||
        slot.status === "RECOVERABLE_FAILED" ||
        slot.status === "QUARANTINED" ||
        slot.status === "HARD_FAILURE" ||
        slot.status === "FATAL_FAILED" ||
        slot.status === "SKIPPED"
    ).length;
    const recoveredStatus = deriveRecoveredRunStatus({
      successfulSlots,
      failedSlots,
      completedSlots,
      totalSlots: run.total_slots,
    });

    generationRunRepository.finish({
      id: run.id,
      status: recoveredStatus,
      activityId: run.activity_id ?? null,
      completedSlots,
      successfulSlots,
      failedSlots,
      lastFailureCode: run.last_failure_code ?? "ENGINE_RESTART",
      lastFailureKind: (run.last_failure_kind as any) ?? "infra",
      lastFailureMessage: run.last_failure_message ?? "Generation was interrupted before completion.",
    });
    threadRepository.updateState(run.thread_id, mapRunStatusToThreadState(recoveredStatus));
    threadRepository.setLastError(
      run.thread_id,
      recoveredStatus === "COMPLETED" ? null : run.last_failure_message ?? "Generation was interrupted before completion."
    );
    reconciledRunIds.push(run.id);
    updatedThreadIds.add(run.thread_id);
  }

  const stuckThreads = threadRepository.listByStates(["GENERATE_PENDING", "GENERATING"]);
  for (const thread of stuckThreads) {
    const latestRun = generationRunRepository.latestByThread(thread.id);
    const nextState: ThreadState = latestRun ? mapRunStatusToThreadState(latestRun.status as GenerationRunStatus) : "READY";
    threadRepository.updateState(thread.id, nextState);
    if (nextState === "READY") {
      threadRepository.setLastError(thread.id, "Recovered thread state after interrupted generation.");
    }
    updatedThreadIds.add(thread.id);
  }

  return { reconciledRunIds, updatedThreadIds: [...updatedThreadIds] };
}
