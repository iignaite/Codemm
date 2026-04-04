import crypto from "crypto";
import type { GeneratedProblemDraft } from "../contracts/problem";
import { GeneratedProblemDraftSchema } from "../contracts/problem";
import type { SlotIntent } from "../contracts/generationDiagnostics";
import type {
  SlotDraftEnvelope,
  SlotReference,
  SlotSkeleton,
  SlotStageName,
  SlotStageResult,
  SlotTests,
} from "../contracts/slotPipeline";
import type { GenerationProgressEvent } from "../contracts/generationProgress";
import type { CompletionMeta, LlmRole } from "../infra/llm/types";
import { getResolvedSnapshotOrNull, getRouteForRole, summarizeRoutePlan } from "../infra/llm";
import type { ProblemSlot } from "../planner/types";
import type { SlotPromptContext } from "../languages/types";
import { buildDefaultClassSkeleton, inferClassName } from "../utils/javaCodegen";
import {
  ReferenceSolutionValidationError,
  validateReferenceSolution,
} from "../generation/referenceSolutionValidator";
import { runTestStrengthGate, TestStrengthGateError } from "../generation/testStrengthGate";
import { applyGuidedScaffoldingAsync } from "../generation/scaffolding";
import { getStageRetryPolicy } from "./retryPolicy";
import { generateReference, REFERENCE_PROMPT_TEMPLATE_ID, REPAIR_PROMPT_TEMPLATE_ID } from "./stages/reference";
import { generateSkeleton, SKELETON_PROMPT_TEMPLATE_ID } from "./stages/skeleton";
import { generateTests, TESTS_PROMPT_TEMPLATE_ID } from "./stages/tests";
import type { GenerationFailureKind } from "../generation/errors";

export class SlotPipelineTerminalError extends Error {
  stage: Exclude<SlotStageName, "complete">;
  kind: GenerationFailureKind;
  llm?: CompletionMeta;
  llmOutputHash?: string;
  routeRole?: LlmRole;
  title?: string;
  exitCode?: number;
  timedOut?: boolean;

  constructor(
    message: string,
    opts: {
      stage: Exclude<SlotStageName, "complete">;
      kind: GenerationFailureKind;
      llm?: CompletionMeta;
      llmOutputHash?: string;
      routeRole?: LlmRole;
      title?: string;
      exitCode?: number;
      timedOut?: boolean;
    }
  ) {
    super(message);
    this.name = "SlotPipelineTerminalError";
    this.stage = opts.stage;
    this.kind = opts.kind;
    if (opts.llm) this.llm = opts.llm;
    if (opts.llmOutputHash) this.llmOutputHash = opts.llmOutputHash;
    if (opts.routeRole) this.routeRole = opts.routeRole;
    if (opts.title) this.title = opts.title;
    if (typeof opts.exitCode === "number") this.exitCode = opts.exitCode;
    if (typeof opts.timedOut === "boolean") this.timedOut = opts.timedOut;
  }
}

type StageContext = {
  slot: ProblemSlot;
  promptContext?: SlotPromptContext;
  onProgress?: (event: GenerationProgressEvent) => void;
};

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function normalizeStyle(raw: string): "stdout" | "return" | "mixed" {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "stdout" || value === "mixed") return value;
  return "return";
}

function buildSlotIntent(slot: ProblemSlot): SlotIntent {
  return {
    slotIndex: slot.index,
    language: slot.language,
    difficulty: slot.difficulty,
    topics: [...slot.topics],
    constraints: slot.constraints,
    problemStyle: normalizeStyle(slot.problem_style),
    testCaseCount: slot.test_case_count,
  };
}

function inferFailureKind(err: unknown): GenerationFailureKind {
  if (err instanceof ReferenceSolutionValidationError) return err.kind;
  if (err instanceof TestStrengthGateError) return "quality";
  if (/timed out|timeout/i.test(String((err as any)?.message ?? ""))) return "timeout";
  if (/compile|syntax|cannot find symbol|must define|validation failed/i.test(String((err as any)?.message ?? ""))) return "contract";
  return "llm";
}

function maybeEmitRouteSelection(args: {
  slot: ProblemSlot;
  routeRole: LlmRole;
  promptTemplateId: string;
  onProgress?: (event: GenerationProgressEvent) => void;
}) {
  const routePlan = getResolvedSnapshotOrNull();
  const route = getRouteForRole(routePlan, args.routeRole);
  args.onProgress?.({
    type: "route_selected",
    slotIndex: args.slot.index,
    routeRole: args.routeRole,
    ...(routePlan?.provider ? { provider: routePlan.provider } : {}),
    ...(route?.model ? { model: route.model } : {}),
    ...(route?.capability ? { capability: route.capability } : {}),
    promptTemplateId: args.promptTemplateId,
  });
}

function assertRouteCompatibility(slot: ProblemSlot): void {
  const routePlan = getResolvedSnapshotOrNull();
  const route = getRouteForRole(routePlan, "skeleton");
  if (routePlan?.provider !== "ollama") return;
  if (route?.capability !== "weak") return;
  if (slot.difficulty === "hard" || slot.topics.length > 1) {
    throw new SlotPipelineTerminalError(
      "The selected local route is too weak for hard or multi-topic slots. Use a stronger route or simplify the request.",
      { stage: "skeleton", kind: "llm", routeRole: "skeleton" }
    );
  }
}

function derivePythonStarter(referenceSolution: string): string {
  const signature = /^\s*def\s+solve\s*\(([^)]*)\)\s*:/m.exec(referenceSolution)?.[1] ?? "*args, **kwargs";
  return `def solve(${signature}):\n    # TODO: implement\n    raise NotImplementedError\n`;
}

function deriveSqlStarter(): string {
  return "SELECT 1;";
}

function stripCppComments(source: string): string {
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlock.replace(/\/\/.*$/gm, "");
}

function extractCppSolveSignature(referenceSolution: string): string | null {
  const src = String(referenceSolution ?? "");
  if (!src.trim()) return null;
  const reSameLine = /(^|\n)\s*([A-Za-z_][\w:<>\s*&]+?)\s+solve\s*\(([\s\S]*?)\)\s*(?:const\s*)?\{/m;
  const match = reSameLine.exec(src);
  if (!match) return null;
  const returnType = match[2]?.replace(/\s+/g, " ").trim();
  const params = match[3]?.replace(/\s+/g, " ").trim();
  if (!returnType || params == null) return null;
  return `${returnType} solve(${params})`;
}

function deriveCppStarter(referenceSolution: string, fallbackTopic: string): string {
  const signature = extractCppSolveSignature(referenceSolution);
  if (!signature) {
    return `#include <bits/stdc++.h>\n\nint solve() {\n  // TODO: implement ${fallbackTopic}\n  return 0;\n}\n`;
  }
  return `#include <bits/stdc++.h>\n\n${signature} {\n  // TODO: implement ${fallbackTopic}\n  throw std::runtime_error("TODO");\n}\n`;
}

function deriveJavaStarter(referenceSolution: string): string {
  const className = inferClassName(referenceSolution, "Solution");
  return buildDefaultClassSkeleton(className);
}

function buildDraft(args: {
  slot: ProblemSlot;
  skeleton: SlotSkeleton;
  tests: SlotTests;
  reference: SlotReference;
}): GeneratedProblemDraft {
  if (args.slot.language === "python") {
    return {
      language: "python",
      id: args.skeleton.id,
      title: args.skeleton.title,
      description: args.skeleton.description,
      test_suite: args.tests.test_suite,
      constraints: args.slot.constraints,
      sample_inputs: args.skeleton.sample_inputs,
      sample_outputs: args.skeleton.sample_outputs,
      difficulty: args.slot.difficulty,
      topic_tag: args.slot.topics[0] ?? args.skeleton.topic_tag,
      starter_code: derivePythonStarter(args.reference.reference_solution),
      reference_solution: args.reference.reference_solution,
    };
  }
  if (args.slot.language === "cpp") {
    return {
      language: "cpp",
      id: args.skeleton.id,
      title: args.skeleton.title,
      description: args.skeleton.description,
      test_suite: args.tests.test_suite,
      constraints: args.slot.constraints,
      sample_inputs: args.skeleton.sample_inputs,
      sample_outputs: args.skeleton.sample_outputs,
      difficulty: args.slot.difficulty,
      topic_tag: args.slot.topics[0] ?? args.skeleton.topic_tag,
      starter_code: deriveCppStarter(args.reference.reference_solution, args.slot.topics[0] ?? "topic"),
      reference_solution: args.reference.reference_solution,
    };
  }
  if (args.slot.language === "sql") {
    return {
      language: "sql",
      id: args.skeleton.id,
      title: args.skeleton.title,
      description: args.skeleton.description,
      test_suite: args.tests.test_suite,
      constraints: args.slot.constraints,
      sample_inputs: args.skeleton.sample_inputs,
      sample_outputs: args.skeleton.sample_outputs,
      difficulty: args.slot.difficulty,
      topic_tag: args.slot.topics[0] ?? args.skeleton.topic_tag,
      starter_code: deriveSqlStarter(),
      reference_solution: args.reference.reference_solution,
    };
  }
  return {
    language: "java",
    id: args.skeleton.id,
    title: args.skeleton.title,
    description: args.skeleton.description,
    test_suite: args.tests.test_suite,
    constraints: args.slot.constraints,
    sample_inputs: args.skeleton.sample_inputs,
    sample_outputs: args.skeleton.sample_outputs,
    difficulty: args.slot.difficulty,
    topic_tag: args.slot.topics[0] ?? args.skeleton.topic_tag,
    starter_code: deriveJavaStarter(args.reference.reference_solution),
    reference_solution: args.reference.reference_solution,
  };
}

async function executeStage<T>(args: {
  stage: "skeleton" | "tests" | "reference" | "repair";
  routeRole: LlmRole;
  promptTemplateId: string;
  ctx: StageContext;
  runner: (attempt: number) => Promise<SlotStageResult<T>>;
}): Promise<SlotStageResult<T>> {
  const policy = getStageRetryPolicy(args.stage);
  let previousArtifactHash: string | undefined;
  let previousModel: string | undefined;

  maybeEmitRouteSelection({
    slot: args.ctx.slot,
    routeRole: args.routeRole,
    promptTemplateId: args.promptTemplateId,
    ...(args.ctx.onProgress ? { onProgress: args.ctx.onProgress } : {}),
  });

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const startedAt = new Date().toISOString();
    const routePlan = getResolvedSnapshotOrNull();
    const route = getRouteForRole(routePlan, args.routeRole, {
      escalationIndex: policy.allowEscalation && attempt > 1 ? 1 : 0,
    });
    if (args.stage !== "skeleton" && attempt > 1 && route?.model && previousModel && route.model !== previousModel) {
      args.ctx.onProgress?.({
        type: "slot_escalated",
        slotIndex: args.ctx.slot.index,
        stage: args.stage,
        routeRole: args.routeRole,
        fromModel: previousModel,
        toModel: route.model,
        reason: `Escalated ${args.stage} after the first failure.`,
      });
    }
    previousModel = route?.model;

    args.ctx.onProgress?.({
      type: "slot_stage_started",
      slotIndex: args.ctx.slot.index,
      stage: args.stage,
      attempt,
      routeRole: args.routeRole,
      ...(routePlan?.provider ? { provider: routePlan.provider } : {}),
      ...(route?.model ? { model: route.model } : {}),
      promptTemplateId: args.promptTemplateId,
      startedAt,
    });
    try {
      const result = await args.runner(attempt);
      if (
        policy.terminalOnRepeatedFingerprint &&
        result.artifactHash &&
        previousArtifactHash &&
        result.artifactHash === previousArtifactHash
      ) {
        throw new SlotPipelineTerminalError(
          `The ${args.stage} stage produced the same invalid artifact twice.`,
          { stage: args.stage, kind: "contract", routeRole: args.routeRole }
        );
      }
      previousArtifactHash = result.artifactHash;
      const endedAt = new Date().toISOString();
      args.ctx.onProgress?.({
        type: "slot_stage_finished",
        slotIndex: args.ctx.slot.index,
        stage: args.stage,
        attempt,
        status: "success",
        routeRole: args.routeRole,
        ...(routePlan?.provider ? { provider: routePlan.provider } : {}),
        ...(route?.model ? { model: route.model } : {}),
        promptTemplateId: result.promptTemplateId,
        startedAt,
        endedAt,
        durationMs: Date.parse(endedAt) - Date.parse(startedAt),
        ...(result.artifactHash ? { artifactHash: result.artifactHash } : {}),
      });
      return result;
    } catch (error) {
      const endedAt = new Date().toISOString();
      const terminal = error instanceof SlotPipelineTerminalError || attempt >= policy.maxAttempts;
      args.ctx.onProgress?.({
        type: "slot_stage_finished",
        slotIndex: args.ctx.slot.index,
        stage: args.stage,
        attempt,
        status: "failed",
        routeRole: args.routeRole,
        ...(routePlan?.provider ? { provider: routePlan.provider } : {}),
        ...(route?.model ? { model: route.model } : {}),
        promptTemplateId: args.promptTemplateId,
        startedAt,
        endedAt,
        durationMs: Date.parse(endedAt) - Date.parse(startedAt),
        failureKind: inferFailureKind(error),
        message: error instanceof Error ? error.message : String(error),
      });
      if (terminal) {
        throw error instanceof SlotPipelineTerminalError
          ? error
          : new SlotPipelineTerminalError(error instanceof Error ? error.message : String(error), {
              stage: args.stage,
              kind: inferFailureKind(error),
              routeRole: args.routeRole,
            });
      }
    }
  }
  throw new SlotPipelineTerminalError(`The ${args.stage} stage failed.`, {
    stage: args.stage,
    kind: "llm",
    routeRole: args.routeRole,
  });
}

async function validateDraftWithTelemetry(args: {
  ctx: StageContext;
  draft: GeneratedProblemDraft;
  attempt: number;
}): Promise<void> {
  const startedAt = new Date().toISOString();
  args.ctx.onProgress?.({
    type: "slot_stage_started",
    slotIndex: args.ctx.slot.index,
    stage: "validate",
    attempt: args.attempt,
    routeRole: "reference",
    promptTemplateId: "slot-validate:v1",
    startedAt,
  });
  try {
    await validateReferenceSolution(args.draft);
    await runTestStrengthGate(args.draft, args.ctx.slot);
    const endedAt = new Date().toISOString();
    args.ctx.onProgress?.({
      type: "slot_stage_finished",
      slotIndex: args.ctx.slot.index,
      stage: "validate",
      attempt: args.attempt,
      status: "success",
      routeRole: "reference",
      promptTemplateId: "slot-validate:v1",
      startedAt,
      endedAt,
      durationMs: Date.parse(endedAt) - Date.parse(startedAt),
    });
  } catch (error) {
    const endedAt = new Date().toISOString();
    const kind = inferFailureKind(error);
    args.ctx.onProgress?.({
      type: "slot_stage_finished",
      slotIndex: args.ctx.slot.index,
      stage: "validate",
      attempt: args.attempt,
      status: "failed",
      routeRole: "reference",
      promptTemplateId: "slot-validate:v1",
      startedAt,
      endedAt,
      durationMs: Date.parse(endedAt) - Date.parse(startedAt),
      failureKind: kind,
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof ReferenceSolutionValidationError && error.exitCode !== undefined ? { exitCode: error.exitCode } : {}),
      ...(error instanceof ReferenceSolutionValidationError ? { timedOut: error.kind === "timeout" } : {}),
    });
    throw error;
  }
}

export async function runSlotPipeline(args: {
  slot: ProblemSlot;
  promptContext?: SlotPromptContext;
  onProgress?: (event: GenerationProgressEvent) => void;
}): Promise<{
  envelope: SlotDraftEnvelope;
  draft: GeneratedProblemDraft;
  meta: {
    llm?: CompletionMeta;
    llmOutputHash?: string;
    promptTemplateId: string;
    routePlan: Record<string, unknown> | null;
  };
}> {
  assertRouteCompatibility(args.slot);
  const ctx: StageContext = {
    slot: args.slot,
    ...(args.promptContext ? { promptContext: args.promptContext } : {}),
    ...(args.onProgress ? { onProgress: args.onProgress } : {}),
  };
  const slotIntent = buildSlotIntent(args.slot);
  const envelope: SlotDraftEnvelope = { slotIntent };

  const skeleton = await executeStage({
    stage: "skeleton",
    routeRole: "skeleton",
    promptTemplateId: SKELETON_PROMPT_TEMPLATE_ID,
    ctx,
    runner: (attempt) =>
      generateSkeleton({
        slot: args.slot,
        ...(args.promptContext ? { promptContext: args.promptContext } : {}),
        attempt,
      }),
  });
  envelope.skeleton = skeleton.value;

  const tests = await executeStage({
    stage: "tests",
    routeRole: "tests",
    promptTemplateId: TESTS_PROMPT_TEMPLATE_ID,
    ctx,
    runner: (attempt) =>
      generateTests({
        slot: args.slot,
        skeleton: envelope.skeleton as SlotSkeleton,
        attempt,
      }),
  });
  envelope.tests = tests.value;

  maybeEmitRouteSelection({
    slot: args.slot,
    routeRole: "reference",
    promptTemplateId: REFERENCE_PROMPT_TEMPLATE_ID,
    ...(args.onProgress ? { onProgress: args.onProgress } : {}),
  });
  let reference = await executeStage({
    stage: "reference",
    routeRole: "reference",
    promptTemplateId: REFERENCE_PROMPT_TEMPLATE_ID,
    ctx,
    runner: (attempt) =>
      generateReference({
        slot: args.slot,
        skeleton: envelope.skeleton as SlotSkeleton,
        tests: envelope.tests as SlotTests,
        attempt,
      }),
  });
  envelope.reference = reference.value;

  let draft = buildDraft({
    slot: args.slot,
    skeleton: envelope.skeleton as SlotSkeleton,
    tests: envelope.tests as SlotTests,
    reference: envelope.reference as SlotReference,
  });
  const parsedDraft = GeneratedProblemDraftSchema.safeParse(draft);
  if (!parsedDraft.success) {
    throw new SlotPipelineTerminalError(
      `Reference artifact did not produce a valid draft: ${parsedDraft.error.issues[0]?.message ?? "invalid draft"}`,
      {
        stage: "reference",
        kind: "contract",
        ...(reference.llm ? { llm: reference.llm } : {}),
        ...(reference.llmOutputHash ? { llmOutputHash: reference.llmOutputHash } : {}),
        routeRole: "reference",
        title: draft.title,
      }
    );
  }
  draft = parsedDraft.data;

  try {
    await validateDraftWithTelemetry({ ctx, draft, attempt: 1 });
  } catch (error) {
    if (!(error instanceof ReferenceSolutionValidationError)) {
      throw new SlotPipelineTerminalError(error instanceof Error ? error.message : String(error), {
        stage: "validate",
        kind: inferFailureKind(error),
        ...(reference.llm ? { llm: reference.llm } : {}),
        ...(reference.llmOutputHash ? { llmOutputHash: reference.llmOutputHash } : {}),
        routeRole: "reference",
        title: draft.title,
      });
    }

    maybeEmitRouteSelection({
      slot: args.slot,
      routeRole: "repair",
      promptTemplateId: REPAIR_PROMPT_TEMPLATE_ID,
      ...(args.onProgress ? { onProgress: args.onProgress } : {}),
    });
    const repair = await executeStage({
      stage: "repair",
      routeRole: "repair",
      promptTemplateId: REPAIR_PROMPT_TEMPLATE_ID,
      ctx,
      runner: (attempt) =>
        generateReference({
          slot: args.slot,
          skeleton: envelope.skeleton as SlotSkeleton,
          tests: envelope.tests as SlotTests,
          previousReference: (envelope.reference as SlotReference).reference_solution,
          errorMessage: error.message,
          ...(error.judgeStdout ? { judgeStdout: error.judgeStdout } : {}),
          ...(error.judgeStderr ? { judgeStderr: error.judgeStderr } : {}),
          attempt,
          role: "repair",
        }),
    });
    envelope.reference = repair.value;
    reference = repair;
    draft = buildDraft({
      slot: args.slot,
      skeleton: envelope.skeleton as SlotSkeleton,
      tests: envelope.tests as SlotTests,
      reference: envelope.reference as SlotReference,
    });
    const repairedDraft = GeneratedProblemDraftSchema.safeParse(draft);
    if (!repairedDraft.success) {
      throw new SlotPipelineTerminalError(
        `Repair did not produce a valid draft: ${repairedDraft.error.issues[0]?.message ?? "invalid draft"}`,
        {
          stage: "repair",
          kind: "contract",
          ...(repair.llm ? { llm: repair.llm } : {}),
          ...(repair.llmOutputHash ? { llmOutputHash: repair.llmOutputHash } : {}),
          routeRole: "repair",
          title: draft.title,
        }
      );
    }
    draft = repairedDraft.data;
    try {
      await validateDraftWithTelemetry({ ctx, draft, attempt: 2 });
    } catch (repairError) {
      throw new SlotPipelineTerminalError(repairError instanceof Error ? repairError.message : String(repairError), {
        stage: "repair",
        kind: inferFailureKind(repairError),
        ...(repair.llm ? { llm: repair.llm } : {}),
        ...(repair.llmOutputHash ? { llmOutputHash: repair.llmOutputHash } : {}),
        routeRole: "repair",
        title: draft.title,
        ...(repairError instanceof ReferenceSolutionValidationError && repairError.exitCode !== undefined
          ? { exitCode: repairError.exitCode }
          : {}),
        ...(repairError instanceof ReferenceSolutionValidationError && repairError.kind === "timeout" ? { timedOut: true } : {}),
      });
    }
  }

  if (args.slot.pedagogy) {
    draft = { ...(await applyGuidedScaffoldingAsync(draft, args.slot)), pedagogy: args.slot.pedagogy };
  }
  envelope.learnerArtifact = draft;
  envelope.validationState = {
    validatedAt: new Date().toISOString(),
    docker: {
      stdoutHash: sha256(JSON.stringify({ slotIndex: args.slot.index, title: draft.title })),
    },
  };

  return {
    envelope,
    draft,
    meta: {
      ...(reference.llm ? { llm: reference.llm } : {}),
      ...(reference.llmOutputHash ? { llmOutputHash: reference.llmOutputHash } : {}),
      promptTemplateId: reference.promptTemplateId,
      routePlan: summarizeRoutePlan(getResolvedSnapshotOrNull()),
    },
  };
}
