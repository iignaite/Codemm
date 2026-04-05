import type { GenerationOutcome } from "../contracts/generationOutcome";
import type { GeneratedProblem } from "../contracts/problem";
import type { CompletionMeta } from "../infra/llm/types";
import type { GenerationFailureKind } from "@codemm/shared-contracts";

export type { GenerationFailureKind } from "@codemm/shared-contracts";

export class GenerationContractError extends Error {
  slotIndex: number;
  llmOutputHash: string | undefined;
  rawSnippet: string | undefined;
  obligationId: string | undefined;
  llm: CompletionMeta | undefined;

  constructor(
    message: string,
    opts: { slotIndex: number; llmOutputHash?: string; rawSnippet?: string; obligationId?: string; llm?: CompletionMeta }
  ) {
    super(message);
    this.name = "GenerationContractError";
    this.slotIndex = opts.slotIndex;
    this.llmOutputHash = opts.llmOutputHash;
    this.rawSnippet = opts.rawSnippet;
    this.obligationId = opts.obligationId;
    this.llm = opts.llm;
  }
}

export class GenerationSlotFailureError extends Error {
  slotIndex: number;
  kind: GenerationFailureKind;
  attempts: number;
  title: string | undefined;
  llmOutputHash: string | undefined;
  llm: CompletionMeta | undefined;
  outcomesSoFar: GenerationOutcome[] | undefined;
  problemsSoFar: GeneratedProblem[] | undefined;

  constructor(
    message: string,
    opts: {
      slotIndex: number;
      kind: GenerationFailureKind;
      attempts: number;
      title?: string;
      llmOutputHash?: string;
      llm?: CompletionMeta;
      outcomesSoFar?: GenerationOutcome[];
      problemsSoFar?: GeneratedProblem[];
    }
  ) {
    super(message);
    this.name = "GenerationSlotFailureError";
    this.slotIndex = opts.slotIndex;
    this.kind = opts.kind;
    this.attempts = opts.attempts;
    this.title = opts.title;
    this.llmOutputHash = opts.llmOutputHash;
    this.llm = opts.llm;
    this.outcomesSoFar = opts.outcomesSoFar;
    this.problemsSoFar = opts.problemsSoFar;
  }
}
