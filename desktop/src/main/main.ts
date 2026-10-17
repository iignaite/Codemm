import { app, BrowserWindow, ipcMain, net, protocol, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CodemmApi } from '../shared/api';
import { errorFields } from './errors';
import { handler } from './ipc';
import { openOutside } from './links';
import { createLog } from './log';
import { CSP, fileFor, fromAppWindow, ORIGIN } from './origin';
import { liveApi } from './wire';

const renderer = join(__dirname, '../renderer');

// The app's own origin (§2.1): registered before the app is ready.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);
/** The web contents of the app's windows: the only senders IPC answers. */
const appWindows = new Set<WebContents>();

// The real core and the learner's agent. In development only, CODEMM_MOCK=<scenario>
// runs the in-memory mock instead, to click through environment states (mock.ts).
// ~/Library/Logs/Codemm on macOS, %APPDATA%\Codemm\logs on Windows (HANDOFF.md).
// A separate profile (--user-data-dir) keeps its own log, so runs with one never write to the learner's.
if (app.commandLine.hasSwitch('user-data-dir')) app.setAppLogsPath(join(app.getPath('userData'), 'logs'));
const log = createLog(app.getPath('logs'));
log('start', { version: app.getVersion(), platform: process.platform, arch: process.arch, packaged: app.isPackaged });
process.on('uncaughtExceptionMonitor', (e) => log('error', { where: 'main', ...errorFields(e) }));
process.on('unhandledRejection', (e) => log('error', { where: 'main', ...errorFields(e) }));

const mock = !app.isPackaged && process.env.CODEMM_MOCK !== undefined;
const live = mock ? null : liveApi({ coreDir: app.isPackaged ? join(process.resourcesPath, 'core') : join(__dirname, '../core'), userData: app.getPath('userData'), log });
// The mock loads only in mock mode, so installers can leave it out.
const codemm: CodemmApi = live ?? devMock();

function devMock(): CodemmApi {
  const { createMock, scenario } = require('./mock') as typeof import('./mock');
  return createMock(scenario(process.env.CODEMM_MOCK || undefined));
}

// Only an app window's top frame, on app://codemm, may call Codemm (§2.1).
const handle = handler(codemm, log, (event: IpcMainInvokeEvent) => fromAppWindow(event, appWindows));

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
  const contents = win.webContents;
  appWindows.add(contents);
  win.on('closed', () => appWindows.delete(contents));
  void win.loadURL(`${ORIGIN}/index.html`);
}

// Every web contents: no navigation, no webviews, and no new windows. A link opens
// in the learner's browser, and only for https URLs (§2.1).
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(openOutside((url) => shell.openExternal(url)));
});

/** Serves the built renderer on app://codemm, under the spec's CSP, and nothing else. */
async function serve(request: Request): Promise<Response> {
  const file = fileFor(request.url, renderer);
  if (!file) return new Response('Not found', { status: 404 });
  const response = await net.fetch(pathToFileURL(file).toString());
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', CSP);
  return new Response(response.body, { status: response.status, headers });
}

void app.whenReady().then(() => {
  protocol.handle('app', serve);
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
