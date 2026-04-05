import crypto from "crypto";
import type { ProblemPlan } from "../planner/types";
import { generateSingleProblem } from "./perSlotGenerator";
import {
  ReferenceSolutionValidationError,
  validateReferenceSolution,
} from "./referenceSolutionValidator";
import { runTestStrengthGate, TestStrengthGateError } from "./testStrengthGate";
import { deriveSlotObligations } from "./obligations";
import { progressSummaryForFailure, validateInjectedDraftContract } from "./services/validationService";
import type { SlotIntent } from "../contracts/generationDiagnostics";
import type { GenerationProgressEvent } from "../contracts/generationProgress";
import type { SlotPromptContext } from "../languages/types";

function computeExpensiveFingerprint(draft: unknown): string {
  const h = crypto.createHash("sha256");
  const generatedDraft = draft as Record<string, unknown>;
  h.update(String(generatedDraft.language ?? ""));
  h.update("\n==test_suite==\n");
  h.update(String(generatedDraft.test_suite ?? ""));

  if ("reference_solution" in generatedDraft) {
    h.update("\n==reference_solution==\n");
    h.update(String(generatedDraft.reference_solution ?? ""));
  }

  if ("reference_workspace" in generatedDraft && (generatedDraft.reference_workspace as any)?.files) {
    const files = Array.isArray((generatedDraft.reference_workspace as any).files)
      ? [...(generatedDraft.reference_workspace as any).files]
      : [];
    files.sort((a: any, b: any) => String(a?.path ?? "").localeCompare(String(b?.path ?? "")));
    h.update("\n==reference_workspace==\n");
    for (const file of files) {
      h.update(String(file?.path ?? ""));
      h.update("\0");
      h.update(String(file?.content ?? ""));
      h.update("\n");
    }
  }

  return h.digest("hex");
}

export async function runLegacySlotAdapter(args: {
  slot: ProblemPlan[number];
  promptContext: SlotPromptContext;
  slotIntent: SlotIntent;
  onProgress?: (event: GenerationProgressEvent) => void;
  deps?: {
    generateSingleProblem?: typeof generateSingleProblem;
    validateReferenceSolution?: typeof validateReferenceSolution;
    runTestStrengthGate?: typeof runTestStrengthGate;
  };
}): Promise<{ generated: Awaited<ReturnType<typeof generateSingleProblem>>; attempt: number }> {
  const defaultMaxAttempts = 3;
  const generateSingleProblemFn = args.deps?.generateSingleProblem ?? generateSingleProblem;
  const validateReferenceSolutionFn = args.deps?.validateReferenceSolution ?? validateReferenceSolution;
  const runTestStrengthGateFn = args.deps?.runTestStrengthGate ?? runTestStrengthGate;

  let qualityFailureFingerprint: string | undefined;
  let cachedQualityFailure: unknown;
  let validatedFingerprint: string | undefined;

  for (let attempt = 1; attempt <= defaultMaxAttempts; attempt++) {
    args.onProgress?.({ type: "slot_llm_attempt_started", slotIndex: args.slot.index, attempt });
    args.onProgress?.({ type: "attempt_started", index: args.slot.index, attempt });

    let generated: Awaited<ReturnType<typeof generateSingleProblemFn>> | undefined;
    try {
      generated = await generateSingleProblemFn(args.slot, { promptContext: args.promptContext });
      validateInjectedDraftContract(args.slot, generated.draft);
      args.onProgress?.({ type: "slot_contract_validated", slotIndex: args.slot.index, attempt });
      args.onProgress?.({
        type: "slot_evidence",
        slotIndex: args.slot.index,
        attempt,
        obligations: deriveSlotObligations(args.slot).map((id) => ({ id, ok: true })),
      });
      args.onProgress?.({ type: "slot_docker_validation_started", slotIndex: args.slot.index, attempt });
      args.onProgress?.({ type: "validation_started", index: args.slot.index, attempt });

      const fingerprint = computeExpensiveFingerprint(generated.draft);
      if (validatedFingerprint !== fingerprint) {
        await validateReferenceSolutionFn(generated.draft);
        validatedFingerprint = fingerprint;
      }

      if (qualityFailureFingerprint === fingerprint && cachedQualityFailure) {
        throw cachedQualityFailure;
      }

      await runTestStrengthGateFn(generated.draft, args.slot);
      return { generated, attempt };
    } catch (err) {
      const fingerprint = generated ? computeExpensiveFingerprint(generated.draft) : undefined;
      if (err instanceof TestStrengthGateError && fingerprint) {
        qualityFailureFingerprint = fingerprint;
        cachedQualityFailure = err;
      }
      if (err instanceof ReferenceSolutionValidationError) {
        args.onProgress?.({
          type: "slot_docker_validation_failed",
          slotIndex: args.slot.index,
          attempt,
          shortError: err.message,
        });
        args.onProgress?.({ type: "validation_failed", index: args.slot.index, attempt });
      }
      const emitted = progressSummaryForFailure({
        slotIndex: args.slot.index,
        attempt,
        maxAttempts: defaultMaxAttempts,
        err,
        ...(typeof generated?.meta?.llmOutputHash === "string" ? { llmOutputHash: generated.meta.llmOutputHash } : {}),
        ...(generated?.meta?.llm ? { llm: generated.meta.llm } : {}),
        slotIntent: args.slotIntent,
        final: attempt >= defaultMaxAttempts,
      });
      args.onProgress?.(emitted.summary);
      args.onProgress?.(emitted.failure);
      args.onProgress?.({
        type: "attempt_failed",
        index: args.slot.index,
        attempt,
        phase: err instanceof ReferenceSolutionValidationError || err instanceof TestStrengthGateError ? "validate" : "generate",
      });
      if (attempt >= defaultMaxAttempts) throw err;
    }
  }

  throw new Error(`Failed to generate slot ${args.slot.index}.`);
}
