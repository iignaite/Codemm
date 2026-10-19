import { app, BrowserWindow, ipcMain, net, protocol, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CodemmApi } from '../shared/api';
import { errorFields } from './errors';
import { secondLaunch } from './instance';
import { handler } from './ipc';
import { openOutside } from './links';
import { createLog } from './log';
import { CSP, fileFor, fromAppWindow, ORIGIN } from './origin';
import { bindRuns } from './runs';
import { electronUpdater, updates } from './updates';
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
// Auto-update (§7.2): in an installed app, on GitHub Releases. In development only, CODEMM_UPDATE_FEED points the
// check at a local feed instead, for tests; an installed app ignores it.
const feed = app.isPackaged ? undefined : process.env.CODEMM_UPDATE_FEED;
const updater = app.isPackaged || feed ? updates({ signed: signedBuild(), updater: electronUpdater(app.getVersion(), signedBuild(), feed), log, cleanup: () => shutdown(true) }) : undefined;
const codemm: CodemmApi = withUpdates(live ?? devMock());

/** Whether this build was signed: packaging.cjs records it in the packaged package.json. */
function signedBuild(): boolean {
  try {
    return (JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { codemm?: { signed?: unknown } }).codemm?.signed === true;
  } catch {
    return false;
  }
}

/** Main answers the update calls when it checks for updates. */
function withUpdates(api: CodemmApi): CodemmApi {
  if (!updater) return api;
  return { ...api, update: async () => updater.status(), restartToUpdate: async () => updater.restart() };
}

function devMock(): CodemmApi {
  const { createMock, scenario } = require('./mock') as typeof import('./mock');
  return createMock(scenario(process.env.CODEMM_MOCK || undefined));
}

// The events main sends, only to the app's windows (§2.1): check progress and every agent job's progress.
codemm.onCheckProgress((progress) => {
  for (const contents of appWindows) contents.send('codemm:check-progress', progress);
});
codemm.onJobProgress((progress) => {
  for (const contents of appWindows) contents.send('codemm:job-progress', progress);
});

// Only an app window's top frame, on app://codemm, may call Codemm (§2.1). A Run belongs to the window that
// started it: only that window hears it, types into it or stops it, and closing the window stops it (runs.ts).
const runs = bindRuns<WebContents>();
const handle = runs.wrap(handler(codemm, log, (event: IpcMainInvokeEvent) => fromAppWindow(event, appWindows)));
codemm.onRunOutput((output) => {
  const owner = runs.ownerOf(output.run);
  if (owner && !owner.isDestroyed()) owner.send('codemm:run-output', output);
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
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
  win.on('closed', () => {
    appWindows.delete(contents);
    for (const run of runs.runsOf(contents)) void codemm.stopRun(run).catch(() => undefined);
  });
  void win.loadURL(`${ORIGIN}/index.html`);
}

// A second launch quit before it started anything (boot.ts): the learner gets this Codemm's window instead, or, while
// this one quits, Codemm again once it has stopped (§2).
let relaunching = false;
app.on('second-instance', () =>
  secondLaunch({
    quitting: stopping !== undefined,
    updating,
    win: BrowserWindow.getAllWindows()[0],
    open: () => void (app.isReady() && createWindow()),
    relaunch: () => {
      if (!relaunching) app.relaunch();
      relaunching = true;
    },
  }),
);

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
  updater?.start();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quitting first stops running agent jobs with their whole process groups and removes leftover containers (§5).
// Every quit waits for that, however often the learner asks. Restart to update waits for it too, before the
// installer starts (updates.ts).
let stopping: Promise<void> | undefined;
let stopped = false;
/** The shutdown is Restart to update's: the installer opens Codemm again. */
let updating = false;
function shutdown(forUpdate = false): Promise<void> {
  updating ||= forUpdate;
  stopping ??= (live ? live.stop() : Promise.resolve()).catch(() => undefined).finally(() => {
    stopped = true;
  });
  return stopping;
}
app.on('before-quit', (event) => {
  if (!live || stopped) return;
  event.preventDefault();
  void shutdown().then(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
