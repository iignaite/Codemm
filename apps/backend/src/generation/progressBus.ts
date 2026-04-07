import type { GenerationProgressEvent } from "../contracts/generationProgress";

type Listener = (event: GenerationProgressEvent) => void;

type Channel = {
  listeners: Set<Listener>;
  buffer: GenerationProgressEvent[];
  terminal: boolean;
  cleanupTimer: NodeJS.Timeout | null;
};

const channelsByRunId = new Map<string, Channel>();

function getOrCreateChannel(runId: string): Channel {
  const existing = channelsByRunId.get(runId);
  if (existing) return existing;
  const next: Channel = { listeners: new Set(), buffer: [], terminal: false, cleanupTimer: null };
  channelsByRunId.set(runId, next);
  return next;
}

function scheduleCleanup(runId: string, channel: Channel): void {
  if (channel.cleanupTimer) return;
  channel.cleanupTimer = setTimeout(() => {
    channelsByRunId.delete(runId);
  }, 5 * 60 * 1000);
  // Allow the process to exit naturally (important for tests/CLI).
  channel.cleanupTimer.unref?.();
}

export function publishGenerationProgress(runId: string, event: GenerationProgressEvent): void {
  if (!runId) return;
  const channel = getOrCreateChannel(runId);

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
    scheduleCleanup(runId, channel);
  }

  if (channel.listeners.size === 0) return;
  for (const listener of channel.listeners) {
    try {
      listener(event);
    } catch {
      // ignore listener errors
    }
  }
}

export function getGenerationProgressBuffer(runId: string): GenerationProgressEvent[] {
  const channel = channelsByRunId.get(runId);
  return channel ? [...channel.buffer] : [];
}

export function subscribeGenerationProgress(runId: string, listener: Listener): () => void {
  const channel = getOrCreateChannel(runId);
  channel.listeners.add(listener);

  return () => {
    const c = channelsByRunId.get(runId);
    if (!c) return;
    c.listeners.delete(listener);
    if (c.listeners.size === 0 && c.terminal) {
      scheduleCleanup(runId, c);
    }
  };
}
