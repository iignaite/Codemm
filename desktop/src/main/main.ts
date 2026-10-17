import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import type { CodemmApi } from '../shared/api';
import { errorFields } from './errors';
import { handler } from './ipc';
import { isSafeLink } from './links';
import { createLog } from './log';
import { createMock, scenario } from './mock';
import { liveApi } from './wire';

const page = join(__dirname, '../renderer/index.html');

// The real core and the learner's agent. In development only, CODEMM_MOCK=<scenario>
// runs the in-memory mock instead, to click through environment states (mock.ts).
// ~/Library/Logs/Codemm on macOS, %APPDATA%\Codemm\logs on Windows (HANDOFF.md).
const log = createLog(app.getPath('logs'));
log('start', { version: app.getVersion(), platform: process.platform, arch: process.arch, packaged: app.isPackaged });
process.on('uncaughtExceptionMonitor', (e) => log('error', { where: 'main', ...errorFields(e) }));
process.on('unhandledRejection', (e) => log('error', { where: 'main', ...errorFields(e) }));

const mock = !app.isPackaged && process.env.CODEMM_MOCK !== undefined;
const live = mock ? null : liveApi({ coreDir: app.isPackaged ? join(process.resourcesPath, 'core') : join(__dirname, '../core'), userData: app.getPath('userData'), log });
const codemm: CodemmApi = live ?? createMock(scenario(process.env.CODEMM_MOCK || undefined));

// Windows only ever show the app's own page (navigation and new windows are
// blocked), so accept calls from a main frame on a file URL and nothing else.
const handle = handler(codemm, log, (event: IpcMainInvokeEvent) => {
  const frame = event.senderFrame;
  return Boolean(frame && frame === event.sender.mainFrame && frame.url.startsWith('file:'));
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Codemm',
    backgroundColor: '#F5F7FA',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0B1F44', symbolColor: '#AFC0DD', height: 36 },
    trafficLightPosition: { x: 14, y: 11 },
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Links open in the learner's browser, and only to official install pages.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeLink(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  void win.loadFile(page);
}

void app.whenReady().then(() => {
  ipcMain.handle('codemm', handle);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quitting first stops running agent jobs with their whole process groups and removes leftover containers (§5).
// Every quit waits for that, however often the learner asks.
let stopping: Promise<void> | undefined;
let stopped = false;
app.on('before-quit', (event) => {
  if (!live || stopped) return;
  event.preventDefault();
  stopping ??= live
    .stop()
    .catch(() => undefined)
    .finally(() => {
      stopped = true;
      app.quit();
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
