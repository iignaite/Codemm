import crypto from "crypto";
import {
  threadCollectorRepository,
  threadMessageRepository,
  threadRepository,
  type DBSessionMessage,
} from "../../database/repositories/threadRepository";
import { canTransition, type SessionState } from "../../contracts/session";
import type { ActivitySpec } from "../../contracts/activitySpec";
import { applyJsonPatch, type JsonPatchOp } from "../../compiler/jsonPatch";
import type { SpecDraft } from "../../compiler/specDraft";
import { ensureFixedFields } from "../../compiler/specDraft";
import { DEFAULT_LEARNING_MODE, LearningModeSchema, type LearningMode } from "../../contracts/learningMode";
import type { GenerationOutcome } from "../../contracts/generationOutcome";
import type { GeneratedProblem } from "../../contracts/problem";
import type { ConfidenceMap } from "../../agent/readiness";
import type { GenerationFailureKind } from "@codemm/shared-contracts";
import {
  USER_EDITABLE_SPEC_KEYS,
  type UserEditableSpecKey,
} from "../../agent/dialogue";
import {
  listCommitments,
  parseCommitmentsJson,
  removeCommitment,
  serializeCommitments,
  upsertCommitment,
  type CommitmentStore,
} from "../../agent/commitments";

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
  latestGenerationRunId?: string | null;
  latestGenerationRunStatus?: string | null;
};

export type SessionCollectorState = {
  currentQuestionKey: string | null;
  buffer: string[];
};

export type PendingConfirmation = {
  kind: "pending_confirmation";
  fields: UserEditableSpecKey[];
  patch: Record<string, unknown>;
};

export function parseJsonObject(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // ignore
  }
  return {};
}

export function parseJsonArray(json: string | null | undefined): unknown[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // ignore
  }
  return [];
}

export function parseStringArray(json: string | null | undefined): string[] {
  const arr = parseJsonArray(json);
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === "string") out.push(item);
  }
  return out;
}

export function parseGenerationOutcomes(json: string | null | undefined): GenerationOutcome[] {
  const parsed = parseJsonArray(json);
  const outcomes: GenerationOutcome[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const slotIndex = (item as any).slotIndex;
    const success = (item as any).success;
    const status = (item as any).status;
    const retries = (item as any).retries;
    const appliedFallback = (item as any).appliedFallback;
    const failureKind = (item as any).failureKind;
    const failureCode = (item as any).failureCode;
    const message = (item as any).message;
    if (typeof slotIndex !== "number" || !Number.isFinite(slotIndex)) continue;
    if (typeof success !== "boolean") continue;
    if (typeof retries !== "number" || !Number.isFinite(retries)) continue;
    const normalizedFailureKind =
      failureKind === "compile" ||
      failureKind === "tests" ||
      failureKind === "timeout" ||
      failureKind === "contract" ||
      failureKind === "quality" ||
      failureKind === "llm" ||
      failureKind === "infra" ||
      failureKind === "unknown"
        ? (failureKind as GenerationFailureKind)
        : undefined;
    outcomes.push({
      slotIndex,
      success,
      status:
        status === "SUCCEEDED" || status === "RETRYABLE_FAILURE" || status === "HARD_FAILURE" || status === "SKIPPED"
          ? status
          : success
            ? "SUCCEEDED"
            : "RETRYABLE_FAILURE",
      retries,
      ...(normalizedFailureKind ? { failureKind: normalizedFailureKind } : {}),
      ...(typeof failureCode === "string" ? { failureCode } : {}),
      ...(typeof message === "string" ? { message } : {}),
      ...(typeof appliedFallback === "string" && appliedFallback.trim() ? { appliedFallback } : {}),
    });
  }
  return outcomes;
}

export function parseGeneratedProblems(json: string | null | undefined): GeneratedProblem[] {
  if (!json || !json.trim()) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((problem) => problem && typeof problem === "object" && typeof (problem as any).id === "string") as GeneratedProblem[];
  } catch {
    return [];
  }
}

export function parseLearningMode(raw: unknown): LearningMode {
  const parsed = LearningModeSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_LEARNING_MODE;
}

export function mergeConfidence(existing: ConfidenceMap, incoming: Record<string, number>): ConfidenceMap {
  const next: ConfidenceMap = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    next[key] = Math.max(0, Math.min(1, value));
  }
  return next;
}

export function isPureConfirmationMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.length > 40) return false;
  return (
    normalized === "y" ||
    normalized === "yes" ||
    normalized === "yep" ||
    normalized === "yeah" ||
    normalized === "sure" ||
    normalized === "ok" ||
    normalized === "okay" ||
    normalized === "confirm" ||
    normalized === "confirmed" ||
    normalized === "looks good" ||
    normalized === "sounds good" ||
    normalized === "go ahead" ||
    normalized === "proceed"
  );
}

export function parsePendingConfirmation(buffer: string[]): PendingConfirmation | null {
  if (!Array.isArray(buffer) || buffer.length === 0) return null;
  const raw = buffer[0];
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingConfirmation>;
    if (!parsed || parsed.kind !== "pending_confirmation") return null;
    if (!Array.isArray(parsed.fields) || typeof parsed.patch !== "object" || !parsed.patch) return null;
    const fields = parsed.fields.filter((field): field is UserEditableSpecKey =>
      (USER_EDITABLE_SPEC_KEYS as readonly string[]).includes(String(field))
    );
    return { kind: "pending_confirmation", fields, patch: parsed.patch as Record<string, unknown> };
  } catch {
    return null;
  }
}

export function serializePendingConfirmation(pending: PendingConfirmation): string[] {
  return [JSON.stringify(pending)];
}

export function inferCommitmentSource(args: {
  field: UserEditableSpecKey;
  userMessage: string;
  currentQuestionKey: string | null;
}): "explicit" | "implicit" {
  const msg = args.userMessage.trim().toLowerCase();
  const questionKey = args.currentQuestionKey;
  const goal = questionKey?.startsWith("goal:") ? questionKey.slice("goal:".length) : null;
  const confirm =
    questionKey?.startsWith("confirm:")
      ? questionKey
          .slice("confirm:".length)
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : null;

  if (questionKey === args.field) return "explicit";
  if (questionKey?.startsWith("invalid:") && questionKey.slice("invalid:".length) === args.field) return "explicit";
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
    if (questionKey === "topic_tags") return "explicit";
    if (msg.includes(",") && msg.length <= 200) return "explicit";
    if (/\b(topic|topics|focus on|focus|cover|about)\b/.test(msg)) return "explicit";
  }

  if (args.field === "language") {
    if (/\b(java|python|cpp|sql)\b/.test(msg)) return "explicit";
    if (/(^|[^a-z0-9])c\+\+([^a-z0-9]|$)/.test(msg)) return "explicit";
  }

  return "implicit";
}

export function appendIntentTrace(existing: unknown[], entry: unknown, maxEntries: number = 200): unknown[] {
  const next = [...existing, entry];
  return next.length > maxEntries ? next.slice(next.length - maxEntries) : next;
}

export function requireSession(id: string) {
  const session = threadRepository.findById(id);
  if (!session) {
    const err = new Error("Session not found");
    (err as any).status = 404;
    throw err;
  }
  return session;
}

export function parseSpecJson(specJson: string): Record<string, unknown> {
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

export function persistCollectorState(sessionId: string, state: SessionCollectorState): SessionCollectorState {
  threadCollectorRepository.upsert(sessionId, state.currentQuestionKey, state.buffer);
  return state;
}

export function getCollectorState(sessionId: string): SessionCollectorState {
  const existing = threadCollectorRepository.findByThreadId(sessionId);
  if (!existing) {
    return persistCollectorState(sessionId, { currentQuestionKey: null, buffer: [] });
  }

  const storedKey = (existing.current_question_key as string | null) ?? null;
  const buffer = parseStringArray(existing.buffer_json);
  return { currentQuestionKey: storedKey, buffer };
}

export function transitionOrThrow(from: SessionState, to: SessionState) {
  if (from === to) return;
  if (!canTransition(from, to)) {
    const err = new Error(`Invalid session state transition: ${from} -> ${to}`);
    (err as any).status = 409;
    throw err;
  }
}

export function createInitialSpec(): Record<string, unknown> {
  const fixed = ensureFixedFields({} as SpecDraft);
  return fixed.length > 0 ? applyJsonPatch({} as any, fixed) : {};
}

export function persistConversationMessage(
  sessionId: string,
  role: "user" | "assistant",
  content: string
): DBSessionMessage {
  const message = {
    id: crypto.randomUUID(),
    session_id: sessionId,
    role,
    content,
    created_at: new Date().toISOString(),
  } satisfies DBSessionMessage;
  threadMessageRepository.create(message.id, sessionId, role, content);
  return message;
}
