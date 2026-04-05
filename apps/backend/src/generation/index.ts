import crypto from "crypto";
import type { ProblemPlan } from "../planner/types";
import type { GeneratedProblem, GeneratedProblemDraft } from "../contracts/problem";
import type { GenerationOutcome } from "../contracts/generationOutcome";
import type { AttemptDiagnostic, GenerationArtifactSet, SlotIntent } from "../contracts/generationDiagnostics";
import { generateSingleProblem, type RepairContext } from "./perSlotGenerator";
import {
  ReferenceSolutionValidationError,
  validateReferenceSolution,
} from "./referenceSolutionValidator";
import { trace } from "../utils/trace";
import { GenerationContractError, GenerationSlotFailureError, type GenerationFailureKind } from "./errors";
import type { GenerationProgressEvent } from "../contracts/generationProgress";
import type { CompletionMeta } from "../infra/llm/types";
import type { SlotPromptContext } from "../languages/types";
import { applyGuidedScaffoldingAsync } from "./scaffolding";
import { runTestStrengthGate, TestStrengthGateError } from "./testStrengthGate";
import { deriveSlotObligations } from "./obligations";
import { isValidJUnit5TestSuiteCountRange, pruneJUnitTestMethods } from "../languages/java/rules";
import { assertJavaStructuralTopicRequirements } from "../languages/java/structuralTopics";
import { runSlotPipeline, SlotPipelineTerminalError } from "../pipeline/slotStages";

/**
 * Discard reference_solution from GeneratedProblemDraft to produce GeneratedProblem.
 *
 * CRITICAL: reference_solution MUST NOT be persisted to the database.
 */
function discardReferenceArtifacts(draft: GeneratedProblemDraft): GeneratedProblem {
  if ("reference_solution" in draft) {
    const { reference_solution, ...rest } = draft;
    return rest;
  }
  const { reference_workspace, ...rest } = draft;
  return rest;
}

function sha256Short(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function inferFailureKind(err: unknown): GenerationFailureKind {
  if (err instanceof ReferenceSolutionValidationError) return err.kind;
  if (err instanceof GenerationContractError) return "contract";
  if (err instanceof TestStrengthGateError) return "quality";
  if (/Invalid test_suite|schema validation|public class|Test suite class name/i.test(String((err as any)?.message))) {
    return "contract";
  }
  return "unknown";
}

function recommendedRemediation(kind: GenerationFailureKind): string[] {
  if (kind === "compile") return ["Regenerate this slot", "Reduce difficulty for this slot"];
  if (kind === "tests") return ["Regenerate this slot", "Narrow topic scope"];
  if (kind === "timeout") return ["Regenerate this slot", "Reduce constraints and complexity"];
  if (kind === "contract") return ["Regenerate this slot", "Simplify prompt constraints"];
  if (kind === "quality") return ["Regenerate stronger tests", "Reduce requested hardness"];
  if (kind === "llm") return ["Retry this slot", "Switch to a stronger model"];
  return ["Retry this slot", "Narrow topic scope"];
}

function buildSlotIntent(slot: ProblemPlan[number]): SlotIntent {
  const style =
    slot.problem_style === "stdout" || slot.problem_style === "return" || slot.problem_style === "mixed"
      ? slot.problem_style
      : "return";
  return {
    slotIndex: slot.index,
    language: slot.language,
    difficulty: slot.difficulty,
    topics: [...slot.topics],
    constraints: slot.constraints,
    problemStyle: style,
    testCaseCount: slot.test_case_count,
  };
}

function buildArtifactSet(draft: GeneratedProblemDraft): GenerationArtifactSet {
  const referenceHash =
    "reference_solution" in draft
      ? sha256Short((draft as any).reference_solution)
      : sha256Short(JSON.stringify((draft as any).reference_workspace ?? null));
  const testSuiteHash = sha256Short((draft as any)?.test_suite);
  const starterHash = sha256Short((draft as any)?.starter_code);
  const descriptionHash = sha256Short((draft as any)?.description);
  const hashes: GenerationArtifactSet["hashes"] = {};
  if (typeof testSuiteHash === "string") hashes.testSuite = testSuiteHash;
  if (typeof referenceHash === "string") hashes.reference = referenceHash;
  if (typeof starterHash === "string") hashes.starter = starterHash;
  if (typeof descriptionHash === "string") hashes.description = descriptionHash;

  return {
    ...(typeof (draft as any)?.title === "string" ? { title: String((draft as any).title) } : {}),
    language: draft.language,
    hasWorkspace: Boolean((draft as any)?.workspace || (draft as any)?.reference_workspace),
    hashes,
  };
}

function validateInjectedDraftContract(slot: ProblemPlan[number], draft: GeneratedProblemDraft): void {
  if (draft.language !== slot.language) {
    throw new GenerationContractError(`Invalid language for slot ${slot.index}: must match slot.language exactly.`, {
      slotIndex: slot.index,
    });
  }
  if (draft.constraints !== slot.constraints) {
    throw new GenerationContractError(`Invalid constraints for slot ${slot.index}: must match slot.constraints exactly.`, {
      slotIndex: slot.index,
    });
  }
  if (slot.language === "java" && "reference_solution" in draft && typeof draft.reference_solution === "string") {
    assertJavaStructuralTopicRequirements({
      topics: slot.topics,
      referenceSource: draft.reference_solution,
      testSuite: draft.test_suite,
    });
  }
}

function extractFailedJavaTestNames(output: string): string[] {
  const clean = String(output ?? "");
  const names = new Set<string>();
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\(\)\s+\[X\]\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(clean)) !== null) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

function maybeDropFailingJavaTests(
  draft: GeneratedProblemDraft,
  err: ReferenceSolutionValidationError
): { draft: GeneratedProblemDraft; droppedTests: string[] } | null {
  if (draft.language !== "java") return null;
  if (!("test_suite" in draft) || typeof draft.test_suite !== "string") return null;

  const failedTests = extractFailedJavaTestNames(`${err.judgeStdout ?? ""}\n${err.judgeStderr ?? ""}`);
  if (failedTests.length === 0) return null;

  const pruned = pruneJUnitTestMethods(draft.test_suite, failedTests);
  if (pruned.dropped.length === 0) return null;
  if (!isValidJUnit5TestSuiteCountRange(pruned.testSuite, 1, 8)) return null;

  return {
    draft: { ...draft, test_suite: pruned.testSuite },
    droppedTests: pruned.dropped,
  };
}

function progressSummaryForFailure(args: {
  slotIndex: number;
  attempt: number;
  maxAttempts: number;
  err: unknown;
  llmOutputHash?: string;
  llm?: CompletionMeta;
  slotIntent: SlotIntent;
  final: boolean;
}) {
  const kind = inferFailureKind(args.err);
  const message = String((args.err as any)?.message ?? "Unknown generation failure");
  const phase: AttemptDiagnostic["phase"] =
    args.err instanceof ReferenceSolutionValidationError
      ? "validate"
      : args.err instanceof TestStrengthGateError
        ? "quality"
        : "generate";
  return {
    summary: {
      type: "slot_attempt_summary" as const,
      slotIndex: args.slotIndex,
      attempt: args.attempt,
      maxAttempts: args.maxAttempts,
      phase,
      status: "failed" as const,
      kind,
      message: message.slice(0, 360),
      remediation: recommendedRemediation(kind),
      ...(typeof args.llmOutputHash === "string" ? { llmOutputHash: args.llmOutputHash } : {}),
      ...(args.llm ? { llm: args.llm } : {}),
      slotIntent: args.slotIntent,
    },
    failure: {
      type: "slot_failure_diagnostic" as const,
      slotIndex: args.slotIndex,
      attempt: args.attempt,
      kind,
      message: message.slice(0, 360),
      remediation: recommendedRemediation(kind),
      final: args.final,
    },
  };
}

/**
 * Generate problems from a ProblemPlan using per-slot generation with isolated retries.
 *
 * For each slot:
 * - Call LLM to generate GeneratedProblemDraft (includes reference_solution)
 * - Validate reference_solution via Docker (compiles + passes tests)
 * - Discard reference_solution
 * - Collect GeneratedProblem
 *
 * Retry each slot up to 3 times on failure.
 * Throw if any slot fails after max retries.
 */
export async function generateProblemsFromPlan(
  plan: ProblemPlan,
  opts?: {
    onProgress?: (event: GenerationProgressEvent) => void;
    customInstructionsMd?: string | null;
    resume?: { problems: GeneratedProblem[]; outcomes: GenerationOutcome[] };
    onCheckpoint?: (state: {
      problems: GeneratedProblem[];
      outcomes: GenerationOutcome[];
      completedSlotIndex: number;
    }) => void;
    deps?: {
      generateSingleProblem?: typeof generateSingleProblem;
      validateReferenceSolution?: typeof validateReferenceSolution;
      runTestStrengthGate?: typeof runTestStrengthGate;
    };
  }
): Promise<{ problems: GeneratedProblem[]; outcomes: GenerationOutcome[] }> {
  function computeExpensiveFingerprint(draft: GeneratedProblemDraft): string {
    const h = crypto.createHash("sha256");
    h.update(String(draft.language ?? ""));
    h.update("\n==test_suite==\n");
    h.update(String((draft as any).test_suite ?? ""));

    if ("reference_solution" in (draft as any)) {
      h.update("\n==reference_solution==\n");
      h.update(String((draft as any).reference_solution ?? ""));
    }

    if ("reference_workspace" in (draft as any) && (draft as any).reference_workspace?.files) {
      const files = Array.isArray((draft as any).reference_workspace.files)
        ? [...(draft as any).reference_workspace.files]
        : [];
      files.sort((a: any, b: any) => String(a?.path ?? "").localeCompare(String(b?.path ?? "")));
      h.update("\n==reference_workspace==\n");
      for (const f of files) {
        h.update(String(f?.path ?? ""));
        h.update("\0");
        h.update(String(f?.content ?? ""));
        h.update("\n");
      }
    }

    return h.digest("hex");
  }

  const resumeProblems = Array.isArray(opts?.resume?.problems) ? opts!.resume!.problems : [];
  const resumeOutcomes = Array.isArray(opts?.resume?.outcomes) ? opts!.resume!.outcomes : [];

  const initialCount =
    resumeProblems.length === resumeOutcomes.length && resumeProblems.length <= plan.length
      ? resumeProblems.length
      : 0;

  const problems: GeneratedProblem[] = initialCount ? [...resumeProblems.slice(0, initialCount)] : [];
  const outcomes: GenerationOutcome[] = initialCount ? [...resumeOutcomes.slice(0, initialCount)] : [];
  const defaultMaxAttempts = 3;
  const onProgress = opts?.onProgress;
  const onCheckpoint = opts?.onCheckpoint;
  const generateSingleProblemFn = opts?.deps?.generateSingleProblem ?? generateSingleProblem;
  const useInjectedLegacyGenerator = typeof opts?.deps?.generateSingleProblem === "function";
  const validateReferenceSolutionFn = opts?.deps?.validateReferenceSolution ?? validateReferenceSolution;
  const runTestStrengthGateFn = opts?.deps?.runTestStrengthGate ?? runTestStrengthGate;
  const usedDomains: string[] = [];
  const usedTitles: string[] = [];
  const customInstructionsMd = (() => {
    const raw = typeof opts?.customInstructionsMd === "string" ? opts.customInstructionsMd : "";
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const maxLen = 8000;
    return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…(truncated)` : trimmed;
  })();

  async function runInjectedLegacySlot(slot: ProblemPlan[number], promptContext: SlotPromptContext, slotIntent: SlotIntent) {
    let qualityFailureFingerprint: string | undefined;
    let cachedQualityFailure: unknown;
    let validatedFingerprint: string | undefined;

    for (let attempt = 1; attempt <= defaultMaxAttempts; attempt++) {
      onProgress?.({ type: "slot_llm_attempt_started", slotIndex: slot.index, attempt });
      onProgress?.({ type: "attempt_started", index: slot.index, attempt });

      let generated: Awaited<ReturnType<typeof generateSingleProblemFn>> | undefined;
      try {
        generated = await generateSingleProblemFn(slot, { promptContext });
        validateInjectedDraftContract(slot, generated.draft);
        onProgress?.({ type: "slot_contract_validated", slotIndex: slot.index, attempt });
        onProgress?.({
          type: "slot_evidence",
          slotIndex: slot.index,
          attempt,
          obligations: deriveSlotObligations(slot).map((id) => ({ id, ok: true })),
        });
        onProgress?.({ type: "slot_docker_validation_started", slotIndex: slot.index, attempt });
        onProgress?.({ type: "validation_started", index: slot.index, attempt });

        const fingerprint = computeExpensiveFingerprint(generated.draft);
        if (validatedFingerprint !== fingerprint) {
          await validateReferenceSolutionFn(generated.draft);
          validatedFingerprint = fingerprint;
        }

        if (qualityFailureFingerprint === fingerprint && cachedQualityFailure) {
          throw cachedQualityFailure;
        }

        await runTestStrengthGateFn(generated.draft, slot);
        return { generated, attempt };
      } catch (err) {
        const fingerprint = generated ? computeExpensiveFingerprint(generated.draft) : undefined;
        if (err instanceof TestStrengthGateError && fingerprint) {
          qualityFailureFingerprint = fingerprint;
          cachedQualityFailure = err;
        }
        if (err instanceof ReferenceSolutionValidationError) {
          onProgress?.({ type: "slot_docker_validation_failed", slotIndex: slot.index, attempt, shortError: err.message });
          onProgress?.({ type: "validation_failed", index: slot.index, attempt });
        }
        const emitted = progressSummaryForFailure({
          slotIndex: slot.index,
          attempt,
          maxAttempts: defaultMaxAttempts,
          err,
          ...(typeof generated?.meta?.llmOutputHash === "string" ? { llmOutputHash: generated.meta.llmOutputHash } : {}),
          ...(generated?.meta?.llm ? { llm: generated.meta.llm } : {}),
          slotIntent,
          final: attempt >= defaultMaxAttempts,
        });
        onProgress?.(emitted.summary);
        onProgress?.(emitted.failure);
        onProgress?.({
          type: "attempt_failed",
          index: slot.index,
          attempt,
          phase: err instanceof ReferenceSolutionValidationError || err instanceof TestStrengthGateError ? "validate" : "generate",
        });
        if (attempt >= defaultMaxAttempts) throw err;
      }
    }

    throw new Error(`Failed to generate slot ${slot.index}.`);
  }

  const DOMAIN_POOL = [
    "smart home",
    "music streaming",
    "food delivery",
    "event ticketing",
    "fitness tracking",
    "space mission control",
    "hotel booking",
    "ride sharing",
    "online marketplace",
    "photo organizer",
    "recipe planner",
    "study planner",
    "inventory management",
    "movie recommendations",
    "package shipping",
    "language learning",
    "restaurant reservations",
    "weather alerts",
    "customer support",
    "game matchmaking",
  ] as const;

  function hashToIndex(seed: string, modulo: number): number {
    // Deterministic, non-crypto hash.
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h) % modulo;
  }

  function pickDomain(seed: string): string {
    const start = hashToIndex(seed, DOMAIN_POOL.length);
    for (let offset = 0; offset < DOMAIN_POOL.length; offset++) {
      const candidate = DOMAIN_POOL[(start + offset) % DOMAIN_POOL.length]!;
      if (!usedDomains.includes(candidate)) return candidate;
    }
    return DOMAIN_POOL[start]!;
  }

  // Warm up deterministic "used domains/titles" for resume scenarios so later slots still
  // get domain diversity and title avoidance.
  for (let i = 0; i < initialCount; i++) {
    const slot = plan[i];
    if (!slot) continue;
    const domainSeed = pickDomain(`${slot.language}:${slot.difficulty}:${slot.topics.join(",")}:${slot.index}`);
    usedDomains.push(domainSeed);
    const title = problems[i]?.title;
    if (typeof title === "string" && title.trim()) usedTitles.push(title);
  }

  for (const slot of plan.slice(initialCount)) {
    const slotIntent = buildSlotIntent(slot);
    const domainSeed = pickDomain(`${slot.language}:${slot.difficulty}:${slot.topics.join(",")}:${slot.index}`);
    const promptContext: SlotPromptContext = {
      domain: domainSeed,
      avoidDomains: usedDomains.slice(-4),
      avoidTitles: usedTitles.slice(-4),
      ...(customInstructionsMd ? { customInstructionsMd } : {}),
    };

    const topic = slot.topics[0] ?? "topic";
    onProgress?.({
      type: "slot_started",
      slotIndex: slot.index,
      difficulty: slot.difficulty,
      topic,
      language: slot.language,
    });
    onProgress?.({ type: "problem_started", index: slot.index, difficulty: slot.difficulty });
    trace("generation.slot.plan", {
      slotIndex: slot.index,
      difficulty: slot.difficulty,
      topics: slot.topics,
      language: slot.language,
      problemStyle: slot.problem_style,
      domain: domainSeed,
    });

    try {
      const generatedResult = useInjectedLegacyGenerator
        ? await runInjectedLegacySlot(slot, promptContext, slotIntent)
        : {
            generated: await runSlotPipeline({
              slot,
              ...(promptContext ? { promptContext } : {}),
              ...(onProgress ? { onProgress } : {}),
            }),
            attempt: 1,
          };
      const { generated, attempt: finalAttempt } = generatedResult;
      if (useInjectedLegacyGenerator && slot.pedagogy) {
        generated.draft = { ...(await applyGuidedScaffoldingAsync(generated.draft, slot)), pedagogy: slot.pedagogy };
      }
      const problem = discardReferenceArtifacts(generated.draft);
      onProgress?.({
        type: "slot_attempt_summary",
        slotIndex: slot.index,
        attempt: finalAttempt,
        maxAttempts: defaultMaxAttempts,
        phase: "complete",
        status: "success",
        ...(typeof generated.meta.llmOutputHash === "string" ? { llmOutputHash: generated.meta.llmOutputHash } : {}),
        ...(generated.meta.llm ? { llm: generated.meta.llm } : {}),
        slotIntent,
        artifactSet: buildArtifactSet(generated.draft),
      });
      if (!useInjectedLegacyGenerator) {
        onProgress?.({
          type: "slot_evidence",
          slotIndex: slot.index,
          attempt: 1,
          obligations: deriveSlotObligations(slot).map((id) => ({ id, ok: true })),
        });
      }
      onProgress?.({ type: "slot_completed", slotIndex: slot.index });
      onProgress?.({ type: "problem_validated", index: slot.index });
      problems.push(problem);
      outcomes.push({ slotIndex: slot.index, success: true, retries: Math.max(0, finalAttempt - 1) });
      trace("generation.attempt.success", { slotIndex: slot.index, title: generated.draft.title });
    } catch (err: any) {
      console.warn(`Slot ${slot.index} staged pipeline failed:`, err?.message ?? err);
      const finalKind: GenerationFailureKind =
        err instanceof SlotPipelineTerminalError ? err.kind : inferFailureKind(err);
      const emitted = progressSummaryForFailure({
        slotIndex: slot.index,
        attempt: 1,
        maxAttempts: defaultMaxAttempts,
        err,
        ...(typeof err?.llmOutputHash === "string" ? { llmOutputHash: err.llmOutputHash } : {}),
        ...(err?.llm ? { llm: err.llm } : {}),
        slotIntent,
        final: true,
      });
      onProgress?.(emitted.summary);
      onProgress?.(emitted.failure);
      onProgress?.({
        type: "slot_failed_terminal",
        slotIndex: slot.index,
        stage: err instanceof SlotPipelineTerminalError ? err.stage : "reference",
        ...(err?.routeRole ? { routeRole: err.routeRole } : {}),
        failureKind: finalKind,
        terminationReason: err instanceof SlotPipelineTerminalError ? err.stage : "slot_pipeline",
        message: err instanceof Error ? err.message : String(err),
      });
      onProgress?.({ type: "problem_failed", index: slot.index });
      const failOutcome: GenerationOutcome = {
        slotIndex: slot.index,
        success: false,
        retries: 0,
      };
      throw new GenerationSlotFailureError(
        `Failed to generate slot ${slot.index}. Last error: ${err instanceof Error ? err.message : String(err)}`,
        {
          slotIndex: slot.index,
          kind: finalKind,
          attempts: 1,
          ...(typeof err?.title === "string" ? { title: err.title } : {}),
          ...(typeof err?.llmOutputHash === "string" ? { llmOutputHash: err.llmOutputHash } : {}),
          ...(err?.llm ? { llm: err.llm } : {}),
          outcomesSoFar: [...outcomes, failOutcome],
          problemsSoFar: [...problems],
        }
      );
    }

    usedDomains.push(domainSeed);
    usedTitles.push(problems[problems.length - 1]!.title);
    onCheckpoint?.({ problems, outcomes, completedSlotIndex: slot.index });
  }

  return { problems, outcomes };
}
