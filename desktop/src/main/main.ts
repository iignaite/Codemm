import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CodemmApi } from '../shared/api';
import { createMock } from './mock';

const page = join(__dirname, '../renderer/index.html');
const pageUrl = pathToFileURL(page).href;

// Swap the mock for the Codemm core here. Nothing else changes.
const codemm: CodemmApi = createMock();

function handle(event: IpcMainInvokeEvent, method: unknown, args: unknown) {
  if (event.senderFrame?.url !== pageUrl) throw new Error('Unknown sender');
  if (typeof method !== 'string' || !Object.hasOwn(codemm, method) || !Array.isArray(args)) throw new Error('Unknown call');
  const call = codemm[method as keyof CodemmApi] as (...a: unknown[]) => Promise<unknown>;
  return call(...args);
}

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
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
