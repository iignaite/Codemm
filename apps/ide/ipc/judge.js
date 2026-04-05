const { z } = require("zod");

function registerJudgeIpc(deps) {
  const { tryRegisterIpcHandler, validate, engineCall } = deps;

  tryRegisterIpcHandler("codemm:judge:run", async (_evt, args) => {
    const parsed = validate(
      z
        .object({
          language: z.enum(["java", "python", "cpp", "sql"]),
          code: z.string().min(1).max(200_000).optional(),
          files: z.record(z.string(), z.string()).optional(),
          mainClass: z.string().min(1).max(256).optional(),
          stdin: z.string().max(50_000).optional(),
        })
        .refine((v) => Boolean(v.code) !== Boolean(v.files), { message: 'Provide either "code" or "files".' }),
      args
    );
    return engineCall("judge.run", parsed);
  });

  tryRegisterIpcHandler("codemm:judge:submit", async (_evt, args) => {
    const parsed = validate(
      z
        .object({
          language: z.enum(["java", "python", "cpp", "sql"]).optional(),
          testSuite: z.string().min(1).max(200_000),
          code: z.string().min(1).max(200_000).optional(),
          files: z.record(z.string(), z.string()).optional(),
          activityId: z.string().min(1).max(128).optional(),
          problemId: z.string().min(1).max(128).optional(),
        })
        .refine((v) => Boolean(v.code) !== Boolean(v.files), { message: 'Provide either "code" or "files".' }),
      args
    );
    return engineCall("judge.submit", parsed);
  });
}

module.exports = { registerJudgeIpc };
