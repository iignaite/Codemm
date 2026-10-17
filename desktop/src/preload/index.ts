// The typed bridge: exposes CodemmApi to the renderer and nothing else.
import { contextBridge, ipcRenderer } from 'electron';
import { API_METHODS, CHANGED_CHANNEL, channel, type CodemmApi } from '../shared/api';

const api = Object.fromEntries(
  API_METHODS.map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke(channel(m), ...args)]),
) as Omit<CodemmApi, 'onChange'>;

const bridge: CodemmApi = {
  ...api,
  onChange(listener) {
    const handler = () => listener();
    ipcRenderer.on(CHANGED_CHANNEL, handler);
    return () => ipcRenderer.removeListener(CHANGED_CHANNEL, handler);
  },
};

contextBridge.exposeInMainWorld('codemm', bridge);
