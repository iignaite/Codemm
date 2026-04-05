import type { LlmControlStatus, LlmSettingsResponse, LocalLlmStatus, ResolvedLlmRoutePlan } from "@codemm/shared-contracts";
import { getCodemmBridge } from "./codemmBridge";

export const llmClient = {
  getSettings() {
    const api = getCodemmBridge().secrets;
    if (!api?.getLlmSettings) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.getLlmSettings() as Promise<LlmSettingsResponse>;
  },
  saveSettings(args: {
    provider: string;
    apiKey?: string;
    model?: string | null;
    baseURL?: string | null;
    routingProfile?: LlmSettingsResponse["routingProfile"];
    roleModels?: Record<string, string>;
  }) {
    const api = getCodemmBridge().secrets;
    if (!api?.setLlmSettings) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.setLlmSettings(args);
  },
  clearSettings() {
    const api = getCodemmBridge().secrets;
    if (!api?.clearLlmSettings) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.clearLlmSettings();
  },
  getStatus() {
    const api = getCodemmBridge().llm;
    if (!api?.getStatus) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.getStatus() as Promise<LlmControlStatus>;
  },
  getRoutePlan() {
    const api = getCodemmBridge().llm;
    if (!api?.getRoutePlan) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.getRoutePlan() as Promise<ResolvedLlmRoutePlan | null>;
  },
  ensureReady(args: { activateOnSuccess?: boolean; forcedModel?: string | null; useCase?: "general" | "dialogue" | "generation" | "edit" }) {
    const api = getCodemmBridge().llm;
    if (!api?.ensureReady) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.ensureReady(args);
  },
  subscribeStatus(args: { onEvent: (status: LocalLlmStatus) => void }) {
    const api = getCodemmBridge().llm;
    if (!api?.subscribeStatus) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.subscribeStatus(args);
  },
};
