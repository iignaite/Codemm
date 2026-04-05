import { getCodemmBridge } from "./codemmBridge";

export const judgeClient = {
  run(args: {
    language: "java" | "python" | "cpp" | "sql";
    code?: string;
    files?: Record<string, string>;
    mainClass?: string;
    stdin?: string;
  }) {
    const api = getCodemmBridge().judge;
    if (!api?.run) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.run(args);
  },
  submit(args: {
    language?: "java" | "python" | "cpp" | "sql";
    testSuite: string;
    code?: string;
    files?: Record<string, string>;
    activityId?: string;
    problemId?: string;
  }) {
    const api = getCodemmBridge().judge;
    if (!api?.submit) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.submit(args);
  },
};
