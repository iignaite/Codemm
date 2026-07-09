import db from "../db";
import type { ActivityLanguage } from "../../contracts/activitySpec";
import type {
  ConceptMastery,
  LearnerPreferredStyle,
  LocalLearnerProfile,
  MasterySnapshot,
} from "../../contracts/learner";

interface LearnerProfileRow {
  id: number;
  goal: string | null;
  preferred_style: string | null;
  created_at: string;
  updated_at: string;
}

interface ConceptMasteryRow {
  language: string;
  concept: string;
  mastery: number;
  attempts: number;
  passes: number;
  last_attempt_at: string | null;
  updated_at: string;
}

function toProfile(row: LearnerProfileRow): LocalLearnerProfile {
  return {
    goal: row.goal,
    preferred_style: (row.preferred_style as LearnerPreferredStyle | null) ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toConceptMastery(row: ConceptMasteryRow): ConceptMastery {
  return {
    language: row.language as ActivityLanguage,
    concept: row.concept,
    mastery: row.mastery,
    attempts: row.attempts,
    passes: row.passes,
    last_attempt_at: row.last_attempt_at,
    updated_at: row.updated_at,
  };
}

export const learnerProfileRepository = {
  /** The workspace has exactly one learner; created on first read. */
  get: (): LocalLearnerProfile => {
    const row = db.prepare(`SELECT * FROM learner_profile WHERE id = 1`).get() as LearnerProfileRow | undefined;
    if (row) return toProfile(row);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO learner_profile (id, goal, preferred_style, created_at, updated_at) VALUES (1, NULL, NULL, ?, ?)`
    ).run(now, now);
    return { goal: null, preferred_style: null, created_at: now, updated_at: now };
  },

  update: (patch: { goal?: string | null; preferred_style?: LearnerPreferredStyle | null }): LocalLearnerProfile => {
    learnerProfileRepository.get();
    const sets: string[] = [];
    const args: unknown[] = [];
    if (typeof patch.goal !== "undefined") {
      sets.push("goal = ?");
      args.push(patch.goal);
    }
    if (typeof patch.preferred_style !== "undefined") {
      sets.push("preferred_style = ?");
      args.push(patch.preferred_style);
    }
    if (sets.length > 0) {
      sets.push("updated_at = ?");
      args.push(new Date().toISOString());
      db.prepare(`UPDATE learner_profile SET ${sets.join(", ")} WHERE id = 1`).run(...args);
    }
    return learnerProfileRepository.get();
  },
};

export const conceptMasteryRepository = {
  get: (language: ActivityLanguage, concept: string): ConceptMastery | undefined => {
    const row = db
      .prepare(`SELECT * FROM concept_mastery WHERE language = ? AND concept = ?`)
      .get(language, concept) as ConceptMasteryRow | undefined;
    return row ? toConceptMastery(row) : undefined;
  },

  upsert: (record: ConceptMastery): void => {
    db.prepare(
      `INSERT INTO concept_mastery (language, concept, mastery, attempts, passes, last_attempt_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(language, concept) DO UPDATE SET
         mastery = excluded.mastery,
         attempts = excluded.attempts,
         passes = excluded.passes,
         last_attempt_at = excluded.last_attempt_at,
         updated_at = excluded.updated_at`
    ).run(
      record.language,
      record.concept,
      record.mastery,
      record.attempts,
      record.passes,
      record.last_attempt_at,
      record.updated_at
    );
  },

  listByLanguage: (language: ActivityLanguage): ConceptMastery[] => {
    const rows = db
      .prepare(`SELECT * FROM concept_mastery WHERE language = ? ORDER BY concept`)
      .all(language) as ConceptMasteryRow[];
    return rows.map(toConceptMastery);
  },

  snapshot: (language: ActivityLanguage): MasterySnapshot => {
    const concept_mastery: Record<string, number> = {};
    for (const record of conceptMasteryRepository.listByLanguage(language)) {
      concept_mastery[record.concept] = record.mastery;
    }
    return { language, concept_mastery, taken_at: new Date().toISOString() };
  },
};
