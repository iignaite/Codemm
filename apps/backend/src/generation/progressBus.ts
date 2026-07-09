import type { GenerationProgressEvent } from "../contracts/generationProgress";
import { logStructured } from "../infra/observability/logger";

type Listener = (event: GenerationProgressEvent) => void;

type Channel = {
  listeners: Set<Listener>;
  buffer: GenerationProgressEvent[];
  terminal: boolean;
  cleanupTimer: NodeJS.Timeout | null;
};

const channelsBySessionId = new Map<string, Channel>();

function getOrCreateChannel(sessionId: string): Channel {
  const existing = channelsBySessionId.get(sessionId);
  if (existing) return existing;
  const next: Channel = { listeners: new Set(), buffer: [], terminal: false, cleanupTimer: null };
  channelsBySessionId.set(sessionId, next);
  return next;
}

function scheduleCleanup(sessionId: string, channel: Channel): void {
  if (channel.cleanupTimer) return;
  channel.cleanupTimer = setTimeout(() => {
    channelsBySessionId.delete(sessionId);
  }, 5 * 60 * 1000);
  // Allow the process to exit naturally (important for tests/CLI).
  channel.cleanupTimer.unref?.();
}

export function publishGenerationProgress(sessionId: string, event: GenerationProgressEvent): void {
  if (!sessionId) return;
  const channel = getOrCreateChannel(sessionId);

  // Don't buffer heartbeats; they are only to keep UI responsive.
  if (event.type !== "heartbeat") {
    channel.buffer.push(event);
    if (channel.buffer.length > 400) {
      channel.buffer.splice(0, channel.buffer.length - 400);
    }
  }

  if (
    event.type === "generation_complete" ||
    event.type === "generation_completed" ||
    event.type === "generation_failed"
  ) {
    channel.terminal = true;
    scheduleCleanup(sessionId, channel);
  }

  if (channel.listeners.size === 0) return;
  for (const listener of channel.listeners) {
    try {
      listener(event);
    } catch (err) {
      // One bad subscriber must not break the others, but its failure is a bug worth seeing.
      logStructured("warn", "generation.progress.listener_failed", {
        sessionId,
        eventType: event.type,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function getGenerationProgressBuffer(sessionId: string): GenerationProgressEvent[] {
  const channel = channelsBySessionId.get(sessionId);
  return channel ? [...channel.buffer] : [];
}

export function subscribeGenerationProgress(sessionId: string, listener: Listener): () => void {
  const channel = getOrCreateChannel(sessionId);
  channel.listeners.add(listener);

  return () => {
    const c = channelsBySessionId.get(sessionId);
    if (!c) return;
    c.listeners.delete(listener);
    if (c.listeners.size === 0 && c.terminal) {
      scheduleCleanup(sessionId, c);
    }
  };
}
