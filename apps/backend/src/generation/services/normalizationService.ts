import crypto from "crypto";
import type { ProblemPlan } from "../../planner/types";
import type { GeneratedProblem, GeneratedProblemDraft } from "../../contracts/problem";
import type { GenerationArtifactSet, SlotIntent } from "../../contracts/generationDiagnostics";

export function discardReferenceArtifacts(draft: GeneratedProblemDraft): GeneratedProblem {
  if ("reference_solution" in draft) {
    const { reference_solution, ...rest } = draft;
    return rest;
  }
  const { reference_workspace, ...rest } = draft;
  return rest;
}

export function sha256Short(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function buildSlotIntent(slot: ProblemPlan[number]): SlotIntent {
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

export function buildArtifactSet(draft: GeneratedProblemDraft): GenerationArtifactSet {
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
