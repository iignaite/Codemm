import type { JudgeRunRequestDto, JudgeRunResultDto, JudgeSubmitRequestDto, JudgeSubmitResultDto } from "@codemm/shared-contracts";
import { getCodemmBridge } from "./codemmBridge";

export const judgeClient = {
  run(args: JudgeRunRequestDto) {
    const api = getCodemmBridge().judge;
    if (!api?.run) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.run(args) as Promise<JudgeRunResultDto>;
  },
  submit(args: JudgeSubmitRequestDto) {
    const api = getCodemmBridge().judge;
    if (!api?.submit) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.submit(args) as Promise<JudgeSubmitResultDto>;
  },
};
