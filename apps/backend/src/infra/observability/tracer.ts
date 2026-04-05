import { AsyncLocalStorage } from "async_hooks";

export type TraceContext = {
  sessionId?: string;
  threadId?: string;
  runId?: string;
  workflowId?: string;
  provider?: string;
  stepId?: string;
  userId?: number;
};

const storage = new AsyncLocalStorage<TraceContext>();

export function withTraceContext<T>(ctx: TraceContext, fn: () => T): T {
  const prev = storage.getStore() ?? {};
  return storage.run({ ...prev, ...ctx }, fn);
}

export function getTraceContext(): TraceContext | undefined {
  return storage.getStore();
}
