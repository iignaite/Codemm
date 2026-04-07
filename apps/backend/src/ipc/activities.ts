import { z } from "zod";
import type { ActivityDetailDto, ActivityListResponseDto, ActivityResponseDto, PublishActivityResponseDto } from "@codemm/shared-contracts";
import { activityRepository } from "../database/repositories/activityRepository";
import { editDraftProblemWithAi } from "../services/activityProblemEditService";
import { getString, requireParams } from "./common";
import type { RpcHandlerDef } from "./types";

function toActivityDetailDto(dbActivity: {
  id: string;
  title: string;
  prompt?: string;
  problems: string;
  status?: string;
  time_limit_seconds?: number | null;
  created_at: string;
}): ActivityDetailDto {
  return {
    id: dbActivity.id,
    title: dbActivity.title,
    prompt: dbActivity.prompt || "",
    problems: JSON.parse(dbActivity.problems),
    status: (dbActivity.status as ActivityDetailDto["status"]) ?? "DRAFT",
    timeLimitSeconds: typeof dbActivity.time_limit_seconds === "number" ? dbActivity.time_limit_seconds : null,
    createdAt: dbActivity.created_at,
  };
}

export function createActivityHandlers(): Record<string, RpcHandlerDef> {
  return {
    "activities.get": {
      schema: z.object({ id: z.string().min(1).max(128) }).passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const id = getString(params.id);
        if (!id) throw new Error("id is required.");
        const dbActivity = activityRepository.findById(id);
        if (!dbActivity) throw new Error("Activity not found.");
        const response: ActivityResponseDto = { activity: toActivityDetailDto(dbActivity) };
        return response;
      },
    },

    "activities.list": {
      schema: z.object({ limit: z.number().int().min(1).max(200).optional() }).passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? params.limit : 30;
        const activities = activityRepository.listSummaries(limit);
        const response: ActivityListResponseDto = { activities };
        return response;
      },
    },

    "activities.patch": {
      schema: z
        .object({
          id: z.string().min(1).max(128),
          title: z.string().max(200).optional(),
          timeLimitSeconds: z.number().int().min(0).max(8 * 60 * 60).nullable().optional(),
        })
        .passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const id = getString(params.id);
        if (!id) throw new Error("id is required.");
        const dbActivity = activityRepository.findById(id);
        if (!dbActivity) throw new Error("Activity not found.");
        if (!["DRAFT", "INCOMPLETE"].includes(dbActivity.status ?? "DRAFT")) {
          throw new Error("This activity has already been published.");
        }

        const title = typeof params.title === "string" ? params.title.trim() : undefined;
        const timeLimitSeconds =
          typeof params.timeLimitSeconds === "number" && Number.isFinite(params.timeLimitSeconds)
            ? Math.max(0, Math.min(8 * 60 * 60, Math.trunc(params.timeLimitSeconds)))
            : params.timeLimitSeconds === null
              ? null
              : undefined;

        const updated = activityRepository.update(id, {
          ...(typeof title === "string" && title ? { title } : {}),
          ...(typeof timeLimitSeconds !== "undefined" ? { time_limit_seconds: timeLimitSeconds } : {}),
        });
        if (!updated) throw new Error("Failed to update activity.");
        const response: ActivityResponseDto = { activity: toActivityDetailDto(updated) };
        return response;
      },
    },

    "activities.publish": {
      schema: z.object({ id: z.string().min(1).max(128) }).passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const id = getString(params.id);
        if (!id) throw new Error("id is required.");
        const dbActivity = activityRepository.findById(id);
        if (!dbActivity) throw new Error("Activity not found.");
        if ((dbActivity.status ?? "DRAFT") === "PUBLISHED") return { ok: true } satisfies PublishActivityResponseDto;
        if ((dbActivity.status ?? "DRAFT") === "INCOMPLETE") {
          throw new Error("Incomplete activities cannot be published until all failed slots are repaired.");
        }
        activityRepository.update(id, { status: "PUBLISHED" });
        return { ok: true } satisfies PublishActivityResponseDto;
      },
    },

    "activities.aiEdit": {
      schema: z
        .object({
          id: z.string().min(1).max(128),
          problemId: z.string().min(1).max(128),
          instruction: z.string().min(1).max(8000),
        })
        .passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const id = getString(params.id);
        const problemId = getString(params.problemId);
        const instruction = getString(params.instruction);
        if (!id) throw new Error("id is required.");
        if (!problemId) throw new Error("problemId is required.");
        if (!instruction) throw new Error("instruction is required.");

        const dbActivity = activityRepository.findById(id);
        if (!dbActivity) throw new Error("Activity not found.");
        if (!["DRAFT", "INCOMPLETE"].includes(dbActivity.status ?? "DRAFT")) {
          throw new Error("This activity has already been published.");
        }

        let problems: any[] = [];
        try {
          const parsedProblems = JSON.parse(dbActivity.problems);
          problems = Array.isArray(parsedProblems) ? parsedProblems : [];
        } catch {
          throw new Error("Failed to load activity problems.");
        }

        const idx = problems.findIndex((p) => p && typeof p === "object" && (p as any).id === problemId);
        if (idx < 0) throw new Error("Problem not found.");

        const updatedProblem = await editDraftProblemWithAi({
          existing: problems[idx],
          instruction,
        });
        const nextProblems = [...problems];
        nextProblems[idx] = updatedProblem;

        const updated = activityRepository.update(id, { problems: JSON.stringify(nextProblems) });
        if (!updated) throw new Error("Failed to update activity.");
        const response: ActivityResponseDto = { activity: toActivityDetailDto(updated) };
        return response;
      },
    },
  };
}
