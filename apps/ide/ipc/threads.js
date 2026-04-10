const { z } = require("zod");

function registerThreadsIpc(deps) {
  const { tryRegisterIpcHandler, validate, reqString, engineCall } = deps;

  tryRegisterIpcHandler("codemm:threads:create", async (_evt, args) => {
    const parsed = validate(
      z
        .object({
          learning_mode: z.enum(["practice", "guided"]).optional(),
        })
        .optional(),
      args
    );
    const learning_mode = parsed?.learning_mode ?? null;
    return engineCall("threads.create", { ...(learning_mode ? { learning_mode } : {}) });
  });

  tryRegisterIpcHandler("codemm:threads:list", async (_evt, args) => {
    const parsed = validate(
      z
        .object({
          limit: z.number().int().min(1).max(200).optional(),
        })
        .optional(),
      args
    );
    const limit = typeof parsed?.limit === "number" ? parsed.limit : 30;
    return engineCall("threads.list", { limit });
  });

  tryRegisterIpcHandler("codemm:threads:get", async (_evt, args) => {
    const parsed = validate(z.object({ threadId: z.string().min(1).max(128) }), args);
    const threadId = reqString(parsed.threadId, "threadId");
    return engineCall("threads.get", { threadId });
  });

  tryRegisterIpcHandler("codemm:threads:setInstructions", async (_evt, args) => {
    const parsed = validate(
      z.object({
        threadId: z.string().min(1).max(128),
        instructions_md: z.string().max(8000).nullable(),
      }),
      args
    );
    const threadId = reqString(parsed.threadId, "threadId");
    return engineCall("threads.setInstructions", { threadId, instructions_md: parsed.instructions_md });
  });

  tryRegisterIpcHandler("codemm:threads:postMessage", async (_evt, args) => {
    const parsed = validate(
      z.object({
        threadId: z.string().min(1).max(128),
        message: z.string().min(1).max(50_000),
      }),
      args
    );
    const threadId = reqString(parsed.threadId, "threadId");
    const message = reqString(parsed.message, "message");
    if (message.length > 50_000) throw new Error("message is too large.");
    try {
      return await engineCall("threads.postMessage", { threadId, message }, { llm: true, useCase: "dialogue" });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error ?? "");
      if (/session state is READY/i.test(text)) {
        return {
          accepted: true,
          done: true,
          state: "READY",
          next_action: "ready",
        };
      }
      throw error;
    }
  });

  tryRegisterIpcHandler("codemm:threads:generate", async (_evt, args) => {
    const parsed = validate(
      z.object({
        threadId: z.string().min(1).max(128),
        runId: z.string().min(1).max(128).optional(),
      }),
      args
    );
    const threadId = reqString(parsed.threadId, "threadId");
    return engineCall(
      "threads.generate",
      { threadId, ...(typeof parsed.runId === "string" ? { runId: parsed.runId } : {}) },
      { llm: true, useCase: "generation" }
    );
  });

  tryRegisterIpcHandler("codemm:threads:generateV2", async (_evt, args) => {
    const parsed = validate(
      z.object({
        threadId: z.string().min(1).max(128),
        runId: z.string().min(1).max(128).optional(),
      }),
      args
    );
    const threadId = reqString(parsed.threadId, "threadId");
    return engineCall(
      "threads.generateV2",
      { threadId, ...(typeof parsed.runId === "string" ? { runId: parsed.runId } : {}) },
      { llm: true, useCase: "generation" }
    );
  });

  tryRegisterIpcHandler("codemm:threads:regenerateSlot", async (_evt, args) => {
    const parsed = validate(
      z.object({
        threadId: z.string().min(1).max(128),
        slotIndex: z.number().int().min(0).max(256),
        strategy: z
          .enum([
            "retry_full_slot",
            "repair_reference_solution",
            "repair_test_suite",
            "downgrade_difficulty",
            "narrow_topics",
          ])
          .optional(),
      }),
      args
    );
    const threadId = reqString(parsed.threadId, "threadId");
    return engineCall(
      "threads.regenerateSlot",
      {
        threadId,
        slotIndex: parsed.slotIndex,
        ...(typeof parsed.strategy === "string" ? { strategy: parsed.strategy } : {}),
      },
      { llm: true, useCase: "generation" }
    );
  });

  tryRegisterIpcHandler("codemm:threads:getGenerationDiagnostics", async (_evt, args) => {
    const parsed = validate(
      z.object({
        threadId: z.string().min(1).max(128),
        runId: z.string().min(1).max(128).optional(),
        limit: z.number().int().min(1).max(5000).optional(),
      }),
      args
    );
    const threadId = reqString(parsed.threadId, "threadId");
    return engineCall("threads.getGenerationDiagnostics", {
      threadId,
      ...(typeof parsed.runId === "string" ? { runId: parsed.runId } : {}),
      ...(typeof parsed.limit === "number" ? { limit: parsed.limit } : {}),
    });
  });

  tryRegisterIpcHandler("codemm:threads:subscribeGeneration", async (_evt, args) => {
    const parsed = validate(
      z.object({
        threadId: z.string().min(1).max(128),
        runId: z.string().min(1).max(128).optional(),
      }),
      args
    );
    const threadId = reqString(parsed.threadId, "threadId");
    return engineCall("threads.subscribeGeneration", {
      threadId,
      ...(typeof parsed.runId === "string" ? { runId: parsed.runId } : {}),
    });
  });

  tryRegisterIpcHandler("codemm:threads:unsubscribeGeneration", async (_evt, args) => {
    const parsed = validate(z.object({ subId: z.string().min(1).max(128) }), args);
    const subId = reqString(parsed.subId, "subId");
    return engineCall("threads.unsubscribeGeneration", { subId });
  });
}

module.exports = { registerThreadsIpc };
