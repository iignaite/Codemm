import crypto from "crypto";
import type { ProblemPlan } from "../planner/types";
import type { GeneratedProblem, GeneratedProblemDraft } from "../contracts/problem";
import type { GenerationOutcome } from "../contracts/generationOutcome";
import type { AttemptDiagnostic, GenerationArtifactSet, SlotIntent } from "../contracts/generationDiagnostics";
import { generateSingleProblem } from "./perSlotGenerator";
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
    const maxAttempts = defaultMaxAttempts;
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

    let problem: GeneratedProblem | null = null;
    let attempts = 0;
    let lastError: Error | null = null;
    let lastDraft: GeneratedProblemDraft | null = null;
    let lastLlmOutputHash: string | undefined;
    let lastLlmMeta: CompletionMeta | undefined;
    let lastAttemptExpensiveFingerprint: string | undefined;
    let lastExpensiveFailure:
      | { fingerprint: string; error: ReferenceSolutionValidationError | TestStrengthGateError }
      | null = null;
    let repair:
      | {
          previousDraft?: GeneratedProblemDraft;
          previousRaw?: string;
          errorMessage?: string;
          judgeStdout?: string;
          judgeStderr?: string;
        }
      | undefined;

    while (!problem && attempts < maxAttempts) {
      attempts++;
      try {
        trace("generation.attempt.start", { slotIndex: slot.index, attempts });
        onProgress?.({ type: "slot_llm_attempt_started", slotIndex: slot.index, attempt: attempts });
        onProgress?.({ type: "attempt_started", index: slot.index, attempt: attempts });
        // Step 1: Generate single problem via LLM (includes reference_solution)
        const generated = await generateSingleProblemFn(slot, {
          ...(repair ? { repair } : {}),
          promptContext,
        });
        const draft: GeneratedProblemDraft = generated.draft;
        lastDraft = draft;
        lastLlmOutputHash = generated.meta.llmOutputHash;
        lastLlmMeta = generated.meta.llm;
        onProgress?.({ type: "slot_contract_validated", slotIndex: slot.index, attempt: attempts });
        onProgress?.({
          type: "slot_evidence",
          slotIndex: slot.index,
          attempt: attempts,
          obligations: deriveSlotObligations(slot).map((id) => ({ id, ok: true })),
          ...(Array.isArray((generated.meta as any)?.rewrites) ? { rewrites: (generated.meta as any).rewrites } : {}),
        });

        // Avoid rerunning expensive Docker/quality checks when the reference artifacts + tests are identical.
        // This prevents "attempt thrash" where retries repeatedly validate the same payload.
        lastAttemptExpensiveFingerprint = computeExpensiveFingerprint(draft);
        if (
          lastExpensiveFailure &&
          lastExpensiveFailure.fingerprint === lastAttemptExpensiveFingerprint
        ) {
          trace("generation.attempt.deduped", {
            slotIndex: slot.index,
            attempts,
            kind: lastExpensiveFailure.error.name,
          });
          if (lastExpensiveFailure.error instanceof ReferenceSolutionValidationError) {
            onProgress?.({
              type: "slot_docker_validation_started",
              slotIndex: slot.index,
              attempt: attempts,
            });
            onProgress?.({ type: "validation_started", index: slot.index, attempt: attempts });
          }
          throw lastExpensiveFailure.error;
        }

        // Step 2: Validate reference_solution compiles and passes tests (Docker)
        onProgress?.({ type: "slot_docker_validation_started", slotIndex: slot.index, attempt: attempts });
        onProgress?.({ type: "validation_started", index: slot.index, attempt: attempts });
        await validateReferenceSolutionFn(draft);

        // Step 2B: Deterministic test strength gate (reject trivial baselines)
        await runTestStrengthGateFn(draft, slot);

        // Step 3: If guided pedagogy is present, derive the student-facing code/workspace
        // deterministically from the validated reference artifact.
        const finalizedDraft = slot.pedagogy
          ? { ...(await applyGuidedScaffoldingAsync(draft, slot)), pedagogy: slot.pedagogy }
          : draft;

        // Step 4: Discard reference_solution/reference_workspace (CRITICAL: do not persist)
        problem = discardReferenceArtifacts(finalizedDraft);
        onProgress?.({
          type: "slot_attempt_summary",
          slotIndex: slot.index,
          attempt: attempts,
          maxAttempts,
          phase: "complete",
          status: "success",
          ...(typeof generated.meta.llmOutputHash === "string" ? { llmOutputHash: generated.meta.llmOutputHash } : {}),
          ...(generated.meta.llm ? { llm: generated.meta.llm } : {}),
          slotIntent,
          artifactSet: buildArtifactSet(draft),
        });
        onProgress?.({ type: "slot_completed", slotIndex: slot.index });
        onProgress?.({ type: "problem_validated", index: slot.index });
        trace("generation.attempt.success", { slotIndex: slot.index, attempts, title: draft.title });
      } catch (err: any) {
        lastError = err;
        console.warn(
          `Slot ${slot.index} generation attempt ${attempts}/${maxAttempts} failed:`,
          err.message
        );

        if (err instanceof GenerationContractError) {
          onProgress?.({
            type: "slot_contract_failed",
            slotIndex: slot.index,
            attempt: attempts,
            shortError:
              typeof err.obligationId === "string" && err.obligationId
                ? `${err.obligationId}: ${String(err.message).slice(0, 220)}`
                : String(err.message).slice(0, 220) || "Contract validation failed.",
          });
          onProgress?.({
            type: "slot_evidence",
            slotIndex: slot.index,
            attempt: attempts,
            obligations: deriveSlotObligations(slot).map((id) => ({
              id,
              ok: id !== err.obligationId,
              ...(id === err.obligationId ? { message: String(err.message).slice(0, 360) } : {}),
            })),
          });
          onProgress?.({ type: "attempt_failed", index: slot.index, attempt: attempts, phase: "generate" });
          lastLlmOutputHash = err.llmOutputHash ?? lastLlmOutputHash;
          lastLlmMeta = err.llm ?? lastLlmMeta;
          repair = {
            ...(typeof err.rawSnippet === "string" ? { previousRaw: err.rawSnippet } : {}),
            ...(typeof err.message === "string" && err.message ? { errorMessage: err.message } : {}),
          };
          onProgress?.({
            type: "slot_repair_applied",
            slotIndex: slot.index,
            attempt: attempts,
            strategy: "retry_full_slot",
            detail: "Retrying generation with contract diagnostics.",
          });
        }

        if (err instanceof TestStrengthGateError) {
          if (typeof lastAttemptExpensiveFingerprint === "string" && lastAttemptExpensiveFingerprint) {
            lastExpensiveFailure = { fingerprint: lastAttemptExpensiveFingerprint, error: err };
          }
          onProgress?.({
            type: "slot_contract_failed",
            slotIndex: slot.index,
            attempt: attempts,
            shortError: "Test strength gate failed.",
          });
          onProgress?.({ type: "attempt_failed", index: slot.index, attempt: attempts, phase: "generate" });
          // Treat as a contract-equivalent failure to trigger targeted regeneration.
          repair = {
            ...(lastDraft ? { previousRaw: JSON.stringify(lastDraft).slice(0, 2400) } : {}),
            errorMessage: err.message,
          };
          onProgress?.({
            type: "slot_repair_applied",
            slotIndex: slot.index,
            attempt: attempts,
            strategy: "repair_test_suite",
            detail: "Retrying with stronger and non-trivial tests.",
          });
        }

        if (err instanceof ReferenceSolutionValidationError && lastDraft) {
          if (typeof lastAttemptExpensiveFingerprint === "string" && lastAttemptExpensiveFingerprint) {
            lastExpensiveFailure = { fingerprint: lastAttemptExpensiveFingerprint, error: err };
          }
          onProgress?.({
            type: "slot_docker_validation_failed",
            slotIndex: slot.index,
            attempt: attempts,
            shortError: err.kind === "compile" ? "Compilation failed." : err.kind === "tests" ? "Tests failed." : "Timed out.",
          });
          onProgress?.({ type: "validation_failed", index: slot.index, attempt: attempts });
          onProgress?.({ type: "attempt_failed", index: slot.index, attempt: attempts, phase: "validate" });
          repair = {
            previousDraft: lastDraft,
            judgeStdout: err.judgeStdout,
            judgeStderr: err.judgeStderr,
            errorMessage: err.message,
          };
          onProgress?.({
            type: "slot_repair_applied",
            slotIndex: slot.index,
            attempt: attempts,
            strategy: slot.language === "java" ? "repair_reference_solution" : "retry_full_slot",
            detail:
              slot.language === "java"
                ? "Applying targeted reference_solution repair."
                : "Retrying slot with validator feedback.",
          });
          trace("generation.attempt.repair", { slotIndex: slot.index, attempts, exitCode: err.exitCode });
        } else {
          if (!(err instanceof GenerationContractError) && !(err instanceof TestStrengthGateError)) {
            onProgress?.({ type: "attempt_failed", index: slot.index, attempt: attempts, phase: "generate" });
            repair = undefined;
          }
        }

        const finalAttempt = attempts >= maxAttempts;
        const emitted = progressSummaryForFailure({
          slotIndex: slot.index,
          attempt: attempts,
          maxAttempts,
          err,
          ...(typeof lastLlmOutputHash === "string" ? { llmOutputHash: lastLlmOutputHash } : {}),
          ...(lastLlmMeta ? { llm: lastLlmMeta } : {}),
          slotIntent,
          final: finalAttempt,
        });
        onProgress?.(emitted.summary);
        onProgress?.(emitted.failure);

        if (finalAttempt) {
          onProgress?.({ type: "problem_failed", index: slot.index });
          const kind: GenerationFailureKind = inferFailureKind(err);
          const failOutcome: GenerationOutcome = {
            slotIndex: slot.index,
            success: false,
            retries: Math.max(0, maxAttempts - 1),
          };
          throw new GenerationSlotFailureError(
            `Failed to generate slot ${slot.index} after ${maxAttempts} attempts. Last error: ${err.message}`,
            {
              slotIndex: slot.index,
              kind,
              attempts: maxAttempts,
              ...(typeof lastDraft?.title === "string" ? { title: lastDraft.title } : {}),
              ...(typeof lastLlmOutputHash === "string" ? { llmOutputHash: lastLlmOutputHash } : {}),
              ...(lastLlmMeta ? { llm: lastLlmMeta } : {}),
              outcomesSoFar: [...outcomes, failOutcome],
              problemsSoFar: [...problems],
            }
          );
        }
        // Retry
      }
    }

    if (!problem) {
      throw new Error(
        `Failed to generate slot ${slot.index}. Last error: ${lastError?.message ?? "unknown"}`
      );
    }

    problems.push(problem);
    outcomes.push({ slotIndex: slot.index, success: true, retries: Math.max(0, attempts - 1) });
    usedDomains.push(domainSeed);
    usedTitles.push(problem.title);
    onCheckpoint?.({ problems, outcomes, completedSlotIndex: slot.index });
  }

  return { problems, outcomes };
}
