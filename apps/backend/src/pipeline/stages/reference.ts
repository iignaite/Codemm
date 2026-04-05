import crypto from "crypto";
import { createCodemmCompletion, type CompletionMeta } from "../../infra/llm";
import type { SlotReference, SlotSkeleton, SlotStageResult, SlotTests } from "../../contracts/slotPipeline";
import type { ProblemSlot } from "../../planner/types";
import { tryParseJson } from "../../utils/jsonParser";

export const REFERENCE_PROMPT_TEMPLATE_ID = "slot-reference:v1";
export const REPAIR_PROMPT_TEMPLATE_ID = "slot-repair:v1";

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function buildReferenceInstructions(slot: ProblemSlot): string {
  if (slot.language === "java") {
    return [
      "Return JSON: {\"reference_solution\":\"...\"}.",
      "Java 17 only. No package declarations.",
      "Declare at most one top-level public type.",
      "Reference code must match the class and method names implied by the test suite.",
    ].join("\n");
  }
  if (slot.language === "python") {
    return [
      "Return JSON: {\"reference_solution\":\"...\"}.",
      "Define solve(...). No input(), no sys.stdin.*, no randomness.",
      "Match the solve(...) usage expected by the test suite exactly.",
    ].join("\n");
  }
  if (slot.language === "cpp") {
    return [
      "Return JSON: {\"reference_solution\":\"...\"}.",
      "Define solve(...). Do not define main().",
      "Do not read from stdin.",
      "Match the signatures implied by the test suite exactly.",
    ].join("\n");
  }
  return [
    "Return JSON: {\"reference_solution\":\"...\"}.",
    "Return one read-only SQLite query (WITH/SELECT only).",
    "Make the query satisfy the provided SQL test suite exactly.",
  ].join("\n");
}

export async function generateReference(args: {
  slot: ProblemSlot;
  skeleton: SlotSkeleton;
  tests: SlotTests;
  previousReference?: string;
  errorMessage?: string;
  judgeStdout?: string;
  judgeStderr?: string;
  attempt: number;
  role?: "reference" | "repair";
}): Promise<SlotStageResult<SlotReference>> {
  const { slot, skeleton, tests } = args;
  const isRepair = (args.role ?? "reference") === "repair";
  const system = `
You are Codemm's ${isRepair ? "reference repair" : "reference artifact"} generator.

Return ONLY valid JSON and follow the exact schema requested by the user prompt.
Do not include explanations, markdown, or extra keys.
`.trim();
  const repairBlock =
    typeof args.previousReference === "string" && args.previousReference.trim()
      ? `\nPrevious reference artifact:\n${args.previousReference}\n${args.errorMessage ? `Failure reason:\n${args.errorMessage}\n` : ""}${args.judgeStdout ? `STDOUT:\n${args.judgeStdout.slice(0, 1800)}\n` : ""}${args.judgeStderr ? `STDERR:\n${args.judgeStderr.slice(0, 1800)}\n` : ""}`
      : "";
  const user = `
Create the hidden reference artifact for this slot.

Language: ${slot.language}
Difficulty: ${slot.difficulty}
Topics: ${slot.topics.join(", ")}
Problem style: ${slot.problem_style}
Constraints: ${slot.constraints}

Title: ${skeleton.title}
Description:
${skeleton.description}

Samples:
${skeleton.sample_inputs.map((input, index) => `- Input ${index + 1}: ${input}\n  Output ${skeleton.sample_outputs[index] ?? ""}`).join("\n")}

Test artifact (must satisfy exactly):
${tests.test_suite}
${repairBlock}

${buildReferenceInstructions(slot)}
`.trim();

  const completion = await createCodemmCompletion({
    system,
    user,
    role: args.role ?? "reference",
    attempt: args.attempt,
    temperature: isRepair ? 0.2 : 0.15,
    maxTokens: 3200,
  });
  const raw = completion.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  const parsed = tryParseJson(raw) as { reference_solution?: unknown } | null;
  const referenceSolution = typeof parsed?.reference_solution === "string" ? parsed.reference_solution.trim() : "";
  if (!referenceSolution) {
    throw new Error(`Reference artifact validation failed for ${slot.language}.`);
  }
  return {
    value: { reference_solution: referenceSolution },
    ...(completion.meta ? { llm: completion.meta as CompletionMeta } : {}),
    llmOutputHash: sha256(raw),
    promptTemplateId: isRepair ? REPAIR_PROMPT_TEMPLATE_ID : REFERENCE_PROMPT_TEMPLATE_ID,
    artifactHash: sha256(referenceSolution),
  };
}
