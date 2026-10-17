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
    const forward = (_event: unknown, p: { phase: 'building' | 'visible' | 'hidden'; done: number; total: number }) =>
      listener({ phase: p.phase, done: p.done, total: p.total });
    ipcRenderer.on('codemm:check-progress', forward);
    return () => void ipcRenderer.removeListener('codemm:check-progress', forward);
  },
};

contextBridge.exposeInMainWorld('codemm', bridge);
