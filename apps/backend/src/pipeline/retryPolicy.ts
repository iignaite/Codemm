import type { SlotStageName } from "../contracts/slotPipeline";

export type StageRetryPolicy = {
  maxAttempts: number;
  allowEscalation: boolean;
  terminalOnRepeatedFingerprint: boolean;
};

const POLICY: Record<Exclude<SlotStageName, "complete">, StageRetryPolicy> = {
  skeleton: { maxAttempts: 2, allowEscalation: false, terminalOnRepeatedFingerprint: true },
  tests: { maxAttempts: 2, allowEscalation: true, terminalOnRepeatedFingerprint: true },
  reference: { maxAttempts: 2, allowEscalation: true, terminalOnRepeatedFingerprint: true },
  validate: { maxAttempts: 1, allowEscalation: false, terminalOnRepeatedFingerprint: false },
  repair: { maxAttempts: 1, allowEscalation: true, terminalOnRepeatedFingerprint: true },
};

export function getStageRetryPolicy(stage: Exclude<SlotStageName, "complete">): StageRetryPolicy {
  return POLICY[stage];
}
