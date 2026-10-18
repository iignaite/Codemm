// The renderer's only door to the main process: one invoke call on one
// channel. The typed CodemmApi client is built on top of it in the renderer.
import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge, FinishedTest } from '../shared/api';

// Electron rejects a failed invoke as "Error invoking remote method 'codemm': Error: <message>".
// The renderer gets <message> alone, so Codemm's codes (codemm:repair and the rest) match as sent.
// Kept here, inline: a sandboxed preload can't load other modules.
const ENVELOPE = /^Error invoking remote method 'codemm': (?:\w*Error: )?/;

const bridge: Bridge = {
  invoke: (method, args) =>
    ipcRenderer.invoke('codemm', method, args).catch((e: unknown) => {
      throw new Error((e instanceof Error ? e.message : String(e)).replace(ENVELOPE, ''));
    }),
  // One-way: main sends check progress to the app window: the phase and counts, and a visible test's result.
  onCheckProgress: (listener) => {
    const text = (v: unknown) => (typeof v === 'string' ? { value: v } : undefined);
    const finished = (t: { name?: unknown; status?: unknown; message?: unknown; actual?: unknown } | undefined): FinishedTest | undefined => {
      if (!t || typeof t.name !== 'string' || (t.status !== 'pass' && t.status !== 'fail' && t.status !== 'error')) return undefined;
      const message = text(t.message);
      const actual = text(t.actual);
      return { name: t.name, status: t.status, ...(message ? { message: message.value } : {}), ...(actual ? { actual: actual.value } : {}) };
    };
    const forward = (_event: unknown, p: { run?: string; phase: 'building' | 'visible' | 'hidden'; done: number; total: number; test?: { name?: unknown; status?: unknown } }) => {
      const test = p.phase === 'visible' ? finished(p.test) : undefined;
      listener({ ...(typeof p.run === 'string' ? { run: p.run } : {}), phase: p.phase, done: p.done, total: p.total, ...(test ? { test } : {}) });
    };
    ipcRenderer.on('codemm:check-progress', forward);
    return () => void ipcRenderer.removeListener('codemm:check-progress', forward);
  },
  // One-way: main sends what research is looking at. Only a capped query, a host and path, or a step label.
  onResearchProgress: (listener) => {
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
    const forward = (_event: unknown, p: { kind?: unknown; query?: unknown; url?: unknown; label?: unknown }) => {
      if (p.kind === 'search') listener({ kind: 'search', query: text(p.query, 120) });
      else if (p.kind === 'read') listener({ kind: 'read', url: text(p.url, 200) });
      else if (p.kind === 'step') listener({ kind: 'step', label: text(p.label, 80) });
    };
    ipcRenderer.on('codemm:research-progress', forward);
    return () => void ipcRenderer.removeListener('codemm:research-progress', forward);
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
