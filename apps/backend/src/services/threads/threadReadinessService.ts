import crypto from "crypto";
import { threadCollectorRepository, threadMessageRepository, threadRepository } from "../../database/repositories/threadRepository";
import type { SessionState } from "../../contracts/session";
import { DEFAULT_LEARNING_MODE, type LearningMode } from "../../contracts/learningMode";
import { listCommitments, parseCommitmentsJson } from "../../agent/commitments";
import {
  createInitialSpec,
  getCollectorState,
  parseGenerationOutcomes,
  parseJsonArray,
  parseJsonObject,
  parseLearningMode,
  parseSpecJson,
  requireSession,
  type SessionRecord,
} from "./shared";

export function createSession(
  learningMode?: LearningMode
): { sessionId: string; state: SessionState; learning_mode: LearningMode } {
  const id = crypto.randomUUID();
  const state: SessionState = "DRAFT";
  const learning_mode: LearningMode = parseLearningMode(learningMode ?? DEFAULT_LEARNING_MODE);

  const initialSpec = createInitialSpec();
  threadRepository.create(id, state, learning_mode, JSON.stringify(initialSpec));
  threadCollectorRepository.upsert(id, null, []);

  return { sessionId: id, state, learning_mode };
}

export function getSession(id: string): SessionRecord {
  const session = requireSession(id);
  const messages = threadMessageRepository.findByThreadId(id);
  const spec = parseSpecJson(session.spec_json);
  const instructions_md =
    typeof session.instructions_md === "string" && session.instructions_md.trim() ? String(session.instructions_md) : null;
  const confidence = parseJsonObject(session.confidence_json) as Record<string, number>;
  const commitments = listCommitments(parseCommitmentsJson(session.commitments_json));
  const collector = getCollectorState(id);
  const intentTrace = parseJsonArray(session.intent_trace_json).slice(-50);
  const generationOutcomes = parseGenerationOutcomes(session.generation_outcomes_json);
  const learning_mode = parseLearningMode(session.learning_mode);

  return {
    id: session.id,
    state: session.state as SessionState,
    learning_mode,
    spec,
    instructions_md,
    messages,
    collector,
    confidence,
    commitments,
    generationOutcomes,
    intentTrace,
  };
}

export function setSessionInstructions(sessionId: string, instructionsMd: string | null): { ok: true } {
  requireSession(sessionId);
  const next = typeof instructionsMd === "string" && instructionsMd.trim() ? instructionsMd : null;
  threadRepository.setInstructionsMd(sessionId, next);
  return { ok: true };
}
