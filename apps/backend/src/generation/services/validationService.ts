import type { ProblemPlan } from "../../planner/types";
import type { GeneratedProblemDraft } from "../../contracts/problem";
import type { AttemptDiagnostic, SlotIntent } from "../../contracts/generationDiagnostics";
import type { CompletionMeta } from "../../infra/llm/types";
import {
  GenerationContractError,
  type GenerationFailureKind,
} from "../errors";
import {
  ReferenceSolutionValidationError,
  validateReferenceSolution,
} from "../referenceSolutionValidator";
import { TestStrengthGateError } from "../testStrengthGate";
import { isValidJUnit5TestSuiteCountRange, pruneJUnitTestMethods } from "../../languages/java/rules";
import { assertJavaStructuralTopicRequirements } from "../../languages/java/structuralTopics";

export function inferFailureKind(err: unknown): GenerationFailureKind {
  if (err instanceof ReferenceSolutionValidationError) return err.kind;
  if (err instanceof GenerationContractError) return "contract";
  if (err instanceof TestStrengthGateError) return "quality";
  if (/Invalid test_suite|schema validation|public class|Test suite class name/i.test(String((err as any)?.message))) {
    return "contract";
  }
  return "unknown";
}

export function recommendedRemediation(kind: GenerationFailureKind): string[] {
  if (kind === "compile") return ["Regenerate this slot", "Reduce difficulty for this slot"];
  if (kind === "tests") return ["Regenerate this slot", "Narrow topic scope"];
  if (kind === "timeout") return ["Regenerate this slot", "Reduce constraints and complexity"];
  if (kind === "contract") return ["Regenerate this slot", "Simplify prompt constraints"];
  if (kind === "quality") return ["Regenerate stronger tests", "Reduce requested hardness"];
  if (kind === "llm") return ["Retry this slot", "Switch to a stronger model"];
  return ["Retry this slot", "Narrow topic scope"];
}

export function validateInjectedDraftContract(slot: ProblemPlan[number], draft: GeneratedProblemDraft): void {
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

export async function validateDraftArtifacts(draft: GeneratedProblemDraft): Promise<void> {
  await validateReferenceSolution(draft);
}

export function progressSummaryForFailure(args: {
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

export function tryDropFailingJavaTests(
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
