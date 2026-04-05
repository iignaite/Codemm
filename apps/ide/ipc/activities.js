const { z } = require("zod");

function registerActivitiesIpc(deps) {
  const { tryRegisterIpcHandler, validate, reqString, engineCall } = deps;

  tryRegisterIpcHandler("codemm:activities:list", async (_evt, args) => {
    const parsed = validate(
      z
        .object({
          limit: z.number().int().min(1).max(200).optional(),
        })
        .optional(),
      args
    );
    const limit = typeof parsed?.limit === "number" ? parsed.limit : 30;
    return engineCall("activities.list", { limit });
  });

  tryRegisterIpcHandler("codemm:activities:get", async (_evt, args) => {
    const parsed = validate(z.object({ id: z.string().min(1).max(128) }), args);
    const id = reqString(parsed.id, "id");
    return engineCall("activities.get", { id });
  });

  tryRegisterIpcHandler("codemm:activities:patch", async (_evt, args) => {
    const parsed = validate(
      z.object({
        id: z.string().min(1).max(128),
        title: z.string().max(200).optional(),
        timeLimitSeconds: z.number().int().min(0).max(8 * 60 * 60).nullable().optional(),
      }),
      args
    );
    const id = reqString(parsed.id, "id");
    const title = typeof parsed.title === "string" ? parsed.title : undefined;
    const timeLimitSeconds = typeof parsed.timeLimitSeconds !== "undefined" ? parsed.timeLimitSeconds : undefined;
    return engineCall("activities.patch", {
      id,
      ...(typeof title !== "undefined" ? { title } : {}),
      ...(typeof timeLimitSeconds !== "undefined" ? { timeLimitSeconds } : {}),
    });
  });

  tryRegisterIpcHandler("codemm:activities:publish", async (_evt, args) => {
    const parsed = validate(z.object({ id: z.string().min(1).max(128) }), args);
    const id = reqString(parsed.id, "id");
    return engineCall("activities.publish", { id });
  });

  tryRegisterIpcHandler("codemm:activities:aiEdit", async (_evt, args) => {
    const parsed = validate(
      z.object({
        id: z.string().min(1).max(128),
        problemId: z.string().min(1).max(128),
        instruction: z.string().min(1).max(8_000),
      }),
      args
    );
    const id = reqString(parsed.id, "id");
    const problemId = reqString(parsed.problemId, "problemId");
    const instruction = reqString(parsed.instruction, "instruction");
    if (instruction.length > 8_000) throw new Error("instruction is too large.");
    return engineCall("activities.aiEdit", { id, problemId, instruction }, { llm: true, useCase: "edit" });
  });
}

module.exports = { registerActivitiesIpc };
