import { logStructured } from "./logger";

export type TracePayload = Record<string, unknown>;
type Listener = (payload: TracePayload) => void;

const listenersByScopeId = new Map<string, Set<Listener>>();

function getScopeId(payload: TracePayload): string | null {
  const threadId = payload.threadId;
  if (typeof threadId === "string" && threadId) return threadId;
  const sessionId = payload.sessionId;
  if (typeof sessionId === "string" && sessionId) return sessionId;
  return null;
}

export function publishTrace(payload: TracePayload): void {
  const scopeId = getScopeId(payload);
  if (!scopeId) return;
  const listeners = listenersByScopeId.get(scopeId);
  if (!listeners || listeners.size === 0) return;
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch {
      // ignore listener failures
    }
  }
}

export function subscribeTrace(scopeId: string, listener: Listener): () => void {
  const existing = listenersByScopeId.get(scopeId);
  const listeners = existing ?? new Set<Listener>();
  listeners.add(listener);
  if (!existing) listenersByScopeId.set(scopeId, listeners);
  return () => {
    const current = listenersByScopeId.get(scopeId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listenersByScopeId.delete(scopeId);
  };
}

export function emitExecutionTrace(event: string, data: TracePayload = {}): TracePayload {
  const payload = logStructured("debug", event, data);
  publishTrace(payload);
  return payload;
}

export function emitExecutionLifecycle(event: string, data: TracePayload = {}): TracePayload {
  const payload = logStructured("info", event, data);
  publishTrace(payload);
  return payload;
}
