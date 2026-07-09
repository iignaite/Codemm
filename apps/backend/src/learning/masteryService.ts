import { ActivityLanguageSchema, type ActivityLanguage } from "../contracts/activitySpec";
import { conceptMasteryRepository } from "../database/repositories/learnerRepository";
import { logStructured } from "../infra/observability/logger";
import { applyAttemptEvidence, normalizeConceptKey, type AttemptEvidence } from "./mastery";

/**
 * Fold a judged submission into the learner's persisted concept mastery.
 *
 * Malformed stored activity data is a data-quality problem, not a reason to
 * fail the submission: it is logged loudly and skipped.
 */
export function recordAttemptMastery(args: {
  activityProblemsJson: string;
  problemId: string;
  fallbackLanguage: ActivityLanguage;
  evidence: AttemptEvidence;
}): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.activityProblemsJson);
  } catch {
    logStructured("warn", "learning.mastery.skipped", {
      reason: "malformed_activity_problems_json",
      problemId: args.problemId,
    });
    return;
  }

  const problems = Array.isArray(parsed) ? parsed : [];
  const problem = problems.find(
    (candidate): candidate is Record<string, unknown> =>
      Boolean(candidate) && typeof candidate === "object" && (candidate as { id?: unknown }).id === args.problemId
  );
  if (!problem) {
    logStructured("warn", "learning.mastery.skipped", {
      reason: "problem_not_found",
      problemId: args.problemId,
    });
    return;
  }

  const rawTag = problem.topic_tag;
  if (typeof rawTag !== "string" || !rawTag.trim()) {
    logStructured("warn", "learning.mastery.skipped", {
      reason: "missing_topic_tag",
      problemId: args.problemId,
    });
    return;
  }

  const languageParsed = ActivityLanguageSchema.safeParse(problem.language);
  const language = languageParsed.success ? languageParsed.data : args.fallbackLanguage;
  const concept = normalizeConceptKey(rawTag);

  const prev = conceptMasteryRepository.get(language, concept);
  const next = applyAttemptEvidence(prev, { language, concept, evidence: args.evidence });
  conceptMasteryRepository.upsert(next);
}
