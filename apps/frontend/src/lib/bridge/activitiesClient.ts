import { getCodemmBridge } from "./codemmBridge";
import type { Activity } from "@/app/activity/[id]/types";

export const activitiesClient = {
  list(args: { limit?: number }) {
    const api = getCodemmBridge().activities;
    if (!api?.list) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.list(args);
  },
  get(args: { id: string }) {
    const api = getCodemmBridge().activities;
    if (!api?.get) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.get(args) as Promise<{ activity?: Activity }>;
  },
  patch(args: { id: string; title?: string; timeLimitSeconds?: number | null }) {
    const api = getCodemmBridge().activities;
    if (!api?.patch) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.patch(args) as Promise<{ activity?: Activity }>;
  },
  publish(args: { id: string }) {
    const api = getCodemmBridge().activities;
    if (!api?.publish) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.publish(args);
  },
  aiEdit(args: { id: string; problemId: string; instruction: string }) {
    const api = getCodemmBridge().activities;
    if (!api?.aiEdit) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.aiEdit(args) as Promise<{ activity?: Activity }>;
  },
};
