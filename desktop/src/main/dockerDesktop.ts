// Installs and opens Docker Desktop for the learner (DESIGN §6.1). The installer comes only from Docker's own
// download host, over https, and runs only if Docker signed it. Codemm never accepts Docker's terms or asks for a
// password: Docker's own window does both. Every command is an argument array, never a shell.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdtempSync, rmSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DockerInstall } from '../shared/api';

export interface DesktopDeps {
  platform: NodeJS.Platform;
  arch: string;
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
  remove(path: string): void;
  now(): number;
}

export class OfflineError extends Error {}

const GiB = 1024 ** 3;
/** After Codemm opens or installs Docker, how long a silent Docker counts as starting (computer.ts uses the same). */
export const STARTING_MS = 3 * 60_000;
const MAC_APP = '/Applications/Docker.app';
/** Apple's checks by absolute path: a codesign or spctl earlier on PATH can't answer for them. */
const CODESIGN = '/usr/bin/codesign';
const SPCTL = '/usr/sbin/spctl';
/** Docker, Inc's Apple Developer team. */
const DOCKER_TEAM = /^TeamIdentifier=9BNSXJN65R$/m;
const WIN_DESKTOP = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
/** The path arrives as $env:CODEMM_FILE, so nothing outside this text is ever parsed as PowerShell. */
const SIGNATURE = '$s = Get-AuthenticodeSignature -LiteralPath $env:CODEMM_FILE; "$($s.Status)|$($s.SignerCertificate.Subject)"';
/** Windows installer exit codes that mean "restart to finish". */
const RESTART = new Set([3010, 1641]);

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

  const ok = (r: { code: number | null }) => r.code === 0;
  const quietly = (path: string) => {
    try {
      d.remove(path);
    } catch {
      // Leftovers in a temp folder are harmless; the OS clears it.
    }
  };

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
      if (!ok(await d.run('ditto', [app, path.join(staging, 'Docker.app')]))) throw new Stop('manual');
      // Someone else installed Docker meanwhile: keep theirs.
      if (!d.exists(MAC_APP) && !ok(await d.run('mv', [path.join(staging, 'Docker.app'), MAC_APP]))) throw new Stop('manual');
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
    if (!ok(await d.run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, dmg]))) throw new Stop('failed');
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
      await d.run('hdiutil', ['detach', mnt, '-quiet']);
      // Finder shows the download; the learner drags Docker to Applications, as Docker's own steps say.
      if (manual) await d.run('open', [dmg]);
    }
  }

  async function windows(dir: string) {
    const exe = path.join(dir, 'DockerDesktopInstaller.exe');
    await fetchTo(`https://desktop.docker.com/win/main/${chip}/Docker%20Desktop%20Installer.exe`, exe, dir, 8 * GiB);
    status = { phase: 'checking' };
    const signature = await d.run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', SIGNATURE], { env: { CODEMM_FILE: exe } });
    if (!ok(signature) || !dockerSigned(signature.output)) throw new Stop('unverified');
    status = { phase: 'installing' };
    // Its own window: Windows asks for permission, and the learner accepts Docker's terms there.
    const result = await d.run(exe, ['install'], { timeoutMs: 60 * 60_000 });
    if (result.code !== null && RESTART.has(result.code)) throw new Stop('restart');
    if (!ok(result)) throw new Stop('failed');
  }

  /** Opens Docker Desktop; rejects if it can't. */
  async function openApp(app: string) {
    if (d.platform === 'darwin') {
      if (!ok(await d.run('open', ['-a', app]))) throw new Stop('failed');
    } else if (d.platform === 'win32') {
      await d.launch(WIN_DESKTOP, []);
    }
    started = d.now();
  }

  async function installNow() {
    let dir: string | undefined;
    let keep = false;
    try {
      if (d.platform === 'darwin' && d.exists(MAC_APP)) {
        await openApp(MAC_APP);
      } else {
        dir = d.tempDir();
        if (d.platform === 'darwin') await mac(dir);
        else await windows(dir);
        await openApp(MAC_APP);
      }
      status = { phase: 'starting' };
    } catch (e) {
      const problem = e instanceof Stop ? e.problem : 'failed';
      keep = problem === 'manual';
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
    open: () => openApp('Docker'),
    /** When Codemm last opened or installed Docker: a Docker that doesn't answer yet is starting. */
    startedAt: () => started,
    /** The current install, for tests and quitting. */
    done: () => running,
  };
}

const NETWORK = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/;
const MAX_HOPS = 5;
/** Docker Desktop and the agents are well under 2 GB; anything bigger isn't them. */
const MAX_BYTES = 2 * GiB;
const DOWNLOAD_DEADLINE_MS = 45 * 60_000;

/** Docker's download host: every hop, redirects included, is https on docker.com. */
export const isDockerHost = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'docker.com' || u.hostname.endsWith('.docker.com'));
  } catch {
    return false;
  }
};

/** The real computer: Node's fetch, the disk, and argument-array processes. */
export function nodeDesktopDeps(): DesktopDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    tempDir: () => mkdtempSync(join(tmpdir(), 'codemm-docker-')),
    freeBytes: async (dir) => {
      const s = statfsSync(dir);
      return s.bavail * s.bsize;
    },
    async download(start, file, progress, allowed = isDockerHost, maxBytes = MAX_BYTES) {
      const signal = AbortSignal.timeout(DOWNLOAD_DEADLINE_MS);
      let url = start;
      let res: Response | undefined;
      // Each hop is checked before it's requested.
      for (let hop = 0; hop <= MAX_HOPS; hop++) {
        if (!allowed(url)) throw new Error('The download left the vendor’s site.');
        try {
          res = await fetch(url, { redirect: 'manual', signal });
        } catch (e) {
          const cause = (e as { cause?: { code?: string } }).cause?.code ?? '';
          throw NETWORK.test(cause) ? new OfflineError(cause) : e;
        }
        const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
        if (!next) break;
        url = new URL(next, url).toString();
        res = undefined;
      }
      if (!res) throw new Error('Too many redirects.');
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      if (total > maxBytes) throw new Error('The download is larger than expected.');
      let got = 0;
      const count = new Transform({
        transform(chunk: Buffer, _enc, done) {
          got += chunk.length;
          if (got > maxBytes) return done(new Error('The download is larger than expected.'));
          if (total) progress(Math.min(1, got / total));
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), count, createWriteStream(file), { signal });
      progress(1);
    },
    run: (file, args, opts) =>
      new Promise((resolve) => {
        const child = spawn(file, args, { env: { ...process.env, ...opts?.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
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
    remove: (path) => rmSync(path, { recursive: true, force: true }),
    now: () => Date.now(),
  };
}
