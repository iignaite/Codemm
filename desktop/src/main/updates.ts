// Auto-update (DESIGN §7.2), on GitHub Releases through electron-updater. Checked at start and every 6 hours. A signed
// build downloads a new version in the background and offers Restart to update. An unsigned build can't install
// one (macOS refuses an unsigned update), so it only says a new version is out, with a link to its Releases page.
// A prerelease build sees prereleases; a stable build sees stable releases only.
import type { UpdateStatus } from '../shared/api';
import type { Log } from './log';

/** What Codemm needs from electron-updater: a check that finds a newer version or none, a download, an install. */
export interface Updater {
  check(): Promise<{ version: string } | null>;
  download(): Promise<void>;
  install(): void;
}

const EVERY_MS = 6 * 60 * 60 * 1000;
const RELEASES = 'https://github.com/iignaite/Codemm/releases/tag/v';
/** A version as releases are tagged: only then does it go into a link. */
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$/;

export const isPrerelease = (version: string) => version.includes('-');

/**
 * `cleanup` runs before an install: the installer may end the app the moment it starts, so Codemm's jobs and
 * containers are stopped first, the same way quitting stops them.
 */
export function updates({ signed, updater, log = () => undefined, cleanup = async () => undefined }: { signed: boolean; updater: Updater; log?: Log; cleanup?: () => Promise<void> }) {
  let status: UpdateStatus = { kind: 'none' };
  let timer: ReturnType<typeof setInterval> | undefined;

  async function check() {
    if (status.kind === 'downloading' || status.kind === 'ready') return;
    try {
      const found = await updater.check();
      if (!found || !VERSION.test(found.version)) return;
      if (!signed) {
        status = { kind: 'available', version: found.version, url: `${RELEASES}${found.version}` };
        return;
      }
      status = { kind: 'downloading', version: found.version };
      await updater.download();
      status = { kind: 'ready', version: found.version };
    } catch (e) {
      log('update-error', { message: e instanceof Error ? e.message : String(e) });
      if (status.kind === 'downloading') status = { kind: 'none' };
    }
  }

  return {
    start() {
      void check();
      timer = setInterval(() => void check(), EVERY_MS);
    },
    stop: () => clearInterval(timer),
    status: () => status,
    /** Stops Codemm's work, then quits and installs the downloaded version. Only a signed, finished download. */
    async restart() {
      if (status.kind !== 'ready') return;
      await cleanup();
      updater.install();
    },
  };
}

/**
 * Starts a download and settles when it's ready to install: when `doneOn` emits `update-downloaded`. On macOS that's
 * Electron's own autoUpdater, after Squirrel.Mac fetched the update and checked its signature; electron-updater's
 * event comes earlier, when it hands the update over. Until then, an `error` on `errorsOn` (electron-updater, which
 * passes Squirrel's errors on) fails the download.
 */
export function downloaded(doneOn: Pick<NodeJS.EventEmitter, 'once' | 'off'>, errorsOn: Pick<NodeJS.EventEmitter, 'once' | 'off'>, start: () => Promise<unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => (stop(), resolve());
    const failed = (e: unknown) => (stop(), reject(e));
    const stop = () => {
      doneOn.off('update-downloaded', done);
      errorsOn.off('error', failed);
    };
    doneOn.once('update-downloaded', done);
    errorsOn.once('error', failed);
    start().catch(failed);
  });
}

/**
 * electron-updater, set up for this build. It never downloads on its own: `updates` decides. `feed` replaces the
 * GitHub feed with a generic one, for tests against a local server.
 */
export function electronUpdater(current: string, signed: boolean, feed?: string): Updater {
  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = signed;
  autoUpdater.allowPrerelease = isPrerelease(current);
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = null;
  if (feed) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: 'generic', url: feed });
  }
  return {
    async check() {
      const result = await autoUpdater.checkForUpdates();
      return result?.isUpdateAvailable ? { version: result.updateInfo.version } : null;
    },
    download: () => downloaded(process.platform === 'darwin' ? (require('electron') as typeof import('electron')).autoUpdater : autoUpdater, autoUpdater, () => autoUpdater.downloadUpdate()),
    install: () => autoUpdater.quitAndInstall(),
  };
}
