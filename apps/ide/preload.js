const { contextBridge, ipcRenderer } = require("electron");

const generationListeners = new Map(); // subId -> handler
const ollamaPullListeners = new Map(); // subId -> handler

ipcRenderer.on("codemm:threads:generationEvent", (_evt, payload) => {
  const subId = payload && typeof payload.subId === "string" ? payload.subId : null;
  if (!subId) return;
  const handler = generationListeners.get(subId);
  if (!handler) return;
  try {
    handler(payload.event);
  } catch {
    // ignore
  }
});

ipcRenderer.on("codemm:ollama:pullEvent", (_evt, payload) => {
  const subId = payload && typeof payload.subId === "string" ? payload.subId : null;
  if (!subId) return;
  const handler = ollamaPullListeners.get(subId);
  if (!handler) return;
  try {
    handler(payload.event);
  } catch {
    // ignore
  }
});

contextBridge.exposeInMainWorld("codemm", {
  workspace: {
    get: () => ipcRenderer.invoke("codemm:workspace:get"),
    choose: () => ipcRenderer.invoke("codemm:workspace:choose"),
  },
  secrets: {
    getLlmSettings: () => ipcRenderer.invoke("codemm:secrets:getLlmSettings"),
    setLlmSettings: (args) => ipcRenderer.invoke("codemm:secrets:setLlmSettings", args),
    clearLlmSettings: () => ipcRenderer.invoke("codemm:secrets:clearLlmSettings"),
  },
  threads: {
    create: (args) => ipcRenderer.invoke("codemm:threads:create", args),
    list: (args) => ipcRenderer.invoke("codemm:threads:list", args),
    get: (args) => ipcRenderer.invoke("codemm:threads:get", args),
    setInstructions: (args) => ipcRenderer.invoke("codemm:threads:setInstructions", args),
    postMessage: (args) => ipcRenderer.invoke("codemm:threads:postMessage", args),
    generate: (args) => ipcRenderer.invoke("codemm:threads:generate", args),
    generateV2: (args) => ipcRenderer.invoke("codemm:threads:generateV2", args),
    regenerateSlot: (args) => ipcRenderer.invoke("codemm:threads:regenerateSlot", args),
    getGenerationDiagnostics: (args) => ipcRenderer.invoke("codemm:threads:getGenerationDiagnostics", args),
    subscribeGeneration: async ({ threadId, onEvent }) => {
      if (typeof onEvent !== "function") throw new Error("onEvent must be a function.");
      const res = await ipcRenderer.invoke("codemm:threads:subscribeGeneration", { threadId });
      const subId = res && typeof res.subId === "string" ? res.subId : null;
      if (!subId) throw new Error("Failed to subscribe.");

      generationListeners.set(subId, onEvent);

      const buffered = res && Array.isArray(res.buffered) ? res.buffered : [];
      for (const ev of buffered) {
        try {
          onEvent(ev);
        } catch {
          // ignore
        }
      }

      return {
        subId,
        unsubscribe: async () => {
          generationListeners.delete(subId);
          try {
            await ipcRenderer.invoke("codemm:threads:unsubscribeGeneration", { subId });
          } catch {
            // ignore
          }
        },
      };
    },
  },
  activities: {
    list: (args) => ipcRenderer.invoke("codemm:activities:list", args),
    get: (args) => ipcRenderer.invoke("codemm:activities:get", args),
    patch: (args) => ipcRenderer.invoke("codemm:activities:patch", args),
    publish: (args) => ipcRenderer.invoke("codemm:activities:publish", args),
    aiEdit: (args) => ipcRenderer.invoke("codemm:activities:aiEdit", args),
  },
  judge: {
    run: (args) => ipcRenderer.invoke("codemm:judge:run", args),
    submit: (args) => ipcRenderer.invoke("codemm:judge:submit", args),
  },
  ollama: {
    getStatus: (args) => ipcRenderer.invoke("codemm:ollama:getStatus", args),
    openInstall: async () => {
      try {
        // Use fire-and-forget so the renderer doesn't depend on an `ipcMain.handle(...)` being registered.
        // (We also register a handler in Electron main; this is just extra robustness.)
        ipcRenderer.send("codemm:ollama:openInstall");
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message ? String(e.message) : "Failed to open install link." };
      }
    },
    ensure: async ({ model, baseURL, onEvent }) => {
      if (typeof model !== "string" || !model.trim()) throw new Error("model is required.");
      const res = await ipcRenderer.invoke("codemm:ollama:ensure", { model, ...(typeof baseURL === "string" && baseURL.trim() ? { baseURL } : {}) });
      const subId = res && typeof res.subId === "string" ? res.subId : null;
      if (subId && typeof onEvent === "function") {
        ollamaPullListeners.set(subId, onEvent);
        const buffered = res && Array.isArray(res.buffered) ? res.buffered : [];
        for (const ev of buffered) {
          try {
            onEvent(ev);
          } catch {
            // ignore
          }
        }
      }

      return {
        ...res,
        ...(subId
          ? {
              subId,
              unsubscribe: async () => {
                ollamaPullListeners.delete(subId);
                try {
                  await ipcRenderer.invoke("codemm:ollama:unsubscribePull", { subId });
                } catch {
                  // ignore
                }
              },
            }
          : {}),
      };
    },
  },
});
