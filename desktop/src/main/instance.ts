// One Codemm per learner (DESIGN §2): a second launch hands over to the open Codemm, which shows its window, and
// quits before it starts any job, install or cleanup. One process then owns userData and the workspace's jobs.
import type { BrowserWindow } from 'electron';

/** Starts Codemm only in the first instance; a second one quits instead. */
export function startOnce(app: { requestSingleInstanceLock(): boolean; quit(): void }, start: () => void): void {
  if (app.requestSingleInstanceLock()) start();
  else app.quit();
}

/** Shows the learner's window for a second launch: restored when minimized, then in front. */
export function bringBack(win: Pick<BrowserWindow, 'isMinimized' | 'restore' | 'show' | 'focus'>): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
