import { ipcMain, type WebContents } from 'electron';
import { API_METHODS, CHANGED_CHANNEL, channel, type CodemmApi } from '../shared/api';

/** Serves CodemmApi to one window. Calls from any other sender are refused. */
export function serve(api: CodemmApi, contents: WebContents): () => void {
  for (const m of API_METHODS) {
    ipcMain.handle(channel(m), (event, ...args: unknown[]) => {
      if (event.sender !== contents) throw new Error('Unknown sender');
      return (api[m] as (...a: unknown[]) => Promise<unknown>)(...args);
    });
  }
  const off = api.onChange(() => contents.send(CHANGED_CHANNEL));
  return () => {
    off();
    for (const m of API_METHODS) ipcMain.removeHandler(channel(m));
  };
}
