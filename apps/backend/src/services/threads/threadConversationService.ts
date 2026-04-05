import crypto from "crypto";
import { applyJsonPatch, type JsonPatchOp } from "../../compiler/jsonPatch";
import { ActivitySpecDraftSchema, ensureFixedFields, isSpecCompleteForGeneration } from "../../compiler/specDraft";
import type { ActivitySpec } from "../../contracts/activitySpec";
import type { SpecDraft } from "../../compiler/specDraft";
import { trace, traceText } from "../../utils/trace";
import { withTraceContext } from "../../utils/traceContext";
import type { ConfidenceMap } from "../../agent/readiness";
import { USER_EDITABLE_SPEC_KEYS, type UserEditableSpecKey } from "../../agent/dialogue";
import { logConversationMessage } from "../../utils/devLogs";
import { runDialogueTurn } from "../dialogueService";
import { analyzeSpecGaps, defaultNextQuestionFromGaps } from "../../agent/specAnalysis";
import { parseDifficultyPlanShorthand } from "../../agent/difficultyPlanParser";
import { adjustNeedsConfirmationFields } from "../confirmationFlow";
import {
  serializeCommitments,
  upsertCommitment,
  removeCommitment,
  type CommitmentStore,
  parseCommitmentsJson,
} from "../../agent/commitments";
import {
  appendIntentTrace,
  getCollectorState,
  inferCommitmentSource,
  isPureConfirmationMessage,
  parsePendingConfirmation,
  parseJsonArray,
  parseJsonObject,
  parseSpecJson,
  persistCollectorState,
  requireSession,
  serializePendingConfirmation,
  transitionOrThrow,
} from "./shared";
import { threadMessageRepository, threadRepository } from "../../database/repositories/threadRepository";

export type ProcessMessageResponse =
  | {
      accepted: false;
      state: string;
      nextQuestion: string;
      questionKey: string | null;
      done: false;
      error: string;
      spec: Record<string, unknown>;
      assistant_summary?: string;
      assumptions?: string[];
      next_action?: string;
    }
  | {
      accepted: true;
      state: string;
      nextQuestion: string;
      questionKey: string | null;
      done: boolean;
      spec: Record<string, unknown>;
      patch: JsonPatchOp[];
      assistant_summary?: string;
      assumptions?: string[];
      next_action?: string;
    };

export async function processSessionMessage(
  sessionId: string,
  message: string
): Promise<ProcessMessageResponse> {
  return withTraceContext({ sessionId }, async () => {
    const session = requireSession(sessionId);
    const state = session.state;
    trace("session.message.start", { sessionId, state });
    traceText("session.message.user", message, { extra: { sessionId } });

    if (state !== "DRAFT" && state !== "CLARIFYING") {
      const err = new Error(`Cannot post messages when session state is ${state}.`);
      (err as any).status = 409;
      throw err;
    }

    const currentSpec = parseSpecJson(session.spec_json);
    const existingConfidence = parseJsonObject(session.confidence_json) as ConfidenceMap;
    let commitmentsStore: CommitmentStore = parseCommitmentsJson(session.commitments_json);

    const persistMessage = (role: "user" | "assistant", content: string) => {
      threadMessageRepository.create(crypto.randomUUID(), sessionId, role, content);
      logConversationMessage({ sessionId, role, content });
    };

    persistMessage("user", message);

    const fixed = ensureFixedFields(currentSpec as SpecDraft);
    const specWithFixed = fixed.length > 0 ? applyJsonPatch(currentSpec as any, fixed) : currentSpec;
    trace("session.spec.fixed", { sessionId, fixedOps: fixed.map((op) => op.path) });

    const existingTrace = parseJsonArray(session.intent_trace_json);
    const effectiveConfidence: ConfidenceMap = { ...existingConfidence };

    threadRepository.updateSpecJson(sessionId, JSON.stringify(specWithFixed));

    const historyRows = threadMessageRepository.findByThreadId(sessionId).slice(-30);
    const history = historyRows.map((historyMessage) => ({
      role: historyMessage.role as "user" | "assistant",
      content: historyMessage.content as string,
    }));

    const collector = getCollectorState(sessionId);
    const currentQuestionKey = collector.currentQuestionKey;

    let deterministicPatch: Record<string, unknown> = {};
    let deterministicDifficultyExplicitTotal = false;
    const currentProblemCount = (specWithFixed as any).problem_count;
    const parsedDifficulty = parseDifficultyPlanShorthand({
      text: message,
      ...(typeof currentProblemCount === "number" && Number.isFinite(currentProblemCount)
        ? { currentProblemCount }
        : {}),
    });
    if (parsedDifficulty) {
      deterministicPatch = parsedDifficulty.patch as Record<string, unknown>;
      deterministicDifficultyExplicitTotal = parsedDifficulty.explicitTotal;
      trace("session.difficulty_plan.parsed_shorthand", {
        sessionId,
        explicitTotal: parsedDifficulty.explicitTotal,
        keys: Object.keys(parsedDifficulty.patch),
      });
    }

    const dialogue = await runDialogueTurn({
      sessionState: state,
      currentSpec: specWithFixed as SpecDraft,
      conversationHistory: history,
      latestUserMessage: message,
    });

    const traceEntry = {
      ts: new Date().toISOString(),
      type: "dialogue_turn",
      proposedPatch: dialogue.proposedPatch,
      needsConfirmation: dialogue.needsConfirmation ?? null,
    };
    const nextTrace = appendIntentTrace(existingTrace, traceEntry);
    threadRepository.updateIntentTraceJson(sessionId, JSON.stringify(nextTrace));

    const pending = parsePendingConfirmation(collector.buffer);
    const isConfirmKey = typeof currentQuestionKey === "string" && currentQuestionKey.startsWith("confirm:");
    const userConfirmedPending = Boolean(isConfirmKey && pending && isPureConfirmationMessage(message));

    const proposed: Record<string, unknown> = userConfirmedPending
      ? pending!.patch
      : ((dialogue.proposedPatch ?? {}) as Record<string, unknown>);

    const mergedProposed: Record<string, unknown> =
      Object.keys(deterministicPatch).length > 0 ? { ...proposed, ...deterministicPatch } : proposed;

    let needsConfirmationFields = userConfirmedPending
      ? []
      : Array.isArray(dialogue.needsConfirmation)
        ? dialogue.needsConfirmation
        : [];
    needsConfirmationFields = adjustNeedsConfirmationFields({
      needsConfirmationFields,
      currentQuestionKey: currentQuestionKey ?? null,
      pending,
      deterministicPatch,
      deterministicDifficultyExplicitTotal,
    });

    if (userConfirmedPending) {
      trace("session.confirmation.resolved", {
        sessionId,
        fields: pending!.fields,
        appliedKeys: Object.keys(pending!.patch ?? {}),
      });
    }

    const buildOpsFromPartial = (base: SpecDraft, partial: Record<string, unknown>): JsonPatchOp[] => {
      const ops: JsonPatchOp[] = [];
      for (const [key, value] of Object.entries(partial)) {
        if (value === undefined) continue;
        const path = `/${key}`;
        const exists = Object.prototype.hasOwnProperty.call(base, key) && (base as any)[key] !== undefined;
        ops.push({ op: exists ? "replace" : "add", path, value });
      }
      return ops;
    };

    const buildNextQuestion = (spec: SpecDraft): { key: string; prompt: string } | null => {
      const gaps = analyzeSpecGaps(spec);
      if (gaps.complete) return null;
      const prompt = defaultNextQuestionFromGaps(gaps);
      const priority: (keyof ActivitySpec)[] = ["language", "problem_count", "difficulty_plan", "topic_tags"];
      const next = priority.find((key) => gaps.missing.includes(key)) ?? (gaps.missing[0] as keyof ActivitySpec | undefined);
      return { key: next ? String(next) : "unknown", prompt };
    };

    const buildConfirmationPrompt = (fields: string[], proposedPatch: Record<string, unknown>): string => {
      if (fields.includes("language")) {
        const suggested = typeof proposedPatch.language === "string" ? proposedPatch.language : null;
        return `Confirm the language${suggested ? ` (${suggested})` : ""} you want to use.`;
      }
      if (fields.includes("problem_count")) return "Confirm how many problems you want (1-7).";
      if (fields.includes("difficulty_plan")) {
        return "Confirm the difficulty split you want to use (for example: easy:2, medium:2, hard:1).";
      }
      if (fields.includes("topic_tags")) return "Confirm the topics you want to focus on.";
      return "Confirm the change you want to make.";
    };

    const buildAssistantSummary = (args: {
      proposedPatch: Record<string, unknown>;
      appliedOps?: JsonPatchOp[];
      parseSource: "deterministic" | "llm";
    }): string => {
      const changedKeys = Array.isArray(args.appliedOps)
        ? args.appliedOps.map((op) => (op.path.startsWith("/") ? op.path.slice(1) : op.path)).filter(Boolean)
        : Object.keys(args.proposedPatch ?? {});
      if (changedKeys.length === 0) {
        return args.parseSource === "deterministic"
          ? "I did not see a safe spec update in that message."
          : "I could not safely infer a spec update from that message.";
      }
      return `Captured updates for: ${Array.from(new Set(changedKeys)).join(", ")}.`;
    };

    if (needsConfirmationFields.length > 0) {
      const fields = needsConfirmationFields.slice().sort();
      const nextKey = `confirm:${fields.join(",")}`;
      const prompt = buildConfirmationPrompt(fields, mergedProposed);
      const assistantText = [
        buildAssistantSummary({
          proposedPatch: mergedProposed,
          parseSource: dialogue.parseSource,
        }),
        prompt,
      ]
        .filter(Boolean)
        .join("\n\n");

      const pendingConfirm = {
        kind: "pending_confirmation" as const,
        fields: fields as UserEditableSpecKey[],
        patch: mergedProposed,
      };

      trace("session.confirmation.pending", {
        sessionId,
        fields,
        candidateKeys: Object.keys(mergedProposed ?? {}),
      });

      persistMessage("assistant", assistantText);
      persistCollectorState(sessionId, {
        currentQuestionKey: nextKey,
        buffer: serializePendingConfirmation(pendingConfirm),
      });

      const target = "CLARIFYING";
      transitionOrThrow(state, target);
      threadRepository.updateState(sessionId, target);

      return {
        accepted: true,
        state: target,
        nextQuestion: assistantText,
        questionKey: nextKey,
        done: false,
        spec: specWithFixed,
        patch: fixed,
        next_action: "confirm",
      };
    }

    let appliedUserOps: JsonPatchOp[] = [];
    let nextSpec: SpecDraft = specWithFixed as SpecDraft;
    const userOps = buildOpsFromPartial(specWithFixed as SpecDraft, mergedProposed as any);

    const applyWithDraftValidation = (ops: JsonPatchOp[]) => {
      const merged = ops.length > 0 ? (applyJsonPatch(specWithFixed as any, ops) as SpecDraft) : (specWithFixed as SpecDraft);
      const fixedAfter = ensureFixedFields(merged);
      const final = fixedAfter.length > 0 ? (applyJsonPatch(merged as any, fixedAfter) as SpecDraft) : merged;
      return { final };
    };

    if (userOps.length > 0) {
      const candidate = applyWithDraftValidation(userOps);
      const res = ActivitySpecDraftSchema.safeParse(candidate.final);
      if (res.success) {
        nextSpec = candidate.final;
        appliedUserOps = userOps;
      } else {
        const invalidKeys = Array.from(
          new Set(res.error.issues.map((issue) => (issue.path?.[0] != null ? String(issue.path[0]) : "")))
        ).filter(Boolean);
        const filtered: Record<string, unknown> = { ...proposed };
        for (const key of invalidKeys) delete filtered[key];
        const ops2 = buildOpsFromPartial(specWithFixed as SpecDraft, filtered);
        const candidate2 = applyWithDraftValidation(ops2);
        const res2 = ActivitySpecDraftSchema.safeParse(candidate2.final);
        if (res2.success) {
          nextSpec = candidate2.final;
          appliedUserOps = ops2;
        } else {
          nextSpec = specWithFixed as SpecDraft;
          appliedUserOps = [];
        }
      }
    }

    trace("session.spec.user_patch_applied", {
      sessionId,
      appliedOps: appliedUserOps.map((op) => op.path),
    });

    threadRepository.updateSpecJson(sessionId, JSON.stringify(nextSpec));

    for (const op of appliedUserOps) {
      const key = op.path.startsWith("/") ? op.path.slice(1) : op.path;
      if (!key) continue;
      effectiveConfidence[key] = 1;
    }
    threadRepository.updateConfidenceJson(sessionId, JSON.stringify(effectiveConfidence));

    for (const op of appliedUserOps) {
      if (!op.path.startsWith("/")) continue;
      const key = op.path.slice(1) as UserEditableSpecKey;
      if (!(USER_EDITABLE_SPEC_KEYS as readonly string[]).includes(key)) continue;

      if (op.op === "remove") {
        commitmentsStore = removeCommitment(commitmentsStore, key as any);
        continue;
      }

      const value = (nextSpec as any)[key];
      const source = inferCommitmentSource({ field: key, userMessage: message, currentQuestionKey });
      commitmentsStore = upsertCommitment(commitmentsStore, {
        field: key,
        value,
        confidence: 1,
        source,
      });
    }
    threadRepository.updateCommitmentsJson(sessionId, serializeCommitments(commitmentsStore));

    const done = isSpecCompleteForGeneration(nextSpec as SpecDraft);
    const nextQuestion = done ? null : buildNextQuestion(nextSpec as SpecDraft);
    const nextKey = done ? "ready" : nextQuestion?.key ?? null;

    const assistantText = [
      buildAssistantSummary({
        proposedPatch: mergedProposed,
        appliedOps: appliedUserOps,
        parseSource: dialogue.parseSource,
      }),
      done ? "Spec looks complete. You can generate the activity." : nextQuestion?.prompt,
    ]
      .filter(Boolean)
      .join("\n\n");

    persistMessage("assistant", assistantText);
    persistCollectorState(sessionId, { currentQuestionKey: nextKey, buffer: [] });

    if (!done) {
      const target = "CLARIFYING";
      transitionOrThrow(state, target);
      threadRepository.updateState(sessionId, target);
      return {
        accepted: true,
        state: target,
        nextQuestion: assistantText,
        questionKey: nextKey,
        done: false,
        spec: nextSpec,
        patch: [...fixed, ...appliedUserOps],
        next_action: "ask",
      };
    }

    if (state === "DRAFT") {
      transitionOrThrow("DRAFT", "CLARIFYING");
      threadRepository.updateState(sessionId, "CLARIFYING");
      transitionOrThrow("CLARIFYING", "READY");
      threadRepository.updateState(sessionId, "READY");
    } else {
      transitionOrThrow(state, "READY");
      threadRepository.updateState(sessionId, "READY");
    }

    return {
      accepted: true,
      state: "READY",
      nextQuestion: assistantText,
      questionKey: nextKey,
      done: true,
      spec: nextSpec,
      patch: [...fixed, ...appliedUserOps],
      next_action: "ready",
    };
  });
}

export const processThreadMessage = processSessionMessage;
