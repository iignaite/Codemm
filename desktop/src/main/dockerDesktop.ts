// Installs and opens Docker Desktop for the learner (DESIGN §6.1), on a macOS or Windows that Docker supports. The
// installer comes only from Docker's own download host, over https, and runs only if Docker signed it. Codemm never
// accepts Docker's terms or types a password: Docker's own window and Windows' permission prompt do that. Every
// command is an argument array, never a shell.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statfsSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import type { DockerInstall } from '../shared/api';
import { downloader, OfflineError, type Get } from './download';
import { POWERSHELL } from './windows';

export interface DesktopDeps {
  platform: NodeJS.Platform;
  /** This computer's own chip (nativeArch), not the one this build of Codemm emulates. */
  arch: string;
  /** %ProgramFiles% and %LOCALAPPDATA% on Windows, where Docker Desktop installs for all users and for one. */
  programFiles?: string;
  localAppData?: string;
  /** The learner's home, whose ~/Applications can hold Docker.app on macOS. */
  home?: string;
  /** The OS temp folder, where tempDir() makes Codemm's download folders. */
  tempRoot: string;
  tempDir(): string;
  freeBytes(dir: string): Promise<number>;
  /**
   * Saves `url` to `file`, reporting 0 to 1, if every hop is on an `allowed` host (Docker's by default).
   * Rejects with OfflineError when this computer can't reach it.
   */
  download(url: string, file: string, progress: (fraction: number) => void, allowed?: (url: string) => boolean, maxBytes?: number): Promise<void>;
  /** Runs a program to its end, or until `timeoutMs` (then `code` is null). */
  run(file: string, args: string[], opts?: { env?: Record<string, string>; timeoutMs?: number }): Promise<{ code: number | null; output: string }>;
  /** Starts a program without waiting for it; rejects if it can't start. */
  launch(file: string, args: string[]): Promise<void>;
  exists(path: string): boolean;
  list(dir: string): string[];
  modifiedAt(path: string): number;
  remove(path: string): void;
  now(): number;
}

const GiB = 1024 ** 3;
/** After Codemm opens or installs Docker, how long a silent Docker counts as starting (computer.ts uses the same). */
export const STARTING_MS = 3 * 60_000;
const MAC_APP = '/Applications/Docker.app';
/** Apple's own tools by absolute path: one earlier on PATH can't stand in for them. */
const CODESIGN = '/usr/bin/codesign';
const SPCTL = '/usr/sbin/spctl';
const HDIUTIL = '/usr/bin/hdiutil';
const DITTO = '/usr/bin/ditto';
const MV = '/bin/mv';
const OPEN = '/usr/bin/open';
const RM = '/bin/rm';
const PGREP = '/usr/bin/pgrep';
const TASKLIST = 'C:\\Windows\\System32\\tasklist.exe';
const SW_VERS = '/usr/bin/sw_vers';
const REG = 'C:\\Windows\\System32\\reg.exe';
/** Explorer opens a Settings page by its URI, started as a program with no shell. */
const EXPLORER = 'C:\\Windows\\explorer.exe';
const WINDOWS_UPDATE = 'ms-settings:windowsupdate';
/** Docker, Inc's Apple Developer team. */
const DOCKER_TEAM = /^TeamIdentifier=9BNSXJN65R$/m;
/** Where Docker Desktop installs for all users (Codemm's install), and for one user (Docker's own default). */
const WIN_DESKTOP = 'Docker\\Docker\\Docker Desktop.exe';
const WIN_USER_DESKTOP = 'Programs\\DockerDesktop\\Docker Desktop.exe';
/**
 * Codemm's own folders an install can leave behind: a staging folder in Applications (placeApp), and a download
 * folder in the temp folder (tempDir) that a failed or declined install kept. How old one is before it counts as left.
 */
const STAGING = /^\.codemm-docker-[0-9a-f]{8}$/;
const DOWNLOAD = /^codemm-docker-[A-Za-z0-9]{6}$/;
const STALE_MS = 60 * 60_000;
/** The path arrives as $env:CODEMM_FILE, so nothing outside this text is ever parsed as PowerShell. */
const SIGNATURE = '$s = Get-AuthenticodeSignature -LiteralPath $env:CODEMM_FILE; "$($s.Status)|$($s.SignerCertificate.Subject)"';
/**
 * Docker's installer as administrator, in its own window: Windows asks the learner first. The path arrives as
 * $env:CODEMM_FILE, and the installer's own exit code comes back. A learner who says no ends it with DECLINED.
 * .NET's Process.Start keeps Windows' error as the inner exception, which Start-Process drops, and the wait is for
 * the installer alone, not every process it leaves running.
 */
export const ELEVATED =
  "$i = New-Object Diagnostics.ProcessStartInfo $env:CODEMM_FILE, 'install'; $i.Verb = 'runas'; $i.UseShellExecute = $true; " +
  'try { $p = [Diagnostics.Process]::Start($i) } catch { $e = $_.Exception; while ($e) { if ($e.NativeErrorCode -eq 1223) { exit 1223 }; $e = $e.InnerException }; exit 1 }; ' +
  'if (-not $p) { exit 1 }; $p.WaitForExit(); exit $p.ExitCode';
/** ERROR_CANCELLED: the learner said no to Windows' permission prompt. */
const DECLINED = 1223;
/** Windows installer exit codes that mean "restart to finish". */
const RESTART = new Set([3010, 1641]);

/** Docker Desktop's documented minimums (release notes 4.49 and 4.48): macOS 14; Windows 10 22H2 or Windows 11 23H2. */
const MACOS_MIN = 14;
const WIN10_MIN = 19045;
const WIN11 = 22000;
const WIN11_MIN = 22631;

/**
 * Why this computer can't run Docker Desktop, from `sw_vers -productVersion` or Windows' CurrentVersion key; nothing
 * when it can, or when the answer can't be read (Docker's own installer has the last word then). It never runs on
 * Windows Server.
 */
export function systemProblem(platform: NodeJS.Platform, output: string): DockerInstall['problem'] {
  if (platform === 'darwin') {
    const major = Number(/^(\d+)\./m.exec(output)?.[1]);
    return major < MACOS_MIN ? 'macos-version' : undefined;
  }
  const build = Number(/^\s*CurrentBuildNumber\s+REG_SZ\s+(\d+)/m.exec(output)?.[1]);
  if (/^\s*InstallationType\s+REG_SZ\s+Server/m.test(output)) return 'windows-server';
  if (!build) return undefined;
  return build >= WIN11_MIN || (build >= WIN10_MIN && build < WIN11) ? undefined : 'windows-version';
}

/** The chip to download for: an x64 build under Rosetta, or under Windows' x64 emulation on Arm, runs on arm64. */
export const nativeArch = (arch: string, translated: boolean) => (translated ? 'arm64' : arch);

/** Signed, valid, and the signer's organization attribute is exactly Docker Inc. */
export function dockerSigned(output: string): boolean {
  const [status, subject = ''] = output.trim().split('|', 2);
  if (status !== 'Valid') return false;
  // A distinguished name: comma-separated attributes, values possibly quoted.
  const attributes = subject.match(/(?:[^,"]|"[^"]*")+/g)?.map((a) => a.trim()) ?? [];
  return attributes.some((a) => a === 'O=Docker Inc' || a === 'O="Docker Inc"');
}

class Stop extends Error {
  constructor(readonly problem: NonNullable<DockerInstall['problem']>) {
    super(problem);
  }
}

export function dockerDesktop(d: DesktopDeps) {
  const canInstall = d.platform === 'darwin' || d.platform === 'win32';
  // The target's own paths, whichever computer runs this (tests run both on every host).
  const path = d.platform === 'win32' ? win32 : posix;
  const chip = d.arch === 'arm64' ? 'arm64' : 'amd64';
  let status: DockerInstall | undefined;
  let running: Promise<void> = Promise.resolve();
  let busy = false;
  let started: number | undefined;
  /** The folder of a checked installer the learner said no to running: Try again runs it, checked again, without downloading it twice. */
  let declined: string | undefined;

  const ok = (r: { code: number | null }) => r.code === 0;
  const desktops =
    d.platform === 'darwin' ? [MAC_APP, ...(d.home ? [posix.join(d.home, 'Applications', 'Docker.app')] : [])]
    : d.platform === 'win32' ? [win32.join(d.programFiles ?? 'C:\\Program Files', WIN_DESKTOP), ...(d.localAppData ? [win32.join(d.localAppData, WIN_USER_DESKTOP)] : [])]
    : [];
  const quietly = (path: string) => {
    try {
      d.remove(path);
    } catch {
      // Leftovers in a temp folder are harmless; the OS clears it.
    }
  };

  /** Docker's documented minimum, checked before anything downloads. */
  async function assertSupported() {
    const r = d.platform === 'darwin' ? await d.run(SW_VERS, ['-productVersion']) : await d.run(REG, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion']);
    const problem = ok(r) ? systemProblem(d.platform, r.output) : undefined;
    if (problem) throw new Stop(problem);
  }

  async function fetchTo(url: string, file: string, dir: string, needBytes: number) {
    if ((await d.freeBytes(dir)) < needBytes) throw new Stop('disk');
    status = { phase: 'downloading', progress: 0 };
    try {
      await d.download(url, file, (progress) => (status = { phase: 'downloading', progress }));
    } catch (e) {
      throw new Stop(e instanceof OfflineError ? 'offline' : 'failed');
    }
  }

  /** Copies into a staging folder on the same disk, then moves it in place: a failed copy never leaves a broken Docker. */
  async function placeApp(app: string) {
    const staging = `/Applications/.codemm-docker-${randomBytes(4).toString('hex')}`;
    try {
      if (!ok(await d.run(DITTO, [app, path.join(staging, 'Docker.app')]))) throw new Stop('manual');
      // Someone else installed Docker meanwhile: keep theirs.
      if (!d.exists(MAC_APP) && !ok(await d.run(MV, [path.join(staging, 'Docker.app'), MAC_APP]))) throw new Stop('manual');
    } finally {
      quietly(staging);
    }
  }

  async function mac(dir: string) {
    const dmg = path.join(dir, 'Docker.dmg');
    const mnt = path.join(dir, 'mnt');
    const app = path.join(mnt, 'Docker.app');
    await fetchTo(`https://desktop.docker.com/mac/main/${chip}/Docker.dmg`, dmg, dir, 4 * GiB);
    status = { phase: 'checking' };
    if (!ok(await d.run(HDIUTIL, ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, dmg]))) throw new Stop('failed');
    let manual = false;
    try {
      const signed =
        ok(await d.run(CODESIGN, ['--verify', '--deep', '--strict', app])) &&
        DOCKER_TEAM.test((await d.run(CODESIGN, ['-dv', '--verbose=2', app])).output) &&
        ok(await d.run(SPCTL, ['--assess', '--type', 'execute', app]));
      if (!signed) throw new Stop('unverified');
      status = { phase: 'installing' };
      await placeApp(app);
    } catch (e) {
      manual = e instanceof Stop && e.problem === 'manual';
      throw e;
    } finally {
      await d.run(HDIUTIL, ['detach', mnt, '-quiet']);
      // Finder shows the download; the learner drags Docker to Applications, as Docker's own steps say.
      if (manual) await d.run(OPEN, [dmg]);
    }
  }

  async function windows(dir: string) {
    const exe = path.join(dir, 'DockerDesktopInstaller.exe');
    if (!d.exists(exe)) await fetchTo(`https://desktop.docker.com/win/main/${chip}/Docker%20Desktop%20Installer.exe`, exe, dir, 8 * GiB);
    status = { phase: 'checking' };
    const signature = await d.run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', SIGNATURE], { env: { CODEMM_FILE: exe } });
    if (!ok(signature) || !dockerSigned(signature.output)) throw new Stop('unverified');
    status = { phase: 'installing' };
    // Its own window, as administrator: Windows asks for permission, and the learner accepts Docker's terms there.
    const result = await d.run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', ELEVATED], { env: { CODEMM_FILE: exe }, timeoutMs: 60 * 60_000 });
    if (result.code === DECLINED) throw new Stop('declined');
    if (result.code !== null && RESTART.has(result.code)) throw new Stop('restart');
    if (!ok(result)) throw new Stop('failed');
  }

  /** Opens Docker Desktop; rejects if it can't. */
  async function openApp(app: string) {
    if (d.platform === 'darwin') {
      if (!ok(await d.run(OPEN, ['-a', app]))) throw new Stop('failed');
    } else if (d.platform === 'win32') {
      await d.launch(desktops.find((p) => d.exists(p)) ?? desktops[0], []);
    }
    started = d.now();
  }

  async function installNow() {
    let dir: string | undefined;
    let keep = false;
    try {
      // A Mac's Docker, in Applications or ~/Applications, opens instead of installing again.
      const app = d.platform === 'darwin' ? desktops.find((p) => d.exists(p)) : undefined;
      if (app) {
        await openApp(app);
      } else {
        await assertSupported();
        dir = declined ?? d.tempDir();
        declined = undefined;
        if (d.platform === 'darwin') await mac(dir);
        else await windows(dir);
        await openApp(MAC_APP);
      }
      status = { phase: 'starting' };
    } catch (e) {
      const problem = e instanceof Stop ? e.problem : 'failed';
      keep = problem === 'manual' || problem === 'declined';
      if (problem === 'declined') declined = dir;
      status = { phase: 'failed', problem };
    } finally {
      if (dir && !keep) quietly(dir);
    }
  }

  return {
    canInstall,
    /** Starts an install unless one is running. Follow it with status(). */
    install() {
      if (!canInstall || busy) return;
      busy = true;
      // Feedback at once: the disk check and the first bytes take a moment.
      status = { phase: 'downloading', progress: 0 };
      running = installNow().finally(() => (busy = false));
    },
    /** The install, until Docker has had its startup window: after that, Check this computer speaks for Docker. */
    status: () => (status?.phase === 'starting' && started !== undefined && d.now() - started > STARTING_MS ? undefined : status),
    open: () => openApp(desktops.find((p) => d.exists(p)) ?? 'Docker'),
    /** Windows Update, where a Windows too old for Docker Desktop is updated. */
    windowsUpdate: () => (d.platform === 'win32' ? d.launch(EXPLORER, [WINDOWS_UPDATE]) : Promise.resolve()),
    /** Docker Desktop's own app is here: a docker command alone (Homebrew's, say) isn't Docker Desktop. */
    installed: () => desktops.some((p) => d.exists(p)),
    /** Docker Desktop's app is running, opened by Codemm or the learner, whether or not its engine answers yet. */
    async running() {
      // An unanchored pattern: it matches ~/Applications/Docker.app too.
      if (d.platform === 'darwin') return ok(await d.run(PGREP, ['-f', '/Applications/Docker.app/']));
      if (d.platform === 'win32') return /"Docker Desktop\.exe"/i.test((await d.run(TASKLIST, ['/FI', 'IMAGENAME eq Docker Desktop.exe', '/NH', '/FO', 'CSV'])).output);
      return false;
    },
    /**
     * Removes what an install left when it failed, was declined, or Codemm quit midway: only Codemm's own folders, over
     * an hour old (a younger one may be another Codemm's install). A Mac's staging copy of Docker is about 2 GB, so rm
     * removes it, not the app's own process.
     */
    async removeLeftovers() {
      const left = (dir: string, name: RegExp) => {
        try {
          return d.list(dir).filter((n) => name.test(n)).map((n) => path.join(dir, n)).filter((p) => d.now() - d.modifiedAt(p) > STALE_MS);
        } catch {
          // Can't be read: nothing of Codemm's can be found there either.
          return [];
        }
      };
      for (const download of left(d.tempRoot, DOWNLOAD)) quietly(download);
      if (d.platform !== 'darwin') return;
      for (const staging of left('/Applications', STAGING)) await d.run(RM, ['-rf', staging]);
    },
    /** When Codemm last opened or installed Docker: a Docker that doesn't answer yet is starting. */
    startedAt: () => started,
    /** The current install, for tests and quitting. */
    done: () => running,
  };
}

/** Docker's download host: every hop, redirects included, is https on docker.com. */
export const isDockerHost = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'docker.com' || u.hostname.endsWith('.docker.com'));
  } catch {
    return false;
  }
};

/** The network to download through: Electron's in the app (electronGet), and this computer's own chip (nativeArch). */
export interface Network {
  get: Get;
  arch: string;
}

/** The real computer: the network given, the disk, and argument-array processes. */
export function nodeDesktopDeps({ get, arch }: Network): DesktopDeps {
  const download = downloader(get);
  return {
    platform: process.platform,
    arch,
    programFiles: process.env.ProgramFiles,
    localAppData: process.env.LOCALAPPDATA,
    home: homedir(),
    tempRoot: tmpdir(),
    tempDir: () => mkdtempSync(join(tmpdir(), 'codemm-docker-')),
    freeBytes: async (dir) => {
      const s = statfsSync(dir);
      return s.bavail * s.bsize;
    },
    download: (url, file, progress, allowed = isDockerHost, maxBytes) => download(url, file, progress, allowed, maxBytes),
    run: (file, args, opts) =>
      new Promise((resolve) => {
        // No console window: what needs a window (Docker's installer) gets its own through PowerShell.
        const child = spawn(file, args, { env: { ...process.env, ...opts?.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let output = '';
        let settled = false;
        const finish = (code: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code, output });
        };
        const keep = (b: Buffer) => (output = (output + b.toString()).slice(-65_536));
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        // A timeout is a failure at once, even if the program ignores being stopped.
        const timer = setTimeout(() => {
          child.kill();
          finish(null);
        }, opts?.timeoutMs ?? 120_000);
        child.on('error', () => finish(null));
        child.on('close', (code) => finish(code));
      }),
    launch: (file, args) =>
      new Promise((resolve, reject) => {
        const child = spawn(file, args, { detached: true, stdio: 'ignore' });
        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      }),
    exists: existsSync,
    list: (dir) => readdirSync(dir),
    modifiedAt: (path) => statSync(path).mtimeMs,
    remove: (path) => rmSync(path, { recursive: true, force: true }),
    now: () => Date.now(),
  };
}
