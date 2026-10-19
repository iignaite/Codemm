// One Codemm per learner (DESIGN §2): a second launch hands over to the open Codemm, which shows its window, and
// quits before it starts any job, install or cleanup. One process then owns userData and the workspace's jobs.
import type { BrowserWindow } from 'electron';

type Win = Pick<BrowserWindow, 'isMinimized' | 'restore' | 'show' | 'focus'>;

/** Starts Codemm only in the first instance; a second one quits instead. */
export function startOnce(app: { requestSingleInstanceLock(): boolean; quit(): void }, start: () => void): void {
  if (app.requestSingleInstanceLock()) start();
  else app.quit();
}

/** Shows the learner's window for a second launch: restored when minimized, then in front. */
export function bringBack(win: Win): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * What a second launch gets: the open window back, or a new one when none is open. While Codemm quits, its windows
 * are about to close, so Codemm opens again once it has stopped, unless an update's installer opens it itself.
 */
export function secondLaunch(c: { quitting: boolean; updating: boolean; win?: Win; open(): void; relaunch(): void }): void {
  if (c.quitting) {
    if (!c.updating) c.relaunch();
  } else if (c.win) bringBack(c.win);
  else c.open();
}
