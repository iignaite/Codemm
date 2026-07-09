import { z } from "zod";
import type { ConceptMasteryDto, LearnerMasteryResponseDto, LearnerProfileResponseDto } from "@codemm/shared-contracts";
import { ActivityLanguageSchema } from "../contracts/activitySpec";
import { LearnerPreferredStyleSchema } from "../contracts/learner";
import { conceptMasteryRepository, learnerProfileRepository } from "../database/repositories/learnerRepository";
import { masteryLevelFor } from "../learning/mastery";
import { requireParams } from "./common";
import type { RpcHandlerDef } from "./types";

export function createLearningHandlers(): Record<string, RpcHandlerDef> {
  return {
    "learning.getProfile": {
      handler: async () => {
        const response: LearnerProfileResponseDto = { profile: learnerProfileRepository.get() };
        return response;
      },
    },

    "learning.updateProfile": {
      schema: z
        .object({
          goal: z.string().trim().max(500).nullable().optional(),
          preferredStyle: LearnerPreferredStyleSchema.nullable().optional(),
        })
        .passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const patch: Parameters<typeof learnerProfileRepository.update>[0] = {};
        if ("goal" in params) patch.goal = (params.goal as string | null) ?? null;
        if ("preferredStyle" in params) {
          patch.preferred_style = (params.preferredStyle as "guided" | "exploratory" | null) ?? null;
        }
        const response: LearnerProfileResponseDto = { profile: learnerProfileRepository.update(patch) };
        return response;
      },
    },

    "learning.getMastery": {
      schema: z.object({ language: ActivityLanguageSchema }).passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const language = ActivityLanguageSchema.parse(params.language);
        const concepts: ConceptMasteryDto[] = conceptMasteryRepository.listByLanguage(language).map((record) => ({
          ...record,
          level: masteryLevelFor(record.mastery),
        }));
        const response: LearnerMasteryResponseDto = {
          language,
          concepts,
          taken_at: new Date().toISOString(),
        };
        return response;
      },
    },
  };
}
