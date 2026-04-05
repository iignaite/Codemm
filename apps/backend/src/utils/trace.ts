import { emitExecutionTrace } from "../infra/observability/executionTrace";
import { isTraceEnabled as traceEnabled, logText, truncateText } from "../infra/observability/logger";

type TraceData = Record<string, unknown>;

export function isTraceEnabled(): boolean {
  return traceEnabled();
}

export function truncate(text: string, maxLen: number): string {
  return truncateText(text, maxLen);
}

export function trace(event: string, data: TraceData = {}): void {
  if (!traceEnabled()) return;
  emitExecutionTrace(event, data);
}

export function traceText(
  event: string,
  text: string,
  opts?: { maxLen?: number; extra?: TraceData }
): void {
  if (!traceEnabled()) return;
  logText(event, opts?.maxLen ? truncateText(text, opts.maxLen) : text, opts?.extra ?? {});
}
