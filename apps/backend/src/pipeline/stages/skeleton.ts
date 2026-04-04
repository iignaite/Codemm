import crypto from "crypto";
import { createCodemmCompletion, type CompletionMeta } from "../../infra/llm";
import type { ProblemSlot } from "../../planner/types";
import type { SlotPromptContext } from "../../languages/types";
import { tryParseJson } from "../../utils/jsonParser";
import { SlotSkeletonSchema, type SlotSkeleton, type SlotStageResult } from "../../contracts/slotPipeline";

export const SKELETON_PROMPT_TEMPLATE_ID = "slot-skeleton:v1";

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen)}…(truncated)`;
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export async function generateSkeleton(args: {
  slot: ProblemSlot;
  promptContext?: SlotPromptContext;
  attempt: number;
}): Promise<SlotStageResult<SlotSkeleton>> {
  const { slot } = args;
  const custom = typeof args.promptContext?.customInstructionsMd === "string" ? args.promptContext.customInstructionsMd.trim() : "";
  const customBlock = custom ? `\nCustom instructions (best-effort):\n${truncate(custom, 3000)}\n` : "";
  const system = `
You are Codemm's skeleton planner.

Return ONLY valid JSON with the exact shape requested by the user prompt.
Do not include code, tests, or hidden reference artifacts.
Keep the response deterministic and concise.
`.trim();

  const user = `
Generate exactly one problem skeleton for this slot.

Language: ${slot.language}
Difficulty: ${slot.difficulty}
Topics: ${slot.topics.join(", ")}
Problem style: ${slot.problem_style}
Constraints: ${slot.constraints}
${args.promptContext?.domain ? `Scenario seed: ${args.promptContext.domain}\n` : ""}${args.promptContext?.avoidDomains?.length ? `Avoid domains: ${args.promptContext.avoidDomains.join(", ")}\n` : ""}${args.promptContext?.avoidTitles?.length ? `Avoid titles similar to: ${args.promptContext.avoidTitles.join(" | ")}\n` : ""}${customBlock}
Return JSON with this exact shape:
{
  "language": "${slot.language}",
  "id": "unique-problem-id",
  "title": "Problem Title",
  "description": "Detailed problem description...",
  "constraints": "${slot.constraints}",
  "sample_inputs": ["input1"],
  "sample_outputs": ["output1"],
  "difficulty": "${slot.difficulty}",
  "topic_tag": "${slot.topics[0] ?? "topic"}"
}
`.trim();

  const completion = await createCodemmCompletion({
    system,
    user,
    role: "skeleton",
    attempt: args.attempt,
    temperature: 0.2,
    maxTokens: 1600,
  });

  const raw = completion.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  const parsed = tryParseJson(raw);
  const result = SlotSkeletonSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new Error(`Skeleton validation failed: ${first?.message ?? "invalid skeleton"}`);
  }
  const normalized: SlotSkeleton = {
    ...result.data,
    language: slot.language,
    constraints: slot.constraints,
    difficulty: slot.difficulty,
    topic_tag: slot.topics[0] ?? result.data.topic_tag,
  };
  return {
    value: normalized,
    ...(completion.meta ? { llm: completion.meta as CompletionMeta } : {}),
    llmOutputHash: sha256(raw),
    promptTemplateId: SKELETON_PROMPT_TEMPLATE_ID,
    artifactHash: sha256(JSON.stringify(normalized)),
  };
}
