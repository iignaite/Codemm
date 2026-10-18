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

/** Runs a program and gives its stdout. */
type Exec = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;

/**
 * A distinguished name's parts by key, each with every value it has (a key may repeat, such as OU). Only plain names
 * are read: one with quotes, backslashes or multi-valued parts ("+") is null, so the update is refused rather than
 * matched on a guess at Windows' quoting. Codemm's own certificate has a plain name.
 */
function dn(name: string): Map<string, string[]> | null {
  if (/["\\+]/.test(name)) return null;
  const parts = new Map<string, string[]>();
  for (const part of name.split(',')) {
    const at = part.indexOf('=');
    if (at < 0) return null;
    const key = part.slice(0, at).trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]*$/.test(key)) return null;
    parts.set(key, [...(parts.get(key) ?? []), part.slice(at + 1).trim()]);
  }
  return parts;
}

/**
 * A publisher given by name matches a signer whose one CN is that name. One given as a full name matches when every
 * key it names appears once in the signer's name, with that value.
 */
function signedBy(subject: string, publisher: string): boolean {
  const signer = dn(subject);
  const once = (key: string, value: string) => signer?.get(key)?.length === 1 && signer.get(key)![0] === value;
  if (!publisher.includes('=')) return once('CN', publisher);
  const wanted = dn(publisher);
  return wanted !== null && [...wanted].every(([key, values]) => values.length === 1 && once(key, values[0]));
}

/**
 * The Windows update's signature check, in place of electron-updater's, which lets an update through when PowerShell
 * can't run. This one fails closed: only a valid Authenticode signature from an expected publisher passes; anything
 * else, a check that couldn't run included, returns why and stops the install. The file reaches PowerShell through
 * the environment, never inside the command.
 */
export async function verifyWindowsSignature(publisherNames: string[], file: string, exec: Exec): Promise<string | null> {
  if (publisherNames.length === 0) return 'The update has no publisher to check its signature against.';
  let out: string;
  try {
    out = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', 'Get-AuthenticodeSignature -LiteralPath $env:CODEMM_UPDATE_FILE | ConvertTo-Json -Compress'], { ...process.env, CODEMM_UPDATE_FILE: file });
  } catch (e) {
    return `The update's signature couldn't be checked: ${e instanceof Error ? e.message : String(e)}`;
  }
  let data: { Status?: unknown; SignerCertificate?: { Subject?: unknown } };
  try {
    data = JSON.parse(out);
  } catch {
    return "The update's signature couldn't be read.";
  }
  // 0 is Valid in System.Management.Automation.SignatureStatus.
  if (data?.Status !== 0) return `The update isn't validly signed (status ${String(data?.Status)}).`;
  const subject = typeof data.SignerCertificate?.Subject === 'string' ? data.SignerCertificate.Subject : '';
  if (!publisherNames.some((name) => signedBy(subject, name))) return `The update is signed by someone else: ${subject}`;
  return null;
}

const powershell: Exec = (file, args, env) =>
  new Promise((resolve, reject) => {
    const { execFile } = require('node:child_process') as typeof import('node:child_process');
    execFile(file, args, { env, timeout: 20_000, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

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
  // A signed Windows build checks each update's signature, and refuses it when the check can't run.
  if (process.platform === 'win32' && signed) {
    (autoUpdater as import('electron-updater').NsisUpdater).verifyUpdateCodeSignature = (names, file) => verifyWindowsSignature(names, file, powershell);
  }
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
