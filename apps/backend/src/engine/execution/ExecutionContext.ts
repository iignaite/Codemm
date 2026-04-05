import type { ResolvedLlmRoutePlan } from "../../infra/llm/types";
import { createLogger } from "../../infra/observability/logger";

export type ExecutionStateBag = Record<string, unknown>;
export type ExecutionResultBag = Record<string, unknown>;

export type ExecutionContext<
  TState extends ExecutionStateBag = ExecutionStateBag,
  TResults extends ExecutionResultBag = ExecutionResultBag,
> = {
  workflowId: string;
  threadId?: string;
  runId?: string;
  routePlan?: ResolvedLlmRoutePlan | null;
  publishProgress?: (event: unknown) => void;
  logger: ReturnType<typeof createLogger>;
  state: TState;
  results: TResults;
  setState(patch: Partial<TState>): void;
  setResult<K extends keyof TResults>(key: K, value: TResults[K]): void;
  getResult<K extends keyof TResults>(key: K): TResults[K] | undefined;
};

export function createExecutionContext<
  TState extends ExecutionStateBag,
  TResults extends ExecutionResultBag,
>(args: {
  workflowId: string;
  threadId?: string;
  runId?: string;
  routePlan?: ResolvedLlmRoutePlan | null;
  publishProgress?: (event: unknown) => void;
  loggerName?: string;
  initialState: TState;
  initialResults?: TResults;
}): ExecutionContext<TState, TResults> {
  const state = args.initialState;
  const results = (args.initialResults ?? ({} as TResults));
  return {
    workflowId: args.workflowId,
    ...(args.threadId ? { threadId: args.threadId } : {}),
    ...(args.runId ? { runId: args.runId } : {}),
    ...(typeof args.routePlan !== "undefined" ? { routePlan: args.routePlan } : {}),
    ...(args.publishProgress ? { publishProgress: args.publishProgress } : {}),
    logger: createLogger(args.loggerName ?? "execution"),
    state,
    results,
    setState(patch) {
      Object.assign(state, patch);
    },
    setResult(key, value) {
      results[key] = value;
    },
    getResult(key) {
      return results[key];
    },
  };
}
