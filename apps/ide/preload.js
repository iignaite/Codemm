const { contextBridge, ipcRenderer } = require("electron");

const generationListeners = new Map();
const llmStatusListeners = new Map();

ipcRenderer.on("codemm:threads:generationEvent", (_evt, payload) => {
  const subId = payload && typeof payload.subId === "string" ? payload.subId : null;
  if (!subId) return;
  const handler = generationListeners.get(subId);
  if (!handler) return;
  try {
    handler(payload.event);
  } catch {
    // ignore listener failures
  }
});

ipcRenderer.on("codemm:llm:statusEvent", (_evt, payload) => {
  const subId = payload && typeof payload.subId === "string" ? payload.subId : null;
  if (!subId) return;
  const handler = llmStatusListeners.get(subId);
  if (!handler) return;
  try {
    handler(payload.status);
  } catch {
    // ignore listener failures
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
  llm: {
    getStatus: () => ipcRenderer.invoke("codemm:llm:getStatus"),
    getRoutePlan: () => ipcRenderer.invoke("codemm:llm:getRoutePlan"),
    ensureReady: (args) => ipcRenderer.invoke("codemm:llm:ensureReady", args),
    acquireLease: (args) => ipcRenderer.invoke("codemm:llm:acquireLease", args),
    releaseLease: (args) => ipcRenderer.invoke("codemm:llm:releaseLease", args),
    subscribeStatus: async ({ onEvent }) => {
      if (typeof onEvent !== "function") throw new Error("onEvent must be a function.");
      const res = await ipcRenderer.invoke("codemm:llm:subscribeStatus");
      const subId = res && typeof res.subId === "string" ? res.subId : null;
      if (!subId) throw new Error("Failed to subscribe to local LLM status.");

      llmStatusListeners.set(subId, onEvent);
      const buffered = res && Array.isArray(res.buffered) ? res.buffered : [];
      for (const event of buffered) {
        try {
          onEvent(event);
        } catch {
          // ignore listener failures
        }
      }

      return {
        subId,
        unsubscribe: async () => {
          llmStatusListeners.delete(subId);
          try {
            await ipcRenderer.invoke("codemm:llm:unsubscribeStatus", { subId });
          } catch {
            // ignore unsubscribe failures
          }
        },
      };
    },
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
      if (!subId) throw new Error("Failed to subscribe to generation progress.");

      generationListeners.set(subId, onEvent);
      const buffered = res && Array.isArray(res.buffered) ? res.buffered : [];
      for (const event of buffered) {
        try {
          onEvent(event);
        } catch {
          // ignore listener failures
        }
      }

      return {
        subId,
        unsubscribe: async () => {
          generationListeners.delete(subId);
          try {
            await ipcRenderer.invoke("codemm:threads:unsubscribeGeneration", { subId });
          } catch {
            // ignore unsubscribe failures
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
});
