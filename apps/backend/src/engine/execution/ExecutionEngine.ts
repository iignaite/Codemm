import { emitExecutionLifecycle, emitExecutionTrace } from "../../infra/observability/executionTrace";
import { withTraceContext } from "../../infra/observability/tracer";
import type { ExecutionContext, ExecutionResultBag, ExecutionStateBag } from "./ExecutionContext";
import type { Step, StepResult } from "./Step";

function applyStepResult<TState extends ExecutionStateBag, TResults extends ExecutionResultBag>(
  ctx: ExecutionContext<TState, TResults>,
  result: StepResult<TState, TResults>
): void {
  if (!result) return;
  if (typeof result === "object" && result !== null && ("state" in result || "results" in result)) {
    if (result.state) ctx.setState(result.state);
    if (result.results) {
      for (const [key, value] of Object.entries(result.results)) {
        ctx.setResult(key as keyof TResults, value as TResults[keyof TResults]);
      }
    }
    return;
  }
  ctx.setState(result as Partial<TState>);
}

export class ExecutionEngine<
  TState extends ExecutionStateBag = ExecutionStateBag,
  TResults extends ExecutionResultBag = ExecutionResultBag,
> {
  constructor(private readonly steps: Step<TState, TResults>[]) {}

  async run(ctx: ExecutionContext<TState, TResults>): Promise<ExecutionContext<TState, TResults>> {
    return withTraceContext(
      {
        ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
        ...(ctx.threadId ? { sessionId: ctx.threadId } : {}),
        ...(ctx.runId ? { runId: ctx.runId } : {}),
        workflowId: ctx.workflowId,
      },
      async () => {
        emitExecutionLifecycle("execution.workflow.started", {
          workflowId: ctx.workflowId,
          ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
          ...(ctx.runId ? { runId: ctx.runId } : {}),
          steps: this.steps.map((step) => step.id),
        });

        for (const step of this.steps) {
          if (step.shouldSkip?.(ctx)) {
            emitExecutionTrace("execution.step.skipped", { workflowId: ctx.workflowId, stepId: step.id });
            continue;
          }

          try {
            emitExecutionLifecycle("execution.step.started", { workflowId: ctx.workflowId, stepId: step.id });
            const result = await withTraceContext({ stepId: step.id }, () => step.run(ctx));
            applyStepResult(ctx, result);
            emitExecutionLifecycle("execution.step.succeeded", { workflowId: ctx.workflowId, stepId: step.id });
          } catch (err) {
            emitExecutionLifecycle("execution.step.failed", {
              workflowId: ctx.workflowId,
              stepId: step.id,
              message: err instanceof Error ? err.message : String(err),
            });
            const recovery = step.onError ? await step.onError(ctx, err) : { handled: false as const };
            if (!recovery.handled) {
              emitExecutionLifecycle("execution.workflow.failed", {
                workflowId: ctx.workflowId,
                stepId: step.id,
                message: err instanceof Error ? err.message : String(err),
              });
              throw err;
            }
            if (recovery.state) ctx.setState(recovery.state);
            if (recovery.results) {
              for (const [key, value] of Object.entries(recovery.results)) {
                ctx.setResult(key as keyof TResults, value as TResults[keyof TResults]);
              }
            }
          }
        }

        emitExecutionLifecycle("execution.workflow.completed", {
          workflowId: ctx.workflowId,
          ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
          ...(ctx.runId ? { runId: ctx.runId } : {}),
        });
        return ctx;
      }
    );
  }
}
