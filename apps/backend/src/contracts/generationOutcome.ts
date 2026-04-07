import type { GenerationFailureKind, GenerationSlotTerminalStatus } from "@codemm/shared-contracts";

export type GenerationOutcome = {
  slotIndex: number;
  success: boolean;
  status: GenerationSlotTerminalStatus;
  retries: number;
  failureKind?: GenerationFailureKind;
  failureCode?: string;
  message?: string;
  appliedFallback?: string;
};
