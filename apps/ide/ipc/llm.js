const crypto = require("crypto");
const { z } = require("zod");

const llmStatusSubs = new Map();
let llmStatusBroadcastWired = false;

function registerLlmIpc(deps) {
  const {
    tryRegisterIpcHandler,
    validate,
    storage,
    loadSecrets,
    saveSecrets,
    clearSecrets,
    dialog,
    buildRoutePlan,
    requireLocalLlmOrchestrator,
    sanitizeRoleModels,
    OLLAMA_DEFAULT_URL,
    getMainWindow,
  } = deps;

  if (!llmStatusBroadcastWired) {
    llmStatusBroadcastWired = true;
    requireLocalLlmOrchestrator().subscribe((status) => {
      for (const subId of llmStatusSubs.keys()) {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("codemm:llm:statusEvent", { subId, status });
        }
      }
    });
  }

  tryRegisterIpcHandler("codemm:secrets:getLlmSettings", () => {
    const { llm } = loadSecrets({ userDataDir: storage.userDataDir });
    const isOllama = llm && String(llm.provider || "").toLowerCase() === "ollama";
    return {
      configured: Boolean(llm && (llm.apiKey || isOllama)),
      provider: llm ? llm.provider : null,
      model: llm ? llm.model ?? null : null,
      baseURL: llm ? llm.baseURL ?? null : null,
      routingProfile: llm ? llm.routingProfile ?? "auto" : "auto",
      roleModels: llm ? llm.roleModels ?? null : null,
      updatedAt: llm ? llm.updatedAt ?? null : null,
    };
  });

  tryRegisterIpcHandler("codemm:secrets:setLlmSettings", async (_evt, args) => {
    const parsed = validate(
      z.object({
        provider: z.enum(["openai", "anthropic", "gemini", "ollama"]),
        apiKey: z.string().min(10).max(500).optional(),
        model: z.string().min(1).max(128).optional().nullable(),
        baseURL: z.string().min(1).max(512).optional().nullable(),
        routingProfile: z.enum(["auto", "fast_local", "balanced_local", "strong_local", "custom"]).optional().nullable(),
        roleModels: z.record(z.string().min(1).max(128)).optional().nullable(),
      }),
      args
    );
    const provider = parsed.provider.trim().toLowerCase();
    const apiKey = typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "";
    const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
    const baseURL = typeof parsed.baseURL === "string" ? parsed.baseURL.trim() : "";
    const routingProfile = typeof parsed.routingProfile === "string" ? parsed.routingProfile : "auto";
    const roleModels = sanitizeRoleModels(parsed.roleModels);
    if (!(provider === "openai" || provider === "anthropic" || provider === "gemini" || provider === "ollama")) {
      throw new Error("Invalid provider.");
    }
    if (provider !== "ollama") {
      if (!apiKey || apiKey.length < 10) throw new Error("API key is required.");
    }

    const { updatedAt } = saveSecrets({
      userDataDir: storage.userDataDir,
      provider,
      ...(provider === "ollama"
        ? { apiKey: null, model: model || null, baseURL: baseURL || OLLAMA_DEFAULT_URL, routingProfile, roleModels }
        : { apiKey, model: model || null, baseURL: baseURL || null, routingProfile, roleModels }),
    });
    dialog
      .showMessageBox({
        type: "info",
        message: "LLM settings saved",
        detail: provider === "ollama" ? "Local model preference saved." : "Cloud provider settings saved.",
      })
      .catch(() => {});
    return { ok: true, updatedAt };
  });

  tryRegisterIpcHandler("codemm:secrets:clearLlmSettings", async () => {
    clearSecrets({ userDataDir: storage.userDataDir });
    dialog
      .showMessageBox({
        type: "info",
        message: "LLM settings cleared",
        detail: "Provider preference cleared.",
      })
      .catch(() => {});
    return { ok: true };
  });

  tryRegisterIpcHandler("codemm:llm:getStatus", async () => {
    const llm = loadSecrets({ userDataDir: storage.userDataDir }).llm;
    return {
      activeProvider: llm?.provider ?? null,
      configured: Boolean(llm && (llm.apiKey || String(llm.provider || "").toLowerCase() === "ollama")),
      local: requireLocalLlmOrchestrator().getStatus(),
    };
  });

  tryRegisterIpcHandler("codemm:llm:getRoutePlan", async () => {
    const llm = loadSecrets({ userDataDir: storage.userDataDir }).llm;
    return buildRoutePlan(llm);
  });

  tryRegisterIpcHandler("codemm:llm:ensureReady", async (_evt, args) => {
    const parsed = validate(
      z
        .object({
          activateOnSuccess: z.boolean().optional(),
          forcedModel: z.string().min(1).max(128).optional().nullable(),
          useCase: z.enum(["general", "dialogue", "generation", "edit"]).optional(),
        })
        .optional(),
      args
    );
    const ready = await requireLocalLlmOrchestrator().ensureReady({
      activateOnSuccess: parsed?.activateOnSuccess === true,
      forcedModel: typeof parsed?.forcedModel === "string" ? parsed.forcedModel : null,
      useCase: parsed?.useCase ?? "general",
    });
    return { ok: true, ready, status: requireLocalLlmOrchestrator().getStatus() };
  });

  tryRegisterIpcHandler("codemm:llm:acquireLease", async (_evt, args) => {
    const parsed = validate(
      z
        .object({
          reason: z.string().min(1).max(256),
          forcedModel: z.string().min(1).max(128).optional().nullable(),
          useCase: z.enum(["general", "dialogue", "generation", "edit"]).optional(),
        })
        .passthrough(),
      args
    );
    const snapshot = await requireLocalLlmOrchestrator().acquireLease({
      reason: parsed.reason,
      forcedModel: typeof parsed.forcedModel === "string" ? parsed.forcedModel : null,
      useCase: parsed.useCase ?? "general",
    });
    return { ok: true, snapshot };
  });

  tryRegisterIpcHandler("codemm:llm:releaseLease", async (_evt, args) => {
    const parsed = validate(z.object({ leaseId: z.string().min(1).max(128) }), args);
    await requireLocalLlmOrchestrator().releaseLease(parsed.leaseId);
    return { ok: true };
  });

  tryRegisterIpcHandler("codemm:llm:subscribeStatus", async () => {
    const subId = crypto.randomUUID();
    llmStatusSubs.set(subId, true);
    return { subId, buffered: [requireLocalLlmOrchestrator().getStatus()] };
  });

  tryRegisterIpcHandler("codemm:llm:unsubscribeStatus", async (_evt, args) => {
    const parsed = validate(z.object({ subId: z.string().min(1).max(128) }), args);
    llmStatusSubs.delete(parsed.subId);
    return { ok: true };
  });
}

module.exports = { registerLlmIpc };
