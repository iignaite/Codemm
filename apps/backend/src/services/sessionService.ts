import crypto from "crypto";
import { activityDb, threadCollectorDb, threadDb, threadMessageDb } from "../database";
import { canTransition, type SessionState } from "../contracts/session";
import { applyJsonPatch, type JsonPatchOp } from "../compiler/jsonPatch";
import { ActivitySpecSchema, type ActivitySpec } from "../contracts/activitySpec";
import { isLanguageSupportedForGeneration } from "../languages/profiles";
import { deriveProblemPlan } from "../planner";
import { generateProblemsFromPlan } from "../generation";
import type { GeneratedProblem } from "../contracts/problem";
import type { SpecDraft } from "../compiler/specDraft";
import { ActivitySpecDraftSchema, ensureFixedFields, isSpecCompleteForGeneration } from "../compiler/specDraft";
import { trace, traceText } from "../utils/trace";
import { withTraceContext } from "../utils/traceContext";
import type { ConfidenceMap } from "../agent/readiness";
import { proposeGenerationFallbackWithPolicy } from "../agent/generationFallback";
import { GenerationSlotFailureError } from "../generation/errors";
import { USER_EDITABLE_SPEC_KEYS, type UserEditableSpecKey } from "../agent/dialogue";
import { publishGenerationProgress } from "../generation/progressBus";
import type { GenerationProgressEvent } from "../contracts/generationProgress";
import type { GenerationOutcome } from "../contracts/generationOutcome";
import {
  listCommitments,
  parseCommitmentsJson,
  removeCommitment,
  serializeCommitments,
  upsertCommitment,
  type CommitmentStore,
} from "../agent/commitments";
import { DEFAULT_LEARNING_MODE, LearningModeSchema, type LearningMode } from "../contracts/learningMode";
import { buildGuidedPedagogyPolicy } from "../planner/pedagogy";
import { logConversationMessage } from "../utils/devLogs";
import { runDialogueTurn } from "./dialogueService";
import { analyzeSpecGaps, defaultNextQuestionFromGaps } from "../agent/specAnalysis";
import { parseDifficultyPlanShorthand } from "../agent/difficultyPlanParser";
import { adjustNeedsConfirmationFields } from "./confirmationFlow";

export type SessionRecord = {
  id: string;
  state: SessionState;
  learning_mode: LearningMode;
  spec: Record<string, unknown>;
  instructions_md: string | null;
  messages: { id: string; role: "user" | "assistant"; content: string; created_at: string }[];
  collector: { currentQuestionKey: string | null; buffer: string[] };
  confidence: Record<string, number>;
  commitments: ReturnType<typeof listCommitments>;
  generationOutcomes: GenerationOutcome[];
  intentTrace: unknown[];
};

type SessionCollectorState = {
  currentQuestionKey: string | null;
  buffer: string[];
};

function parseJsonObject(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // ignore
  }
  return {};
}

function parseJsonArray(json: string | null | undefined): unknown[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // ignore
  }
  return [];
}

function parseStringArray(json: string | null | undefined): string[] {
  const arr = parseJsonArray(json);
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === "string") out.push(item);
  }
  return out;
}

function parseGenerationOutcomes(json: string | null | undefined): GenerationOutcome[] {
  const parsed = parseJsonArray(json);
  const outcomes: GenerationOutcome[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const slotIndex = (item as any).slotIndex;
    const success = (item as any).success;
    const retries = (item as any).retries;
    const appliedFallback = (item as any).appliedFallback;
    if (typeof slotIndex !== "number" || !Number.isFinite(slotIndex)) continue;
    if (typeof success !== "boolean") continue;
    if (typeof retries !== "number" || !Number.isFinite(retries)) continue;
    outcomes.push({
      slotIndex,
      success,
      retries,
      ...(typeof appliedFallback === "string" && appliedFallback.trim() ? { appliedFallback } : {}),
    });
  }
  return outcomes;
}

function parseGeneratedProblems(json: string | null | undefined): GeneratedProblem[] {
  if (!json || !json.trim()) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    // Best-effort shape check; contracts are enforced during generation.
    return parsed.filter((p) => p && typeof p === "object" && typeof (p as any).id === "string") as GeneratedProblem[];
  } catch {
    return [];
  }
}

function parseLearningMode(raw: unknown): LearningMode {
  const parsed = LearningModeSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_LEARNING_MODE;
}

function mergeConfidence(
  existing: ConfidenceMap,
  incoming: Record<string, number>
): ConfidenceMap {
  const next: ConfidenceMap = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    next[k] = Math.max(0, Math.min(1, v));
  }
  return next;
}

function isPureConfirmationMessage(message: string): boolean {
  const m = message.trim().toLowerCase();
  if (!m) return false;
  if (m.length > 40) return false;
  return (
    m === "y" ||
    m === "yes" ||
    m === "yep" ||
    m === "yeah" ||
    m === "sure" ||
    m === "ok" ||
    m === "okay" ||
    m === "confirm" ||
    m === "confirmed" ||
    m === "looks good" ||
    m === "sounds good" ||
    m === "go ahead" ||
    m === "proceed"
  );
}

type PendingConfirmation = {
  kind: "pending_confirmation";
  fields: UserEditableSpecKey[];
  patch: Record<string, unknown>;
};

function parsePendingConfirmation(buffer: string[]): PendingConfirmation | null {
  if (!Array.isArray(buffer) || buffer.length === 0) return null;
  const raw = buffer[0];
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingConfirmation>;
    if (!parsed || parsed.kind !== "pending_confirmation") return null;
    if (!Array.isArray(parsed.fields) || typeof parsed.patch !== "object" || !parsed.patch) return null;
    const fields = parsed.fields.filter((f): f is UserEditableSpecKey => (USER_EDITABLE_SPEC_KEYS as readonly string[]).includes(String(f)));
    return { kind: "pending_confirmation", fields, patch: parsed.patch as Record<string, unknown> };
  } catch {
    return null;
  }
}

function serializePendingConfirmation(p: PendingConfirmation): string[] {
  return [JSON.stringify(p)];
}

function inferCommitmentSource(args: {
  field: UserEditableSpecKey;
  userMessage: string;
  currentQuestionKey: string | null;
}): "explicit" | "implicit" {
  const msg = args.userMessage.trim().toLowerCase();
  const qk = args.currentQuestionKey;
  const goal = qk?.startsWith("goal:") ? qk.slice("goal:".length) : null;
  const confirm =
    qk?.startsWith("confirm:") ? qk.slice("confirm:".length).split(",").map((s) => s.trim()).filter(Boolean) : null;

  if (qk === args.field) return "explicit";
  if (qk?.startsWith("invalid:") && qk.slice("invalid:".length) === args.field) return "explicit";
  if (confirm?.includes(args.field)) return "explicit";
  if (goal === "content" && args.field === "topic_tags") return "explicit";
  if (goal === "scope" && args.field === "problem_count") return "explicit";
  if (goal === "difficulty" && args.field === "difficulty_plan") return "explicit";
  if (goal === "checking" && args.field === "problem_style") return "explicit";
  if (goal === "language" && args.field === "language") return "explicit";

  if (args.field === "problem_count") {
    if (/(\b\d+\b)\s*(problems|problem|questions|question|exercises|exercise)\b/.test(msg)) return "explicit";
    if (/^(?:i want )?\d+\b/.test(msg)) return "explicit";
  }

  if (args.field === "problem_style") {
    if (/\b(stdout|return|mixed)\b/.test(msg)) return "explicit";
  }

  if (args.field === "difficulty_plan") {
    if (/\b(easy|medium|hard)\b/.test(msg)) return "explicit";
    if (/\b(easy|medium|hard)\s*:\s*\d+\b/.test(msg)) return "explicit";
  }

  if (args.field === "topic_tags") {
    if (qk === "topic_tags") return "explicit";
    if (msg.includes(",") && msg.length <= 200) return "explicit";
    if (/\b(topic|topics|focus on|focus|cover|about)\b/.test(msg)) return "explicit";
  }

  if (args.field === "language") {
    if (/\b(java|python|cpp|sql)\b/.test(msg)) return "explicit";
    if (/(^|[^a-z0-9])c\+\+([^a-z0-9]|$)/.test(msg)) return "explicit";
  }

  return "implicit";
}

function appendIntentTrace(existing: unknown[], entry: unknown, maxEntries: number = 200): unknown[] {
  const next = [...existing, entry];
  return next.length > maxEntries ? next.slice(next.length - maxEntries) : next;
}

function requireSession(id: string) {
  const session = threadDb.findById(id);
  if (!session) {
    const err = new Error("Session not found");
    (err as any).status = 404;
    throw err;
  }
  return session;
}

function parseSpecJson(specJson: string): Record<string, unknown> {
  if (!specJson || !specJson.trim()) return {};
  try {
    const parsed = JSON.parse(specJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function persistCollectorState(sessionId: string, state: SessionCollectorState): SessionCollectorState {
  threadCollectorDb.upsert(sessionId, state.currentQuestionKey, state.buffer);
  return state;
}

function getCollectorState(sessionId: string): SessionCollectorState {
  const existing = threadCollectorDb.findByThreadId(sessionId);
  if (!existing) {
    return persistCollectorState(sessionId, { currentQuestionKey: null, buffer: [] });
  }

  const storedKey = (existing.current_question_key as string | null) ?? null;
  const buffer = parseStringArray(existing.buffer_json);
  return { currentQuestionKey: storedKey, buffer };
}

function transitionOrThrow(from: SessionState, to: SessionState) {
  if (from === to) return;
  if (!canTransition(from, to)) {
    const err = new Error(`Invalid session state transition: ${from} -> ${to}`);
    (err as any).status = 409;
    throw err;
  }
}

export function createSession(
  learningMode?: LearningMode
): { sessionId: string; state: SessionState; learning_mode: LearningMode } {
  const id = crypto.randomUUID();
  const state: SessionState = "DRAFT";
  const learning_mode: LearningMode = parseLearningMode(learningMode);

  const fixed = ensureFixedFields({} as SpecDraft);
  const initialSpec = fixed.length > 0 ? applyJsonPatch({} as any, fixed) : {};

  // Contract allows null or {} — DB column is NOT NULL, so we store {}.
  threadDb.create(id, state, learning_mode, JSON.stringify(initialSpec));
  threadCollectorDb.upsert(id, null, []);

  return { sessionId: id, state, learning_mode };
}

export function getSession(id: string): SessionRecord {
  const s = requireSession(id);
  const messages = threadMessageDb.findByThreadId(id);
  const spec = parseSpecJson(s.spec_json);
  const instructions_md = typeof (s as any).instructions_md === "string" && (s as any).instructions_md.trim()
    ? String((s as any).instructions_md)
    : null;
  const confidence = parseJsonObject(s.confidence_json) as Record<string, number>;
  const commitments = parseCommitmentsJson(s.commitments_json);
  const collector = getCollectorState(id);
  const intentTrace = parseJsonArray(s.intent_trace_json).slice(-50);
  const generationOutcomes = parseGenerationOutcomes(s.generation_outcomes_json);
  const learning_mode = parseLearningMode((s as any).learning_mode);

  return {
    id: s.id,
    state: s.state as SessionState,
    learning_mode,
    spec,
    instructions_md,
    messages,
    collector,
    confidence,
    commitments: listCommitments(commitments),
    generationOutcomes,
    intentTrace,
  };
}

export function setSessionInstructions(sessionId: string, instructionsMd: string | null): { ok: true } {
  requireSession(sessionId);
  const next = typeof instructionsMd === "string" && instructionsMd.trim() ? instructionsMd : null;
  threadDb.setInstructionsMd(sessionId, next);
  return { ok: true };
}

export type ProcessMessageResponse =
  | {
      accepted: false;
      state: SessionState;
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
      state: SessionState;
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
    const s = requireSession(sessionId);
    const state = s.state as SessionState;
    trace("session.message.start", { sessionId, state });
    traceText("session.message.user", message, { extra: { sessionId } });

    if (state !== "DRAFT" && state !== "CLARIFYING") {
      const err = new Error(`Cannot post messages when session state is ${state}.`);
      (err as any).status = 409;
      throw err;
    }

    const currentSpec = parseSpecJson(s.spec_json);
    const existingConfidence = parseJsonObject(s.confidence_json) as ConfidenceMap;
    let commitmentsStore: CommitmentStore = parseCommitmentsJson(s.commitments_json);

    const persistMessage = (role: "user" | "assistant", content: string) => {
      threadMessageDb.create(crypto.randomUUID(), sessionId, role, content);
      logConversationMessage({ sessionId, role, content });
    };

    // Always persist user message.
    persistMessage("user", message);

    const fixed = ensureFixedFields(currentSpec as SpecDraft);
    const specWithFixed = fixed.length > 0 ? applyJsonPatch(currentSpec as any, fixed) : currentSpec;
    trace("session.spec.fixed", { sessionId, fixedOps: fixed.map((op) => op.path) });

    const existingTrace = parseJsonArray(s.intent_trace_json);
    let effectiveConfidence: ConfidenceMap = { ...existingConfidence };

    // Ensure the fixed fields are persisted even if the user message doesn't change anything.
    threadDb.updateSpecJson(sessionId, JSON.stringify(specWithFixed));

	    const historyRows = threadMessageDb.findByThreadId(sessionId).slice(-30);
	    const history = historyRows.map((m) => ({ role: m.role as any, content: m.content as string }));

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
	        deterministicPatch = parsedDifficulty.patch as any;
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
    threadDb.updateIntentTraceJson(sessionId, JSON.stringify(nextTrace));

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
    for (const [k, v] of Object.entries(partial)) {
      if (v === undefined) continue;
      const path = `/${k}`;
      const exists = Object.prototype.hasOwnProperty.call(base, k) && (base as any)[k] !== undefined;
      ops.push({ op: exists ? "replace" : "add", path, value: v });
    }
    return ops;
  };

  const buildNextQuestion = (spec: SpecDraft): { key: string; prompt: string } | null => {
    const gaps = analyzeSpecGaps(spec);
    if (gaps.complete) return null;
    const prompt = defaultNextQuestionFromGaps(gaps);
    const priority: (keyof ActivitySpec)[] = ["language", "problem_count", "difficulty_plan", "topic_tags"];
    const next = priority.find((k) => gaps.missing.includes(k)) ?? (gaps.missing[0] as keyof ActivitySpec | undefined);
    return { key: next ? String(next) : "unknown", prompt };
  };

		  if (needsConfirmationFields.length > 0) {
		    const fields = needsConfirmationFields.slice().sort();
		    const nextKey = dialogue.nextQuestion?.key ?? `confirm:${fields.join(",")}`;
		    const prompt = dialogue.nextQuestion?.prompt ?? "Confirm the change you want to make.";
		    const assistantText = [dialogue.assistantMessage, prompt].filter(Boolean).join("\n\n");
		
		    const pendingConfirm: PendingConfirmation = {
		      kind: "pending_confirmation",
		      fields: fields as UserEditableSpecKey[],
		      patch: mergedProposed,
		    };

	      trace("session.confirmation.pending", {
	        sessionId,
	        fields,
	        candidateKeys: Object.keys(mergedProposed ?? {}),
	      });
	
	    persistMessage("assistant", assistantText);
	    persistCollectorState(sessionId, { currentQuestionKey: nextKey, buffer: serializePendingConfirmation(pendingConfirm) });

    const target: SessionState = "CLARIFYING";
    transitionOrThrow(state, target);
    threadDb.updateState(sessionId, target);

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

  // Apply the proposed patch deterministically (and never persist invalid fields).
  let appliedUserOps: JsonPatchOp[] = [];
  let nextSpec: SpecDraft = specWithFixed as SpecDraft;
	  const userOps = buildOpsFromPartial(specWithFixed as SpecDraft, mergedProposed as any);

  const applyWithDraftValidation = (ops: JsonPatchOp[]) => {
    const merged = ops.length > 0 ? (applyJsonPatch(specWithFixed as any, ops) as SpecDraft) : (specWithFixed as SpecDraft);
    const fixedAfter = ensureFixedFields(merged);
    const final = fixedAfter.length > 0 ? (applyJsonPatch(merged as any, fixedAfter) as SpecDraft) : merged;
    return { final, fixedAfter };
  };

	  if (userOps.length > 0) {
	    const candidate = applyWithDraftValidation(userOps);
	    const res = ActivitySpecDraftSchema.safeParse(candidate.final);
	    if (res.success) {
	      nextSpec = candidate.final;
	      appliedUserOps = userOps;
	    } else {
      // Deterministic repair: drop invalid fields once.
      const invalidKeys = Array.from(
        new Set(res.error.issues.map((i) => (i.path?.[0] != null ? String(i.path[0]) : "")))
      ).filter(Boolean);
      const filtered: Record<string, unknown> = { ...(proposed as any) };
      for (const k of invalidKeys) delete filtered[k];
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
	
	  threadDb.updateSpecJson(sessionId, JSON.stringify(nextSpec));

  // Treat accepted fields as high confidence (deterministic; hard-field confirmation is separate).
  for (const op of appliedUserOps) {
    const key = op.path.startsWith("/") ? op.path.slice(1) : op.path;
    if (!key) continue;
    effectiveConfidence[key] = 1;
  }
  threadDb.updateConfidenceJson(sessionId, JSON.stringify(effectiveConfidence));

  // Update commitments for any accepted user-editable fields and clear commitments for invalidated removals.
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
  threadDb.updateCommitmentsJson(sessionId, serializeCommitments(commitmentsStore));

  const done = isSpecCompleteForGeneration(nextSpec as SpecDraft);
  const nq = done ? null : buildNextQuestion(nextSpec as SpecDraft);
  const nextKey = done ? "ready" : nq?.key ?? null;

  const assistantText = [dialogue.assistantMessage, done ? "Spec looks complete. You can generate the activity." : nq?.prompt]
    .filter(Boolean)
    .join("\n\n");

  persistMessage("assistant", assistantText);
  persistCollectorState(sessionId, { currentQuestionKey: nextKey, buffer: [] });

  if (!done) {
    const target: SessionState = "CLARIFYING";
    transitionOrThrow(state, target);
    threadDb.updateState(sessionId, target);
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
    threadDb.updateState(sessionId, "CLARIFYING");
    transitionOrThrow("CLARIFYING", "READY");
    threadDb.updateState(sessionId, "READY");
  } else {
    transitionOrThrow(state, "READY");
    threadDb.updateState(sessionId, "READY");
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

export type GenerateFromSessionResponse = {
  activityId: string;
  problems: GeneratedProblem[];
};

/**
 * Trigger generation for a READY session.
 *
 * Flow:
 * 1. Assert session.state === READY
 * 2. Transition to GENERATING
 * 3. Parse and validate ActivitySpec
 * 4. Derive ProblemPlan
 * 5. Generate problems (per-slot with retries)
 * 6. Persist plan_json + problems_json
 * 7. Create Activity record
 * 8. Transition to SAVED
 * 9. Return activityId
 *
 * On error:
 * - Transition to FAILED
 * - Set last_error
 */
export async function generateFromSession(
  sessionId: string
): Promise<GenerateFromSessionResponse> {
  return withTraceContext({ sessionId }, async () => {
    const s = requireSession(sessionId);
    const state = s.state as SessionState;
    const learning_mode = parseLearningMode((s as any).learning_mode);
    const instructionsMdRaw = typeof (s as any).instructions_md === "string" ? String((s as any).instructions_md) : "";
    const instructionsMd = instructionsMdRaw.trim() ? instructionsMdRaw : null;

    if (state !== "READY") {
      const err = new Error(`Cannot generate when session state is ${state}. Expected READY.`);
      (err as any).status = 409;
      throw err;
    }

    // If an activity already exists, this session is effectively immutable.
    if (typeof s.activity_id === "string" && s.activity_id.trim()) {
      const err = new Error("Session already produced an activity. Cannot re-generate.");
      (err as any).status = 409;
      throw err;
    }

    const existingTrace = parseJsonArray(s.intent_trace_json);
    const existingConfidence = parseJsonObject(s.confidence_json) as ConfidenceMap;
    const commitments = parseCommitmentsJson(s.commitments_json);

    const persistTraceEvent = (entry: Record<string, unknown>) => {
      const nextTrace = appendIntentTrace(existingTrace, entry);
      threadDb.updateIntentTraceJson(sessionId, JSON.stringify(nextTrace));
      // Mutate local reference so multiple events in this call don't clobber each other.
      existingTrace.splice(0, existingTrace.length, ...nextTrace);
    };

    const persistConfidencePatch = (patch: JsonPatchOp[]) => {
      const incoming: Record<string, number> = {};
      for (const op of patch) {
        const key = op.path.startsWith("/") ? op.path.slice(1) : op.path;
        if (!key) continue;
        // System-made adjustments are deterministic; mark as high confidence.
        incoming[key] = 1;
      }
      const next = mergeConfidence(existingConfidence, incoming);
      threadDb.updateConfidenceJson(sessionId, JSON.stringify(next));
      Object.assign(existingConfidence, next);
    };

    let progressHeartbeat: NodeJS.Timeout | null = null;

    try {
    // Transition to GENERATING (lock)
    transitionOrThrow(state, "GENERATING");
    threadDb.updateState(sessionId, "GENERATING");
    progressHeartbeat = setInterval(() => {
      publishGenerationProgress(sessionId, { type: "heartbeat", ts: new Date().toISOString() });
    }, 1000);

    // Parse and validate ActivitySpec
    const specObj = parseSpecJson(s.spec_json);
    const specResult = ActivitySpecSchema.safeParse(specObj);
    if (!specResult.success) {
      throw new Error(
        `Invalid ActivitySpec: ${specResult.error.issues[0]?.message ?? "validation failed"}`
      );
    }
    let spec: ActivitySpec = specResult.data;
    if (!isLanguageSupportedForGeneration(spec.language)) {
      throw new Error(`Language "${spec.language}" is not supported for generation yet.`);
    }

    let resumeProblems: GeneratedProblem[] = parseGeneratedProblems(s.problems_json);
    let resumeOutcomes: GenerationOutcome[] = parseGenerationOutcomes(s.generation_outcomes_json);
    if (resumeOutcomes.length !== resumeProblems.length) {
      // Keep problems as source of truth for resume; outcomes are informational.
      resumeOutcomes = resumeOutcomes.slice(0, resumeProblems.length);
    }

    let problems: GeneratedProblem[] | null = null;
    let outcomes: GenerationOutcome[] | null = null;
    let usedFallback = false;
    let appliedFallbackReason: string | null = null;

    // Derive initial ProblemPlan (always from current spec)
    const pedagogyPolicy = learning_mode === "guided" ? buildGuidedPedagogyPolicy({ spec, learnerProfile: null }) : undefined;
    let plan = deriveProblemPlan(spec, pedagogyPolicy);
    threadDb.setPlanJson(sessionId, JSON.stringify(plan));
    publishGenerationProgress(sessionId, {
      type: "generation_started",
      totalSlots: plan.length,
      totalProblems: plan.length,
      run: 1,
    });

    // If we have a checkpoint, mark those slots as done in the progress UI immediately.
    if (resumeProblems.length > 0) {
      for (let i = 0; i < Math.min(resumeProblems.length, plan.length); i++) {
        publishGenerationProgress(sessionId, { type: "slot_completed", slotIndex: i });
      }
    }

    while (!problems) {
      try {
        // Generate problems (per-slot with retries + Docker validation + discard reference_solution)
        const generated = await generateProblemsFromPlan(plan, {
          customInstructionsMd: instructionsMd,
          resume: { problems: resumeProblems, outcomes: resumeOutcomes },
          onProgress: (event: GenerationProgressEvent) => publishGenerationProgress(sessionId, event),
          onCheckpoint: ({ problems: p, outcomes: o }) => {
            threadDb.setProblemsJson(sessionId, JSON.stringify(p));
            threadDb.updateGenerationOutcomesJson(sessionId, JSON.stringify(o));
          },
        });
        problems = generated.problems;
        outcomes = generated.outcomes;
      } catch (err: any) {
        if (err instanceof GenerationSlotFailureError) {
          if (Array.isArray(err.problemsSoFar)) {
            resumeProblems = err.problemsSoFar;
            threadDb.setProblemsJson(sessionId, JSON.stringify(resumeProblems));
          }
          if (Array.isArray(err.outcomesSoFar)) {
            resumeOutcomes = err.outcomesSoFar;
            threadDb.updateGenerationOutcomesJson(sessionId, JSON.stringify(resumeOutcomes));
          }

          persistTraceEvent({
            ts: new Date().toISOString(),
            type: "generation_failure",
            slotIndex: err.slotIndex,
            kind: err.kind,
            attempts: err.attempts,
            title: err.title ?? null,
            llmOutputHash: err.llmOutputHash ?? null,
            message: err.message,
            outcomes: err.outcomesSoFar ?? null,
          });

          trace("generation.failure.persisted", {
            sessionId,
            slotIndex: err.slotIndex,
            kind: err.kind,
            llmOutputHash: err.llmOutputHash,
          });

          if (!usedFallback) {
            const explicitDifficultyLocked = commitments?.difficulty_plan?.locked === true;
            const explicitTopicsLocked = commitments?.topic_tags?.locked === true;
            const decision = proposeGenerationFallbackWithPolicy(spec, {
              allowDowngradeDifficulty: !explicitDifficultyLocked,
              allowNarrowTopics: !explicitTopicsLocked,
            });
            if (decision) {
              usedFallback = true;
              appliedFallbackReason = decision.reason;

              publishGenerationProgress(sessionId, {
                type: "generation_soft_fallback_applied",
                reason: decision.reason,
                patchPaths: decision.patch.map((p) => p.path),
              });

              persistTraceEvent({
                ts: new Date().toISOString(),
                type: "generation_soft_fallback",
                reason: decision.reason,
                patch: decision.patch,
              });

              persistConfidencePatch(decision.patch);

              const adjusted = applyJsonPatch(spec as any, decision.patch) as ActivitySpec;
              const adjustedRes = ActivitySpecSchema.safeParse(adjusted);
              if (!adjustedRes.success) {
                persistTraceEvent({
                  ts: new Date().toISOString(),
                  type: "generation_soft_fallback_failed",
                  reason: "fallback patch produced invalid ActivitySpec",
                  error: adjustedRes.error.issues[0]?.message ?? "invalid",
                });
                throw err;
              }

              spec = adjustedRes.data;
              threadDb.updateSpecJson(sessionId, JSON.stringify(spec));

              // Update plan for remaining slots (we keep already generated problems as a checkpoint).
              plan = deriveProblemPlan(spec, pedagogyPolicy);
              threadDb.setPlanJson(sessionId, JSON.stringify(plan));
              continue;
            }
          }
        }

        throw err;
      }
    }

    if (!problems) {
      throw new Error("Generation failed: problems were not produced.");
    }

    if (outcomes) {
      const finalOutcomes = appliedFallbackReason
        ? outcomes.map((o) => ({ ...o, appliedFallback: o.appliedFallback ?? appliedFallbackReason }))
        : outcomes;
      threadDb.updateGenerationOutcomesJson(sessionId, JSON.stringify(finalOutcomes));
      persistTraceEvent({
        ts: new Date().toISOString(),
        type: "generation_outcomes",
        outcomes: finalOutcomes,
      });
    }

    // Persist problems_json
    threadDb.setProblemsJson(sessionId, JSON.stringify(problems));

    // Create Activity record
    const activityId = crypto.randomUUID();
    const activityTitle = `Activity (${spec.problem_count} problems)`;

    activityDb.create(activityId, activityTitle, JSON.stringify(problems), undefined, {
      status: "DRAFT",
      timeLimitSeconds: null,
    });

    // Link activity to session
    threadDb.setActivityId(sessionId, activityId);

    // Transition to SAVED
    transitionOrThrow("GENERATING", "SAVED");
    threadDb.updateState(sessionId, "SAVED");
    publishGenerationProgress(sessionId, { type: "generation_completed", activityId });
    publishGenerationProgress(sessionId, { type: "generation_complete", activityId });

    if (usedFallback) {
      persistTraceEvent({
        ts: new Date().toISOString(),
        type: "generation_soft_fallback_succeeded",
      });
    }

      return { activityId, problems };
    } catch (err: any) {
    // Transition back to READY so the user can retry generation (checkpointed problems may exist).
    try {
      transitionOrThrow("GENERATING", "READY");
      threadDb.updateState(sessionId, "READY");
      threadDb.setLastError(sessionId, err.message ?? "Unknown error during generation.");
    } catch (transitionErr) {
      console.error("Failed to transition session to READY:", transitionErr);
    }

      publishGenerationProgress(sessionId, {
        type: "generation_failed",
        error: "Generation failed. Please try again.",
        ...(err instanceof GenerationSlotFailureError ? { slotIndex: err.slotIndex } : {}),
      });
      throw err;
    } finally {
      if (progressHeartbeat) clearInterval(progressHeartbeat);
    }
  });
}

export async function regenerateSlotFromSession(
  sessionId: string,
  slotIndex: number,
  strategy:
    | "retry_full_slot"
    | "repair_reference_solution"
    | "repair_test_suite"
    | "downgrade_difficulty"
    | "narrow_topics" = "retry_full_slot"
): Promise<GenerateFromSessionResponse & { regeneratedSlotIndex: number; strategy: string }> {
  return withTraceContext({ sessionId }, async () => {
    const s = requireSession(sessionId);
    const state = s.state as SessionState;

    if (state === "GENERATING") {
      const err = new Error("Cannot regenerate a slot while generation is in progress.");
      (err as any).status = 409;
      throw err;
    }

    if (typeof s.activity_id === "string" && s.activity_id.trim()) {
      const err = new Error("This session already produced an activity. Create a new thread to regenerate slots.");
      (err as any).status = 409;
      throw err;
    }

    if (state !== "READY" && state !== "FAILED") {
      const err = new Error(`Cannot regenerate slots when session state is ${state}. Expected READY or FAILED.`);
      (err as any).status = 409;
      throw err;
    }

    const specObj = parseSpecJson(s.spec_json);
    const specResult = ActivitySpecSchema.safeParse(specObj);
    if (!specResult.success) {
      throw new Error(
        `Invalid ActivitySpec: ${specResult.error.issues[0]?.message ?? "validation failed"}`
      );
    }
    const spec = specResult.data;
    if (!isLanguageSupportedForGeneration(spec.language)) {
      throw new Error(`Language "${spec.language}" is not supported for generation yet.`);
    }

    const learning_mode = parseLearningMode((s as any).learning_mode);
    const pedagogyPolicy =
      learning_mode === "guided" ? buildGuidedPedagogyPolicy({ spec, learnerProfile: null }) : undefined;
    const plan = deriveProblemPlan(spec, pedagogyPolicy);
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= plan.length) {
      throw new Error(`slotIndex must be between 0 and ${Math.max(0, plan.length - 1)}.`);
    }

    const existingProblems = parseGeneratedProblems(s.problems_json);
    const existingOutcomes = parseGenerationOutcomes(s.generation_outcomes_json);
    const keptCount = Math.min(slotIndex, existingProblems.length, existingOutcomes.length);

    const nextProblems = existingProblems.slice(0, keptCount);
    const nextOutcomes = existingOutcomes.slice(0, keptCount);
    threadDb.setPlanJson(sessionId, JSON.stringify(plan));
    threadDb.setProblemsJson(sessionId, JSON.stringify(nextProblems));
    threadDb.updateGenerationOutcomesJson(sessionId, JSON.stringify(nextOutcomes));
    threadDb.setLastError(sessionId, null);

    const existingTrace = parseJsonArray(s.intent_trace_json);
    const traceEntry = {
      ts: new Date().toISOString(),
      type: "slot_regeneration_requested",
      slotIndex,
      strategy,
      keptCount,
    };
    const nextTrace = appendIntentTrace(existingTrace, traceEntry);
    threadDb.updateIntentTraceJson(sessionId, JSON.stringify(nextTrace));

    if (state === "FAILED") {
      transitionOrThrow("FAILED", "READY");
      threadDb.updateState(sessionId, "READY");
    }

    const out = await generateFromSession(sessionId);
    return { ...out, regeneratedSlotIndex: slotIndex, strategy };
  });
}
