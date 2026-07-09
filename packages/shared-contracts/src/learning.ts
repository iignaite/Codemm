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

export type ModuleStatusDto = "not_started" | "in_progress" | "mastered";

export type LearningPathModuleDto = {
  concept: string;
  mastery: number;
  level: MasteryLevelDto;
  status: ModuleStatusDto;
  attempts: number;
  passes: number;
  recommended: boolean;
};

export type LearningPathDto = {
  language: ActivityLanguageDto;
  modules: LearningPathModuleDto[];
  recommendedConcept: string | null;
  overallMastery: number;
  masteredCount: number;
  totalCount: number;
  builtAt: string;
};

export type LearningPathResponseDto = {
  path: LearningPathDto;
};
