import { z } from "zod";
import { ActivitySpecSchema } from "./activitySpec";
import { LearningModeSchema } from "./learningMode";

// Deprecated as an application-facing contract. Phase 3 uses "thread" as the
// canonical DTO boundary; "session" remains the persistence/state-machine name
// until a schema migration is intentionally scheduled.

export const SessionStateSchema = z.enum([
  "DRAFT",
  "CLARIFYING",
  "READY",
  "GENERATE_PENDING",
  "GENERATING",
  "COMPLETED",
  "INCOMPLETE",
  "PARTIAL_SUCCESS",
  "RETRYABLE_FAILURE",
  "HARD_FAILURE",
]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const SessionMessageRoleSchema = z.enum(["user", "assistant"]);
export type SessionMessageRole = z.infer<typeof SessionMessageRoleSchema>;

export const SessionMessageSchema = z
  .object({
    id: z.string().uuid(),
    session_id: z.string().uuid(),
    role: SessionMessageRoleSchema,
    content: z.string().min(1),
    created_at: z.string().datetime(),
  })
  .strict();

export type SessionMessage = z.infer<typeof SessionMessageSchema>;

export const SessionSchema = z
  .object({
    id: z.string().uuid(),
    state: SessionStateSchema,
    learning_mode: LearningModeSchema,

    // Authoritative source of truth for generation.
    spec: ActivitySpecSchema,

    // Optional extras returned by API.
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),

    // Session may or may not be materialized with messages in the DB layer.
    messages: z.array(SessionMessageSchema).optional(),

    // The generated activity id when SAVED.
    activity_id: z.string().uuid().nullable().optional(),

    // Error info when FAILED.
    last_error: z.string().nullable().optional(),
  })
  .strict();

export type Session = z.infer<typeof SessionSchema>;

// Codemm v1.0 strict state machine
const ALLOWED_TRANSITIONS: Record<SessionState, SessionState[]> = {
  DRAFT: ["CLARIFYING"],
  CLARIFYING: ["CLARIFYING", "READY"],
  READY: ["GENERATE_PENDING"],
  GENERATE_PENDING: ["GENERATING", "RETRYABLE_FAILURE", "HARD_FAILURE"],
  GENERATING: ["COMPLETED", "INCOMPLETE", "PARTIAL_SUCCESS", "RETRYABLE_FAILURE", "HARD_FAILURE"],
  COMPLETED: ["GENERATE_PENDING"],
  INCOMPLETE: ["GENERATE_PENDING"],
  PARTIAL_SUCCESS: ["GENERATE_PENDING"],
  RETRYABLE_FAILURE: ["GENERATE_PENDING", "READY"],
  HARD_FAILURE: ["GENERATE_PENDING", "READY"],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  return allowed.includes(to);
}

export function assertCanTransition(from: SessionState, to: SessionState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid session state transition: ${from} -> ${to}`);
  }
}
