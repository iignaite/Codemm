// @vitest-environment node
import { release, version } from 'node:os';
import { describe, expect, it } from 'vitest';
import { dockerDesktop, nativeArch, nodeDesktopDeps, systemProblem, type DesktopDeps } from './dockerDesktop';
import type { WslState } from './wsl';
import { fetchGet, OfflineError } from './download';

const GiB = 1024 ** 3;
const DOCKER_TEAM = 'TeamIdentifier=9BNSXJN65R';
const WIN_TMP = 'C:\\Temp\\codemm-docker';
const WIN_EXE = 'C:\\Temp\\codemm-docker\\DockerDesktopInstaller.exe';
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const REG = 'C:\\Windows\\System32\\reg.exe';
/** Windows' own record of its version, as `reg query` prints it. */
const windowsInfo = (build: number, type = 'Client') =>
  `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\r\n    CurrentBuild    REG_SZ    ${build}\r\n    CurrentBuildNumber    REG_SZ    ${build}\r\n    EditionID    REG_SZ    Core\r\n    InstallationType    REG_SZ    ${type}\r\n    ProductName    REG_SZ    Windows 10 Home\r\n`;
/** Docker's per-user install, unelevated and with no window of its own (DESIGN §6.1). */
const INSTALL_KEY = `${WIN_EXE} install --user --quiet --backend=wsl-2`;

type Call = { file: string; args: string[]; env?: Record<string, string> };
type WslSetUp = () => Promise<'done' | 'restart' | 'declined' | 'failed'>;

function fake(
  platform: NodeJS.Platform,
  over: Partial<DesktopDeps> & { answers?: Record<string, { code: number | null; output: string }>; wsl?: { state: WslState; setUp: Awaited<ReturnType<WslSetUp>> } } = {},
) {
  const calls: Call[] = [];
  const launched: Call[] = [];
  const removed: string[] = [];
  const downloads: { url: string; file: string }[] = [];
  let clock = 1_000;
  const answer = (file: string, args: string[]) => {
    const key = [file, ...args].join(' ');
    for (const [prefix, value] of Object.entries(over.answers ?? {})) if (key.startsWith(prefix)) return value;
    if (file === '/usr/bin/codesign' && args[0] === '-dv') return { code: 0, output: `Executable=/x\n${DOCKER_TEAM}\n` };
    if (file === '/usr/bin/sw_vers') return { code: 0, output: '15.5\n' };
    if (file === REG) return { code: 0, output: windowsInfo(22631) };
    if (file.endsWith('powershell.exe')) return { code: 0, output: 'Valid|CN=Docker Inc, O=Docker Inc, L=Palo Alto, S=California, C=US\n' };
    return { code: 0, output: '' };
  };
  const deps: DesktopDeps = {
    platform,
    arch: 'arm64',
    tempDir: () => '/tmp/codemm-docker',
    freeBytes: async () => 50 * GiB,
    download: async (url, file, progress) => {
      downloads.push({ url, file });
      progress(0.5);
      progress(1);
    },
    run: async (file, args, opts) => {
      calls.push({ file, args, ...(opts?.env ? { env: opts.env } : {}) });
      return answer(file, args);
    },
    launch: async (file, args) => void launched.push({ file, args }),
    exists: () => false,
    list: () => [],
    modifiedAt: () => 0,
    tempRoot: '/tmp',
    remove: (path) => void removed.push(path),
    now: () => clock,
    ...over,
  };
  const setUps: string[] = [];
  /** The phase shown while WSL's setup runs. */
  const phases: (string | undefined)[] = [];
  const status = () => desktop.status();
  const wsl = over.wsl && {
    state: async () => over.wsl!.state,
    setUp: async (asking?: () => void) => {
      setUps.push(over.wsl!.state);
      if (over.wsl!.state === 'missing' || over.wsl!.state === 'old') asking?.();
      phases.push(status()?.phase);
      return over.wsl!.setUp;
    },
  };
  const desktop = dockerDesktop(deps, wsl);
  return { desktop, calls, launched, removed, downloads, setUps, phases, tick: (ms: number) => (clock += ms) };
}

const commands = (calls: Call[]) => calls.map((c) => [c.file, ...c.args].join(' '));

describe('installing Docker Desktop for the learner (§6.1)', () => {
  it('on a Mac: downloads the official image for this chip, checks it is signed by Docker, installs and opens it', async () => {
    const f = fake('darwin');
    expect(f.desktop.canInstall).toBe(true);
    f.desktop.install();
    expect(f.desktop.status()?.phase).toBeDefined();
    await f.desktop.done();
    expect(f.downloads).toEqual([{ url: 'https://desktop.docker.com/mac/main/arm64/Docker.dmg', file: '/tmp/codemm-docker/Docker.dmg' }]);
    expect(commands(f.calls)).toEqual([
      // Docker Desktop runs on this macOS: checked before anything downloads.
      '/usr/bin/sw_vers -productVersion',
      '/usr/bin/hdiutil attach -nobrowse -readonly -noautoopen -mountpoint /tmp/codemm-docker/mnt /tmp/codemm-docker/Docker.dmg',
      // Apple's own tools by absolute path: one earlier on PATH can't stand in for them.
      '/usr/bin/codesign --verify --deep --strict /tmp/codemm-docker/mnt/Docker.app',
      '/usr/bin/codesign -dv --verbose=2 /tmp/codemm-docker/mnt/Docker.app',
      '/usr/sbin/spctl --assess --type execute /tmp/codemm-docker/mnt/Docker.app',
      expect.stringMatching(/^\/usr\/bin\/ditto \/tmp\/codemm-docker\/mnt\/Docker\.app \/Applications\/\.codemm-docker-\w+\/Docker\.app$/),
      expect.stringMatching(/^\/bin\/mv \/Applications\/\.codemm-docker-\w+\/Docker\.app \/Applications\/Docker\.app$/),
      '/usr/bin/hdiutil detach /tmp/codemm-docker/mnt -quiet',
      '/usr/bin/open -a /Applications/Docker.app',
    ]);
    expect(f.removed).toEqual([expect.stringMatching(/^\/Applications\/\.codemm-docker-\w+$/), '/tmp/codemm-docker']);
    expect(f.desktop.status()).toEqual({ phase: 'starting' });
    expect(f.desktop.startedAt()).toBe(1_000);
  });

  it('picks the Intel image on an Intel Mac', async () => {
    const f = fake('darwin', { arch: 'x64' });
    f.desktop.install();
    await f.desktop.done();
    expect(f.downloads[0].url).toBe('https://desktop.docker.com/mac/main/amd64/Docker.dmg');
  });

  it('never installs an app that is not signed by Docker: it says so and deletes the download', async () => {
    const f = fake('darwin', { answers: { '/usr/bin/codesign -dv': { code: 0, output: 'TeamIdentifier=SOMEONEELSE\n' } } });
    f.desktop.install();
    await f.desktop.done();
    expect(commands(f.calls).some((c) => c.startsWith('/usr/bin/ditto'))).toBe(false);
    expect(commands(f.calls)).toContain('/usr/bin/hdiutil detach /tmp/codemm-docker/mnt -quiet');
    expect(f.removed).toEqual(['/tmp/codemm-docker']);
    expect(f.desktop.status()).toEqual({ phase: 'failed', problem: 'unverified' });
  });

  it('refuses a broken signature or one macOS does not accept', async () => {
    for (const bad of ['/usr/bin/codesign --verify', '/usr/sbin/spctl']) {
      const f = fake('darwin', { answers: { [bad]: { code: 3, output: 'invalid' } } });
      f.desktop.install();
      await f.desktop.done();
      expect(commands(f.calls).some((c) => c.startsWith('/usr/bin/ditto'))).toBe(false);
      expect(f.desktop.status()).toEqual({ phase: 'failed', problem: 'unverified' });
    }
  });

  it('when it cannot copy into Applications, opens the download for the learner to drag, and keeps it', async () => {
    const f = fake('darwin', { answers: { '/usr/bin/ditto': { code: 1, output: 'Permission denied' } } });
    f.desktop.install();
    await f.desktop.done();
    expect(commands(f.calls).slice(-2)).toEqual(['/usr/bin/hdiutil detach /tmp/codemm-docker/mnt -quiet', '/usr/bin/open /tmp/codemm-docker/Docker.dmg']);
    // The partial copy goes; the download stays for the learner.
    expect(f.removed).toEqual([expect.stringMatching(/^\/Applications\/\.codemm-docker-\w+$/)]);
    expect(f.desktop.status()).toEqual({ phase: 'failed', problem: 'manual' });
  });

  it('opens Docker already in Applications instead of downloading it again', async () => {
    const f = fake('darwin', { exists: (p) => p === '/Applications/Docker.app' });
    f.desktop.install();
    await f.desktop.done();
    expect(f.downloads).toEqual([]);
    expect(commands(f.calls)).toEqual(['/usr/bin/open -a /Applications/Docker.app']);
    expect(f.desktop.status()).toEqual({ phase: 'starting' });
  });

  it('opens Docker already in ~/Applications instead of downloading it again', async () => {
    const f = fake('darwin', { home: '/Users/me', exists: (p) => p === '/Users/me/Applications/Docker.app' });
    f.desktop.install();
    await f.desktop.done();
    expect(f.downloads).toEqual([]);
    expect(commands(f.calls)).toEqual(['/usr/bin/open -a /Users/me/Applications/Docker.app']);
  });

  it('checks the disk before downloading, and says when this computer is offline', async () => {
    const low = fake('darwin', { freeBytes: async () => 2 * GiB });
    low.desktop.install();
    await low.desktop.done();
    expect(low.downloads).toEqual([]);
    expect(low.desktop.status()).toEqual({ phase: 'failed', problem: 'disk' });

    const offline = fake('darwin', { download: async () => Promise.reject(new OfflineError('getaddrinfo ENOTFOUND desktop.docker.com')) });
    offline.desktop.install();
    await offline.desktop.done();
    expect(offline.desktop.status()).toEqual({ phase: 'failed', problem: 'offline' });
    expect(offline.removed).toEqual(['/tmp/codemm-docker']);
  });

  it('reports download progress, then each step', async () => {
    const seen: string[] = [];
    let f!: ReturnType<typeof fake>;
    f = fake('darwin', {
      download: async (_url, _file, progress) => {
        progress(0.25);
        seen.push(JSON.stringify(f.desktop.status()));
      },
    });
    f.desktop.install();
    await f.desktop.done();
    expect(seen).toEqual([JSON.stringify({ phase: 'downloading', progress: 0.25 })]);
  });

  it("on Windows: downloads the installer, checks Docker signed it, installs it for this learner with no prompt or window, then starts Docker", async () => {
    const perUser = 'C:\\Users\\me\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe';
    // Docker Desktop is there once its installer ran.
    const ran = () => commands(f.calls).includes(INSTALL_KEY);
    const f = fake('win32', { arch: 'x64', tempDir: () => WIN_TMP, localAppData: 'C:\\Users\\me\\AppData\\Local', exists: (p) => p === perUser && ran(), wsl: { state: 'ready', setUp: 'done' } });
    f.desktop.install();
    await f.desktop.done();
    expect(f.downloads).toEqual([{ url: 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe', file: WIN_EXE }]);
    // This Windows runs Docker Desktop: checked before anything downloads.
    expect(commands(f.calls)[0]).toBe(`${REG} query HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion`);
    const [verify, install] = f.calls.slice(1);
    expect(verify.file).toBe(POWERSHELL);
    // The path reaches PowerShell as an environment variable, never inside the command text.
    expect(verify.env).toEqual({ CODEMM_FILE: WIN_EXE });
    expect(verify.args.join(' ')).not.toContain(WIN_TMP);
    // Docker's own per-user install, Docker's default: no administrator, so no permission prompt, and --quiet hides its
    // window and install-type page. Docker's terms stay in Docker's own window, at its first start: no --accept-license.
    expect(install).toEqual({ file: WIN_EXE, args: ['install', '--user', '--quiet', '--backend=wsl-2'] });
    expect(f.calls).toHaveLength(3);
    // WSL needed nothing, so nothing said it did.
    expect(f.phases).toEqual(['downloading']);
    expect(f.launched).toEqual([{ file: 'C:\\Users\\me\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe', args: [] }]);
    expect(f.removed).toEqual([WIN_TMP]);
    expect(f.desktop.status()).toEqual({ phase: 'starting' });
  });

  it('on Windows: never runs an installer Docker did not sign', async () => {
    for (const output of ['NotSigned|\n', 'Valid|CN=Someone Else, O=Someone Else\n', 'HashMismatch|CN=Docker Inc, O=Docker Inc\n']) {
      const f = fake('win32', { answers: { [POWERSHELL]: { code: 0, output } } });
      f.desktop.install();
      await f.desktop.done();
      expect(f.calls).toHaveLength(2);
      expect(f.desktop.status()).toEqual({ phase: 'failed', problem: 'unverified' });
    }
  });

  it('on Windows: says when Windows needs a restart, and when the installer did not finish', async () => {
    for (const code of [3010, 1641]) {
      const restart = fake('win32', { tempDir: () => WIN_TMP, answers: { [INSTALL_KEY]: { code, output: '' } } });
      restart.desktop.install();
      await restart.desktop.done();
      expect(restart.desktop.status()).toEqual({ phase: 'failed', problem: 'restart' });
      expect(restart.launched).toEqual([]);
    }
    // Docker's unattended installer fails with 1 or 1603; any other code is a failure too.
    for (const code of [1, 1602, 1603, null]) {
      const failed = fake('win32', { tempDir: () => WIN_TMP, answers: { [INSTALL_KEY]: { code, output: '' } } });
      failed.desktop.install();
      await failed.desktop.done();
      expect(failed.desktop.status()).toEqual({ phase: 'failed', problem: 'failed' });
    }
  });

  it("on Windows: if Windows says Docker's installer needs an administrator after all, runs it once as one, for all users, saying so", async () => {
    const ELEVATED_KEY = `${POWERSHELL} -NoProfile -NonInteractive -Command $i = New-Object`;
    for (const refused of [{ code: null, output: '', failedToStart: 'EACCES' }, { code: 740, output: '' }]) {
      const phases: (string | undefined)[] = [];
      const f: ReturnType<typeof fake> = fake('win32', {
        tempDir: () => WIN_TMP,
        run: async (file, args, opts) => {
          f.calls.push({ file, args, ...(opts?.env ? { env: opts.env } : {}) });
          if (file === WIN_EXE) return refused;
          if (args[3]?.startsWith('$i = New-Object')) return (phases.push(f.desktop.status()?.phase), { code: 0, output: '' });
          return { code: 0, output: file === REG ? windowsInfo(26100) : 'Valid|CN=Docker Inc, O=Docker Inc\n' };
        },
      });
      f.desktop.install();
      await f.desktop.done();
      const elevated = f.calls.filter((c) => [c.file, ...c.args].join(' ').startsWith(ELEVATED_KEY));
      expect(elevated).toHaveLength(1);
      // Docker's all-users install: as an administrator, a per-user one would go to that administrator's account.
      expect(elevated[0].env).toEqual({ CODEMM_FILE: WIN_EXE, CODEMM_ARGS: 'install --quiet --backend=wsl-2' });
      expect(phases).toEqual(['admin']);
      expect(f.desktop.status()).toEqual({ phase: 'starting' });
    }
    // A learner who says no is told so, not "didn't finish".
    const f = fake('win32', {
      tempDir: () => WIN_TMP,
      run: async (file, args) => {
        if (file === WIN_EXE) return { code: 740, output: '' };
        if (args[3]?.startsWith('$i = New-Object')) return { code: 1223, output: '' };
        return { code: 0, output: file === REG ? windowsInfo(26100) : 'Valid|CN=Docker Inc, O=Docker Inc\n' };
      },
    });
    f.desktop.install();
    await f.desktop.done();
    expect(f.desktop.status()).toEqual({ phase: 'failed', problem: 'declined' });
  });

  it("on Windows: a Docker Desktop already here needs no download folder", async () => {
    let made = 0;
    const f = fake('win32', { exists: (p) => p === 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe', tempDir: () => (made++, WIN_TMP), wsl: { state: 'ready', setUp: 'done' } });
    f.desktop.install();
    await f.desktop.done();
    expect(made).toBe(0);
    expect(f.removed).toEqual([]);
    expect(f.desktop.status()).toEqual({ phase: 'starting' });
  });

  it('on Windows: sets up WSL first, before anything downloads, then installs Docker and asks for a restart', async () => {
    const f = fake('win32', { tempDir: () => WIN_TMP, wsl: { state: 'missing', setUp: 'restart' } });
    f.desktop.install();
    await f.desktop.done();
    expect(f.setUps).toEqual(['missing']);
    // Said while Windows asks permission for it.
    expect(f.phases).toEqual(['wsl']);
    expect(commands(f.calls)).toContain(INSTALL_KEY);
    // WSL runs only after a restart: Docker opens then, not now.
    expect(f.launched).toEqual([]);
    expect(f.desktop.status()).toEqual({ phase: 'failed', problem: 'restart' });
    expect(f.removed).toEqual([WIN_TMP]);
  });

  it('on Windows: an old WSL is updated, and Docker opens when no restart is needed', async () => {
    const f = fake('win32', { wsl: { state: 'old', setUp: 'done' } });
    f.desktop.install();
    await f.desktop.done();
    expect(f.setUps).toEqual(['old']);
    expect(f.desktop.status()).toEqual({ phase: 'starting' });
  });

  it("on Windows: says so when the learner says no to Windows' permission prompt, and downloads nothing", async () => {
    const f = fake('win32', { tempDir: () => WIN_TMP, wsl: { state: 'missing', setUp: 'declined' } });
    f.desktop.install();
    await f.desktop.done();
    expect(f.desktop.status()).toEqual({ phase: 'failed', problem: 'declined' });
    expect(f.downloads).toEqual([]);
    expect(f.launched).toEqual([]);

    const failed = fake('win32', { wsl: { state: 'missing', setUp: 'failed' } });
    failed.desktop.install();
    await failed.desktop.done();
    expect(failed.desktop.status()).toEqual({ phase: 'failed', problem: 'wsl-failed' });
    expect(failed.downloads).toEqual([]);
  });

  it('on Windows: never reinstalls over a Docker Desktop already here, for all users or this one; it sets up WSL and opens it', async () => {
    const allUsers = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';
    const f = fake('win32', { exists: (p) => p === allUsers, wsl: { state: 'ready', setUp: 'done' } });
    f.desktop.install();
    await f.desktop.done();
    expect(f.downloads).toEqual([]);
    // WSL needed nothing, so nothing said Windows would ask.
    expect(f.phases).toEqual([undefined]);
    expect(commands(f.calls).some((c) => c.includes('install --user'))).toBe(false);
    expect(f.launched).toEqual([{ file: allUsers, args: [] }]);
    expect(f.desktop.status()).toEqual({ phase: 'starting' });

    const wslFirst = fake('win32', { exists: (p) => p === allUsers, wsl: { state: 'missing', setUp: 'restart' } });
    wslFirst.desktop.install();
    await wslFirst.desktop.done();
    expect(wslFirst.downloads).toEqual([]);
    expect(wslFirst.desktop.status()).toEqual({ phase: 'failed', problem: 'restart' });
  });

  it('runs one install at a time, and can try again after a failure', async () => {
    let fail = true;
    const f = fake('darwin', { download: async () => (fail ? Promise.reject(new OfflineError('offline')) : undefined) });
    f.desktop.install();
    f.desktop.install();
    await f.desktop.done();
    expect(f.desktop.status()).toEqual({ phase: 'failed', problem: 'offline' });
    fail = false;
    f.desktop.install();
    await f.desktop.done();
    expect(f.desktop.status()).toEqual({ phase: 'starting' });
  });

  it('a download that fails for another reason is a plain failure', async () => {
    const f = fake('darwin', { download: async () => Promise.reject(new Error('HTTP 503')) });
    f.desktop.install();
    await f.desktop.done();
    expect(f.desktop.status()).toEqual({ phase: 'failed', problem: 'failed' });
  });

  it('does not install on Linux', async () => {
    const f = fake('linux');
    expect(f.desktop.canInstall).toBe(false);
    f.desktop.install();
    await f.desktop.done();
    expect(f.calls).toEqual([]);
    expect(f.desktop.status()).toBeUndefined();
  });
});

describe('opening Docker Desktop (§6.1)', () => {
  it('opens it and remembers when, so a slow start reads as starting', async () => {
    const mac = fake('darwin');
    await mac.desktop.open();
    expect(commands(mac.calls)).toEqual(['/usr/bin/open -a Docker']);
    expect(mac.desktop.startedAt()).toBe(1_000);

    const win = fake('win32');
    await win.desktop.open();
    expect(win.launched).toEqual([{ file: 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe', args: [] }]);
    expect(win.desktop.startedAt()).toBe(1_000);
  });
});

describe('Astra review fixes', () => {
  it('accepts only a signer whose organization is exactly Docker Inc', async () => {
    for (const [output, ok] of [
      ['Valid|CN=Docker Inc, O=Docker Inc, L=Palo Alto, S=California, C=US\n', true],
      ['Valid|CN=Evil, O=Docker Inc Evil, C=US\n', false],
      ['Valid|CN=Evil, OU=O=Docker Inc, O=Evil\n', false],
    ] as const) {
      const f = fake('win32', { answers: { [POWERSHELL]: { code: 0, output } } });
      f.desktop.install();
      await f.desktop.done();
      expect(f.desktop.status()?.problem === 'unverified').toBe(!ok);
    }
  });

  it('a launch that fails is a failure, never a crash', async () => {
    const f = fake('win32', { launch: async () => Promise.reject(new Error('spawn ENOENT')) });
    f.desktop.install();
    await f.desktop.done();
    expect(f.desktop.status()).toEqual({ phase: 'failed', problem: 'failed' });
    await expect(f.desktop.open()).rejects.toThrow();
  });

  it('copies into a staging folder in Applications, then moves it in place, so a failed copy never leaves a broken Docker', async () => {
    const f = fake('darwin');
    f.desktop.install();
    await f.desktop.done();
    const cmds = commands(f.calls);
    const ditto = cmds.find((c) => c.startsWith('/usr/bin/ditto'))!;
    expect(ditto).toMatch(/^\/usr\/bin\/ditto \/tmp\/codemm-docker\/mnt\/Docker\.app \/Applications\/\.codemm-docker-\w+\/Docker\.app$/);
    const staged = ditto.split(' ')[2];
    expect(cmds).toContain(`/bin/mv ${staged} /Applications/Docker.app`);
    expect(cmds.at(-1)).toBe('/usr/bin/open -a /Applications/Docker.app');

    const broken = fake('darwin', { answers: { '/usr/bin/ditto': { code: 1, output: 'No space left on device' } } });
    broken.desktop.install();
    await broken.desktop.done();
    expect(commands(broken.calls).some((c) => c.startsWith('/bin/mv '))).toBe(false);
    expect(broken.removed.some((p) => p.startsWith('/Applications/.codemm-docker-'))).toBe(true);
  });

  it("says when Docker won't open", async () => {
    const f = fake('darwin', { answers: { '/usr/bin/open -a': { code: 1, output: 'LSOpenURLsWithRole() failed' } } });
    f.desktop.install();
    await f.desktop.done();
    expect(f.desktop.status()).toEqual({ phase: 'failed', problem: 'failed' });
  });

  it('a temp folder it cannot make is a failure, not a stuck download', async () => {
    const f = fake('darwin', { tempDir: () => { throw new Error('EACCES'); } });
    f.desktop.install();
    await f.desktop.done();
    expect(f.desktop.status()).toEqual({ phase: 'failed', problem: 'failed' });
  });

  it('"starting" expires after the startup window, so a stale install never shows', async () => {
    const f = fake('darwin');
    f.desktop.install();
    await f.desktop.done();
    expect(f.desktop.status()).toEqual({ phase: 'starting' });
    f.tick(3 * 60_000 + 1);
    expect(f.desktop.status()).toBeUndefined();
  });
});

describe("this computer runs Docker Desktop, checked before the download (§6.1)", () => {
  it("knows Docker's documented minimums: macOS 14, Windows 10 22H2 or Windows 11 23H2, never Windows Server", () => {
    expect(systemProblem('darwin', '14.0\n')).toBeUndefined();
    expect(systemProblem('darwin', '26.0.1\n')).toBeUndefined();
    expect(systemProblem('darwin', '13.6.7\n')).toBe('macos-version');
    expect(systemProblem('darwin', '10.16\n')).toBe('macos-version');
    for (const build of [19045, 22631, 26100]) expect([build, systemProblem('win32', windowsInfo(build))]).toEqual([build, undefined]);
    for (const build of [19044, 22000, 22621]) expect([build, systemProblem('win32', windowsInfo(build))]).toEqual([build, 'windows-version']);
    expect(systemProblem('win32', windowsInfo(26100, 'Server'))).toBe('windows-server');
    expect(systemProblem('win32', windowsInfo(20348, 'Server Core'))).toBe('windows-server');
  });

  it("an answer it can't read never stops the learner: Docker's own installer has the last word", () => {
    expect(systemProblem('darwin', '')).toBeUndefined();
    expect(systemProblem('win32', 'ERROR: Access is denied.\r\n')).toBeUndefined();
  });

  it('says so instead of downloading Docker on a Mac or a PC that cannot run it', async () => {
    const mac = fake('darwin', { answers: { '/usr/bin/sw_vers': { code: 0, output: '13.6.1\n' } } });
    mac.desktop.install();
    await mac.desktop.done();
    expect(mac.downloads).toEqual([]);
    expect(mac.desktop.status()).toEqual({ phase: 'failed', problem: 'macos-version' });

    const server = fake('win32', { answers: { [REG]: { code: 0, output: windowsInfo(20348, 'Server') } } });
    server.desktop.install();
    await server.desktop.done();
    expect(server.downloads).toEqual([]);
    expect(server.desktop.status()).toEqual({ phase: 'failed', problem: 'windows-server' });
  });

  it('opens Windows Update, where an older Windows is updated, through explorer with no shell', async () => {
    const pc = fake('win32');
    await pc.desktop.windowsUpdate();
    expect(pc.launched).toEqual([{ file: 'C:\\Windows\\explorer.exe', args: ['ms-settings:windowsupdate'] }]);
    const mac = fake('darwin');
    await mac.desktop.windowsUpdate();
    expect(mac.launched).toEqual([]);
  });

  it('a check that fails to run goes on to the download', async () => {
    const f = fake('darwin', { answers: { '/usr/bin/sw_vers': { code: null, output: '' } } });
    f.desktop.install();
    await f.desktop.done();
    expect(f.downloads).toHaveLength(1);
  });
});

describe("this computer's own chip (§6.1)", () => {
  it('an Intel build of Codemm under Rosetta, or x64 emulation on Windows on Arm, still picks the Arm download', () => {
    expect(nativeArch('x64', true)).toBe('arm64');
    expect(nativeArch('x64', false)).toBe('x64');
    expect(nativeArch('arm64', false)).toBe('arm64');
  });
});

describe('Docker Desktop itself, apart from a docker command (§6.1)', () => {
  it('is installed when its app is where Docker puts it, for all users or (on Windows) for this one', () => {
    expect(fake('darwin', { exists: (p) => p === '/Applications/Docker.app' }).desktop.installed()).toBe(true);
    expect(fake('darwin').desktop.installed()).toBe(false);
    const perUser = 'C:\\Users\\me\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe';
    expect(fake('win32', { localAppData: 'C:\\Users\\me\\AppData\\Local', exists: (p) => p === perUser }).desktop.installed()).toBe(true);
    expect(fake('win32', { exists: (p) => p === 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe' }).desktop.installed()).toBe(true);
    expect(fake('win32', { localAppData: 'C:\\Users\\me\\AppData\\Local' }).desktop.installed()).toBe(false);
    expect(fake('linux', { exists: () => true }).desktop.installed()).toBe(false);
  });

  it('finds Docker Desktop where this Windows keeps its programs', async () => {
    const elsewhere = 'D:\\Programs\\Docker\\Docker\\Docker Desktop.exe';
    const f = fake('win32', { programFiles: 'D:\\Programs', exists: (p) => p === elsewhere });
    expect(f.desktop.installed()).toBe(true);
    await f.desktop.open();
    expect(f.launched).toEqual([{ file: elsewhere, args: [] }]);
  });

  it('opens the Docker Desktop this learner installed for themselves', async () => {
    const perUser = 'C:\\Users\\me\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe';
    const f = fake('win32', { localAppData: 'C:\\Users\\me\\AppData\\Local', exists: (p) => p === perUser });
    await f.desktop.open();
    expect(f.launched).toEqual([{ file: perUser, args: [] }]);
  });

  it("is installed in a Mac's ~/Applications too, and Open Docker Desktop opens that one", async () => {
    const mac = fake('darwin', { home: '/Users/me', exists: (p) => p === '/Users/me/Applications/Docker.app' });
    expect(mac.desktop.installed()).toBe(true);
    expect(fake('darwin', { home: '/Users/me' }).desktop.installed()).toBe(false);
    await mac.desktop.open();
    expect(commands(mac.calls)).toEqual(['/usr/bin/open -a /Users/me/Applications/Docker.app']);
  });
});

describe("Docker Desktop's app running, whether or not its engine answers yet (§6.1)", () => {
  it('asks the system, by absolute path and argument array', async () => {
    const mac = fake('darwin');
    expect(await mac.desktop.running()).toBe(true);
    expect(commands(mac.calls)).toEqual(['/usr/bin/pgrep -f /Applications/Docker.app/']);
    expect(await fake('darwin', { answers: { '/usr/bin/pgrep': { code: 1, output: '' } } }).desktop.running()).toBe(false);

    const tasklist = 'C:\\Windows\\System32\\tasklist.exe';
    const win = fake('win32', { answers: { [tasklist]: { code: 0, output: '"Docker Desktop.exe","8812","Console","1","152,004 K"\r\n' } } });
    expect(await win.desktop.running()).toBe(true);
    expect(win.calls).toEqual([{ file: tasklist, args: ['/FI', 'IMAGENAME eq Docker Desktop.exe', '/NH', '/FO', 'CSV'] }]);
    const none = fake('win32', { answers: { [tasklist]: { code: 0, output: 'INFO: No tasks are running which match the specified criteria.\r\n' } } });
    expect(await none.desktop.running()).toBe(false);
    expect(await fake('linux').desktop.running()).toBe(false);
  });
});

describe('what an install left behind (§6.1)', () => {
  it("removes a download a failed or declined install kept, once it's over an hour old, and only Codemm's", async () => {
    const hour = 60 * 60_000;
    for (const platform of ['darwin', 'win32'] as const) {
      const f = fake(platform, {
        now: () => 10 * hour,
        list: (dir) => (dir === '/tmp' ? ['codemm-docker-Ab3xYz', 'codemm-docker-new123', 'codemm-agent-Ab3xYz', 'other'] : []),
        modifiedAt: (p) => (p.endsWith('new123') ? 10 * hour - 60_000 : hour),
      });
      await f.desktop.removeLeftovers();
      expect(f.removed).toEqual([platform === 'win32' ? '\\tmp\\codemm-docker-Ab3xYz' : '/tmp/codemm-docker-Ab3xYz']);
    }
  });

  it("removes only Codemm's own staging folders in Applications, once they are over an hour old, without blocking the app", async () => {
    const hour = 60 * 60_000;
    const f = fake('darwin', {
      now: () => 10 * hour,
      list: (dir) => (dir === '/Applications' ? ['.codemm-docker-1a2b3c4d', '.codemm-docker-0f0f0f0f', 'Docker.app', '.codemm-docker-other', 'Codemm.app'] : []),
      modifiedAt: (p) => (p.endsWith('0f0f0f0f') ? 10 * hour - 60_000 : hour),
    });
    await f.desktop.removeLeftovers();
    // A copy of Docker is about 2 GB: rm runs on its own, not in the app's process. The young one may be another
    // Codemm's install that is still copying.
    expect(commands(f.calls)).toEqual(['/bin/rm -rf /Applications/.codemm-docker-1a2b3c4d']);
  });

  it('leaves Applications alone on Windows, and when it cannot be read', async () => {
    const win = fake('win32', { list: () => ['.codemm-docker-1a2b3c4d'] });
    await win.desktop.removeLeftovers();
    expect(win.calls).toEqual([]);
    const unreadable = fake('darwin', { list: () => { throw new Error('EPERM'); } });
    await expect(unreadable.desktop.removeLeftovers()).resolves.toBeUndefined();
  });
});

// These run the real commands on the computer the tests run on: CI's Mac and Windows machines.
describe('on this computer, for real', () => {
  const real = nodeDesktopDeps({ get: fetchGet, arch: process.arch });

  it.runIf(process.platform === 'darwin')("reads this Mac's version as Docker's check does", async () => {
    const r = await real.run('/usr/bin/sw_vers', ['-productVersion']);
    expect(r.code).toBe(0);
    // Darwin 23 is macOS 14.
    expect(systemProblem('darwin', r.output)).toBe(Number(release().split('.')[0]) >= 23 ? undefined : 'macos-version');
  });

  it("says why a program couldn't start, apart from one that ran and failed", async () => {
    expect(await real.run(process.platform === 'win32' ? 'C:\\no\\such\\program.exe' : '/no/such/program', [])).toEqual({ code: null, output: '', failedToStart: 'ENOENT' });
  });

  it.runIf(process.platform === 'win32')("reads this Windows' build and edition as Docker's check does", async () => {
    const r = await real.run(REG, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion']);
    expect(r.code).toBe(0);
    const build = Number(release().split('.')[2]);
    const runs = !/Server/i.test(version()) && (build >= 22631 || (build >= 19045 && build < 22000));
    expect(systemProblem('win32', r.output)).toBe(/Server/i.test(version()) ? 'windows-server' : runs ? undefined : 'windows-version');
  });
});
