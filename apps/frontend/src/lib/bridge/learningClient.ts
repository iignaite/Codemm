import { getCodemmBridge } from "./codemmBridge";
import type { LearningPathResponseDto } from "@codemm/shared-contracts";

export type PathLanguage = "java" | "python" | "cpp" | "sql";

export const learningClient = {
  getPath(args: { language: PathLanguage }) {
    const api = getCodemmBridge().learning;
    if (!api?.getPath) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.getPath(args) as Promise<LearningPathResponseDto>;
  },
};
