// The renderer's only door to the main process: one invoke call on one
// channel. The typed CodemmApi client is built on top of it in the renderer.
import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge } from '../shared/api';

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
};

contextBridge.exposeInMainWorld('codemm', bridge);
