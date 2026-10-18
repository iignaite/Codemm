// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { dockerDesktop, OfflineError, type DesktopDeps } from './dockerDesktop';

const GiB = 1024 ** 3;
const DOCKER_TEAM = 'TeamIdentifier=9BNSXJN65R';
const WIN_TMP = 'C:\\Temp\\codemm-docker';
const WIN_EXE = 'C:\\Temp\\codemm-docker\\DockerDesktopInstaller.exe';

type Call = { file: string; args: string[]; env?: Record<string, string> };

function fake(platform: NodeJS.Platform, over: Partial<DesktopDeps> & { answers?: Record<string, { code: number | null; output: string }> } = {}) {
  const calls: Call[] = [];
  const launched: Call[] = [];
  const removed: string[] = [];
  const downloads: { url: string; file: string }[] = [];
  let clock = 1_000;
  const answer = (file: string, args: string[]) => {
    const key = [file, ...args].join(' ');
    for (const [prefix, value] of Object.entries(over.answers ?? {})) if (key.startsWith(prefix)) return value;
    if (file === '/usr/bin/codesign' && args[0] === '-dv') return { code: 0, output: `Executable=/x\n${DOCKER_TEAM}\n` };
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
    remove: (path) => void removed.push(path),
    now: () => clock,
    ...over,
  };
  const desktop = dockerDesktop(deps);
  return { desktop, calls, launched, removed, downloads, tick: (ms: number) => (clock += ms) };
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
      'hdiutil attach -nobrowse -readonly -noautoopen -mountpoint /tmp/codemm-docker/mnt /tmp/codemm-docker/Docker.dmg',
      // Apple's own tools by absolute path: a codesign or spctl earlier on PATH can't answer for them.
      '/usr/bin/codesign --verify --deep --strict /tmp/codemm-docker/mnt/Docker.app',
      '/usr/bin/codesign -dv --verbose=2 /tmp/codemm-docker/mnt/Docker.app',
      '/usr/sbin/spctl --assess --type execute /tmp/codemm-docker/mnt/Docker.app',
      expect.stringMatching(/^ditto \/tmp\/codemm-docker\/mnt\/Docker\.app \/Applications\/\.codemm-docker-\w+\/Docker\.app$/),
      expect.stringMatching(/^mv \/Applications\/\.codemm-docker-\w+\/Docker\.app \/Applications\/Docker\.app$/),
      'hdiutil detach /tmp/codemm-docker/mnt -quiet',
      'open -a /Applications/Docker.app',
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
    expect(commands(f.calls).some((c) => c.startsWith('ditto'))).toBe(false);
    expect(commands(f.calls)).toContain('hdiutil detach /tmp/codemm-docker/mnt -quiet');
    expect(f.removed).toEqual(['/tmp/codemm-docker']);
    expect(f.desktop.status()).toEqual({ phase: 'failed', problem: 'unverified' });
  });

  it('refuses a broken signature or one macOS does not accept', async () => {
    for (const bad of ['/usr/bin/codesign --verify', '/usr/sbin/spctl']) {
      const f = fake('darwin', { answers: { [bad]: { code: 3, output: 'invalid' } } });
      f.desktop.install();
      await f.desktop.done();
      expect(commands(f.calls).some((c) => c.startsWith('ditto'))).toBe(false);
      expect(f.desktop.status()).toEqual({ phase: 'failed', problem: 'unverified' });
    }
  });

  it('when it cannot copy into Applications, opens the download for the learner to drag, and keeps it', async () => {
    const f = fake('darwin', { answers: { ditto: { code: 1, output: 'Permission denied' } } });
    f.desktop.install();
    await f.desktop.done();
    expect(commands(f.calls).slice(-2)).toEqual(['hdiutil detach /tmp/codemm-docker/mnt -quiet', 'open /tmp/codemm-docker/Docker.dmg']);
    // The partial copy goes; the download stays for the learner.
    expect(f.removed).toEqual([expect.stringMatching(/^\/Applications\/\.codemm-docker-\w+$/)]);
    expect(f.desktop.status()).toEqual({ phase: 'failed', problem: 'manual' });
  });

  it('opens Docker already in Applications instead of downloading it again', async () => {
    const f = fake('darwin', { exists: (p) => p === '/Applications/Docker.app' });
    f.desktop.install();
    await f.desktop.done();
    expect(f.downloads).toEqual([]);
    expect(commands(f.calls)).toEqual(['open -a /Applications/Docker.app']);
    expect(f.desktop.status()).toEqual({ phase: 'starting' });
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

  it('on Windows: downloads the installer, checks Docker signed it, runs it with its own window, then starts Docker', async () => {
    const f = fake('win32', { arch: 'x64', tempDir: () => WIN_TMP });
    f.desktop.install();
    await f.desktop.done();
    expect(f.downloads).toEqual([{ url: 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe', file: WIN_EXE }]);
    const verify = f.calls[0];
    expect(verify.file).toMatch(/powershell\.exe$/);
    // The path reaches PowerShell as an environment variable, never inside the command text.
    expect(verify.env).toEqual({ CODEMM_FILE: WIN_EXE });
    expect(verify.args.join(' ')).not.toContain(WIN_TMP);
    expect(commands(f.calls.slice(1))).toEqual([`${WIN_EXE} install`]);
    expect(f.launched).toEqual([{ file: 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe', args: [] }]);
    expect(f.removed).toEqual([WIN_TMP]);
    expect(f.desktop.status()).toEqual({ phase: 'starting' });
  });

  it('on Windows: never runs an installer Docker did not sign', async () => {
    for (const output of ['NotSigned|\n', 'Valid|CN=Someone Else, O=Someone Else\n', 'HashMismatch|CN=Docker Inc, O=Docker Inc\n']) {
      const f = fake('win32', { answers: { 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe': { code: 0, output } } });
      f.desktop.install();
      await f.desktop.done();
      expect(f.calls).toHaveLength(1);
      expect(f.desktop.status()).toEqual({ phase: 'failed', problem: 'unverified' });
    }
  });

  it('on Windows: says when Windows needs a restart, and when the installer did not finish', async () => {
    const restart = fake('win32', { tempDir: () => WIN_TMP, answers: { [WIN_EXE]: { code: 3010, output: '' } } });
    restart.desktop.install();
    await restart.desktop.done();
    expect(restart.desktop.status()).toEqual({ phase: 'failed', problem: 'restart' });
    expect(restart.launched).toEqual([]);

    const cancelled = fake('win32', { tempDir: () => WIN_TMP, answers: { [WIN_EXE]: { code: 1602, output: '' } } });
    cancelled.desktop.install();
    await cancelled.desktop.done();
    expect(cancelled.desktop.status()).toEqual({ phase: 'failed', problem: 'failed' });
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
    expect(commands(mac.calls)).toEqual(['open -a Docker']);
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
      const f = fake('win32', { answers: { 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe': { code: 0, output } } });
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
    const ditto = cmds.find((c) => c.startsWith('ditto'))!;
    expect(ditto).toMatch(/^ditto \/tmp\/codemm-docker\/mnt\/Docker\.app \/Applications\/\.codemm-docker-\w+\/Docker\.app$/);
    const staged = ditto.split(' ')[2];
    expect(cmds).toContain(`mv ${staged} /Applications/Docker.app`);
    expect(cmds.at(-1)).toBe('open -a /Applications/Docker.app');

    const broken = fake('darwin', { answers: { ditto: { code: 1, output: 'No space left on device' } } });
    broken.desktop.install();
    await broken.desktop.done();
    expect(commands(broken.calls).some((c) => c.startsWith('mv '))).toBe(false);
    expect(broken.removed.some((p) => p.startsWith('/Applications/.codemm-docker-'))).toBe(true);
  });

  it("says when Docker won't open", async () => {
    const f = fake('darwin', { answers: { 'open -a': { code: 1, output: 'LSOpenURLsWithRole() failed' } } });
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
