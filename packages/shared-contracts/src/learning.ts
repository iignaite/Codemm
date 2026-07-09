import type { ActivityLanguageDto } from "./activity";

export type LearnerPreferredStyleDto = "guided" | "exploratory";

export type LocalLearnerProfileDto = {
  goal: string | null;
  preferred_style: LearnerPreferredStyleDto | null;
  created_at: string;
  updated_at: string;
};

export type MasteryLevelDto = "novice" | "developing" | "proficient" | "mastered";

export type ConceptMasteryDto = {
  language: ActivityLanguageDto;
  concept: string;
  mastery: number;
  level: MasteryLevelDto;
  attempts: number;
  passes: number;
  last_attempt_at: string | null;
  updated_at: string;
};

export type LearnerProfileResponseDto = {
  profile: LocalLearnerProfileDto;
};

export type LearnerMasteryResponseDto = {
  language: ActivityLanguageDto;
  concepts: ConceptMasteryDto[];
  taken_at: string;
};
