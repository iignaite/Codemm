// The renderer's only door to the main process: one invoke call on one
// channel. The typed CodemmApi client is built on top of it in the renderer.
import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge } from '../shared/api';

const bridge: Bridge = {
  invoke: (method, args) => ipcRenderer.invoke('codemm', method, args),
};

contextBridge.exposeInMainWorld('codemm', bridge);
