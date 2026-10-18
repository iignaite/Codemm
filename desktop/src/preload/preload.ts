// The renderer's only door to the main process: one invoke call on one
// channel. The typed CodemmApi client is built on top of it in the renderer.
import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge, JobProgress, JobStep } from '../shared/api';

// Electron rejects a failed invoke as "Error invoking remote method 'codemm': Error: <message>".
// The renderer gets <message> alone, so Codemm's codes (codemm:repair and the rest) match as sent.
// Kept here, inline: a sandboxed preload can't load other modules.
const ENVELOPE = /^Error invoking remote method 'codemm': (?:\w*Error: )?/;

const bridge: Bridge = {
  invoke: (method, args) =>
    ipcRenderer.invoke('codemm', method, args).catch((e: unknown) => {
      throw new Error((e instanceof Error ? e.message : String(e)).replace(ENVELOPE, ''));
    }),
  // One-way: main sends check progress to the app window. Only the phase and counts reach the page.
  onCheckProgress: (listener) => {
    const forward = (_event: unknown, p: { run?: string; phase: 'building' | 'visible' | 'hidden'; done: number; total: number }) =>
      listener({ ...(typeof p.run === 'string' ? { run: p.run } : {}), phase: p.phase, done: p.done, total: p.total });
    ipcRenderer.on('codemm:check-progress', forward);
    return () => void ipcRenderer.removeListener('codemm:check-progress', forward);
  },
  // One-way: main sends each agent job's progress. Only its kind, stage, counts, times, and capped steps:
  // a query, a host and path, or a step label.
  onJobProgress: (listener) => {
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
    const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    const step = (s: { kind?: unknown; query?: unknown; url?: unknown; label?: unknown }): JobStep[] =>
      s?.kind === 'search' ? [{ kind: 'search', query: text(s.query, 120) }]
        : s?.kind === 'read' ? [{ kind: 'read', url: text(s.url, 200) }]
          : s?.kind === 'step' ? [{ kind: 'step', label: text(s.label, 160) }] : [];
    const kinds = ['research', 'roadmap', 'setup', 'lesson', 'author', 'tutor'];
    const forward = (_event: unknown, p: Record<string, unknown>) => {
      if (typeof p?.job !== 'string' || !kinds.includes(p.kind as string)) return;
      const retry = p.retry as { attempt?: unknown; of?: unknown } | undefined;
      listener({
        job: text(p.job, 64),
        kind: p.kind as JobProgress['kind'],
        ...(typeof p.concept === 'string' ? { concept: text(p.concept, 64) } : {}),
        stage: count(p.stage),
        steps: (Array.isArray(p.steps) ? p.steps.slice(0, 8) : []).flatMap(step),
        count: count(p.count),
        ...(retry && typeof retry === 'object' ? { retry: { attempt: count(retry.attempt), of: count(retry.of) } } : {}),
        thinking: p.thinking === true,
        elapsedMs: count(p.elapsedMs),
        idleMs: count(p.idleMs),
        ...(p.ended === true ? { ended: true as const } : {}),
      });
    };
    ipcRenderer.on('codemm:job-progress', forward);
    return () => void ipcRenderer.removeListener('codemm:job-progress', forward);
  },
  // One-way: main sends what a Run's program printed, only to the window that started it, or a stage starting.
  onRunOutput: (listener) => {
    const forward = (_event: unknown, o: { run?: unknown; stream?: unknown; text?: unknown; started?: unknown; limitMs?: unknown }) => {
      if (typeof o.run !== 'string') return;
      if ((o.stream === 'stdout' || o.stream === 'stderr') && typeof o.text === 'string') listener({ run: o.run, stream: o.stream, text: o.text });
      else if ((o.started === 'build' || o.started === 'run') && typeof o.limitMs === 'number') listener({ run: o.run, started: o.started, limitMs: o.limitMs });
    };
    ipcRenderer.on('codemm:run-output', forward);
    return () => void ipcRenderer.removeListener('codemm:run-output', forward);
  },
};

contextBridge.exposeInMainWorld('codemm', bridge);
