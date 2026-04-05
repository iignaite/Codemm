import type { ExecutionContext, ExecutionResultBag, ExecutionStateBag } from "./ExecutionContext";

export type StepResult<
  TState extends ExecutionStateBag = ExecutionStateBag,
  TResults extends ExecutionResultBag = ExecutionResultBag,
> =
  | void
  | Partial<TState>
  | {
      state?: Partial<TState>;
      results?: Partial<TResults>;
    };

export type StepErrorResult<
  TState extends ExecutionStateBag = ExecutionStateBag,
  TResults extends ExecutionResultBag = ExecutionResultBag,
> =
  | { handled: true; state?: Partial<TState>; results?: Partial<TResults> }
  | { handled: false };

export interface Step<
  TState extends ExecutionStateBag = ExecutionStateBag,
  TResults extends ExecutionResultBag = ExecutionResultBag,
> {
  id: string;
  shouldSkip?(ctx: ExecutionContext<TState, TResults>): boolean;
  run(ctx: ExecutionContext<TState, TResults>): Promise<StepResult<TState, TResults>> | StepResult<TState, TResults>;
  onError?(
    ctx: ExecutionContext<TState, TResults>,
    err: unknown
  ): Promise<StepErrorResult<TState, TResults>> | StepErrorResult<TState, TResults>;
}
