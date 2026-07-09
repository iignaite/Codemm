const { z } = require("zod");

function registerLearningIpc(deps) {
  const { tryRegisterIpcHandler, validate, engineCall } = deps;

  tryRegisterIpcHandler("codemm:learning:getProfile", async () => {
    return engineCall("learning.getProfile", {});
  });

  tryRegisterIpcHandler("codemm:learning:updateProfile", async (_evt, args) => {
    const parsed = validate(
      z
        .object({
          goal: z.string().trim().max(500).nullable().optional(),
          preferredStyle: z.enum(["guided", "exploratory"]).nullable().optional(),
        })
        .strict(),
      args
    );
    return engineCall("learning.updateProfile", parsed);
  });

  tryRegisterIpcHandler("codemm:learning:getMastery", async (_evt, args) => {
    const parsed = validate(
      z.object({ language: z.enum(["java", "python", "cpp", "sql"]) }).strict(),
      args
    );
    return engineCall("learning.getMastery", parsed);
  });
}

module.exports = { registerLearningIpc };
