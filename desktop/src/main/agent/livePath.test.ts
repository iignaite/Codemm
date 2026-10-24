// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { livePath, mergePath, regPath, type PathDeps } from './livePath';

const REG = 'C:\\Windows\\System32\\reg.exe';
const MACHINE = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const USER = 'HKCU\\Environment';
/** One `reg query <key> /v Path` answer, as reg.exe prints it. */
const answer = (key: string, value: string, type = 'REG_EXPAND_SZ') => `\r\nHKEY_${key}\r\n    Path    ${type}    ${value}\r\n\r\n`;

describe("Windows' registry PATH (§3.1)", () => {
  it('reads the Path value and expands %NAME% from the environment, ignoring case, as Windows does', () => {
    const env = { USERPROFILE: 'C:\\Users\\me', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
    const value = '%UserProfile%\\.local\\bin;%localappdata%\\Microsoft\\WinGet\\Links;C:\\Program Files\\Git\\cmd';
    expect(regPath(answer(USER, value), env)).toBe('C:\\Users\\me\\.local\\bin;C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links;C:\\Program Files\\Git\\cmd');
    // A name the environment doesn't have stays as it is.
    expect(regPath(answer(USER, '%NOT_SET%\\bin'), env)).toBe('%NOT_SET%\\bin');
    // REG_SZ is plain text: Windows expands only REG_EXPAND_SZ.
    expect(regPath(answer(USER, '%USERPROFILE%\\bin', 'REG_SZ'), env)).toBe('%USERPROFILE%\\bin');
    // The value's name as Windows stored it, in any case.
    expect(regPath('\r\nHKEY_LOCAL_MACHINE\\x\r\n    PATH    REG_SZ    C:\\Windows\\system32\r\n', env)).toBe('C:\\Windows\\system32');
  });

  it('reads nothing from an empty value, or an answer with no Path', () => {
    expect(regPath(answer(USER, ''), {})).toBe('');
    expect(regPath('ERROR: The system was unable to find the specified registry key or value.\r\n', {})).toBe('');
  });

  it('keeps the current PATH first, then adds the machine folders, then the user folders it lacks, ignoring case and a trailing backslash', () => {
    const current = 'C:\\Windows\\system32;C:\\Tools\\';
    expect(mergePath(current, 'c:\\windows\\System32\\;C:\\Machine', 'C:\\tools;;C:\\Machine\\;C:\\User')).toBe('C:\\Windows\\system32;C:\\Tools\\;C:\\Machine;C:\\User');
    expect(mergePath('', '', 'C:\\User')).toBe('C:\\User');
    expect(mergePath(current, '', '')).toBe(current);
  });

  it("never shrinks or reorders what PATH already had, Docker's folders added at start included", () => {
    const current = 'C:\\Windows\\system32;;C:\\Program Files\\Docker\\Docker\\resources\\bin;';
    expect(mergePath(current, 'C:\\Program Files\\Docker\\Docker\\resources\\bin;C:\\Machine', '')).toBe(`${current}C:\\Machine`);
    expect(mergePath('C:\\Windows\\system32', '', 'C:\\User')).toBe('C:\\Windows\\system32;C:\\User');
  });
});

describe('bringing PATH up to date (§3.1)', () => {
  function fake(over: Partial<PathDeps> = {}) {
    const calls: string[][] = [];
    const registry = { machine: 'C:\\Windows\\system32', user: '%LOCALAPPDATA%\\cursor-agent' };
    let clock = 0;
    let reads = 0;
    const deps: PathDeps = {
      platform: 'win32',
      env: { PATH: 'C:\\Windows\\system32', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      run: async (file, args) => {
        calls.push([file, ...args]);
        reads++;
        await new Promise((r) => setTimeout(r, 1));
        return args[1] === USER ? answer(USER, registry.user) : answer(MACHINE, registry.machine);
      },
      now: () => clock,
      ...over,
    };
    return { deps, refresh: livePath(deps), calls, registry, reads: () => reads, tick: (ms: number) => (clock += ms) };
  }

  it('asks reg.exe by absolute path, with argument arrays, for the machine and the user Path, and adds what a running Codemm missed', async () => {
    const f = fake();
    await f.refresh();
    expect(f.calls).toEqual([
      [REG, 'query', MACHINE, '/v', 'Path'],
      [REG, 'query', USER, '/v', 'Path'],
    ]);
    expect(f.deps.env.PATH).toBe('C:\\Windows\\system32;C:\\Users\\me\\AppData\\Local\\cursor-agent');
  });

  it('shares one read between calls at the same time, and reuses a result under 2 seconds old', async () => {
    const f = fake();
    await Promise.all([f.refresh(), f.refresh(), f.refresh()]);
    expect(f.reads()).toBe(2);
    f.tick(1_000);
    await f.refresh();
    expect(f.reads()).toBe(2);
    // An installer adds its folder meanwhile: the next read, once the last is 2 seconds old, finds it.
    f.registry.user += ';C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links';
    f.tick(1_001);
    await f.refresh();
    expect(f.reads()).toBe(4);
    expect(f.deps.env.PATH).toBe('C:\\Windows\\system32;C:\\Users\\me\\AppData\\Local\\cursor-agent;C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links');
  });

  it('keeps the current PATH when reg.exe fails, and reads again once that read is 2 seconds old', async () => {
    const f = fake();
    const works = f.deps.run;
    f.deps.run = async () => null;
    await f.refresh();
    expect(f.deps.env.PATH).toBe('C:\\Windows\\system32');
    f.deps.run = works;
    f.tick(2_001);
    await f.refresh();
    expect(f.deps.env.PATH).toBe('C:\\Windows\\system32;C:\\Users\\me\\AppData\\Local\\cursor-agent');
  });

  it('keeps the current PATH when reg.exe throws, and tries again only after 30 seconds', async () => {
    const f = fake();
    const works = f.deps.run;
    f.deps.run = async () => {
      throw new Error('spawn EACCES');
    };
    await expect(f.refresh()).resolves.toBeUndefined();
    expect(f.deps.env.PATH).toBe('C:\\Windows\\system32');
    f.deps.run = works;
    f.tick(29_999);
    await f.refresh();
    expect(f.reads()).toBe(0);
    f.tick(1);
    await f.refresh();
    expect(f.deps.env.PATH).toBe('C:\\Windows\\system32;C:\\Users\\me\\AppData\\Local\\cursor-agent');
  });

  it('gives up on a reg.exe that hangs after 2 seconds and keeps the PATH, so no screen waits on it longer', async () => {
    vi.useFakeTimers();
    try {
      let asked = 0;
      const f = fake({ run: () => (asked++, new Promise(() => undefined)) });
      let done = false;
      void f.refresh().then(() => (done = true));
      await vi.advanceTimersByTimeAsync(1_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      expect(f.deps.env.PATH).toBe('C:\\Windows\\system32');
      // A stuck reg.exe isn't asked again on every look: polling screens never wait on it twice in 30 seconds.
      f.tick(29_999);
      void f.refresh();
      expect(asked).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a folder reg.exe could not spell (a name outside its code page), rather than hand children a broken PATH', async () => {
    const f = fake();
    f.registry.user = 'C:\\Users\\Jos\uFFFD\\bin;C:\\Users\\me\\bin';
    await f.refresh();
    expect(f.deps.env.PATH).toBe('C:\\Windows\\system32;C:\\Users\\me\\bin');
  });

  it('does nothing when a test staged its own PATH (the packaged and install tests: no Node, npm or Git)', async () => {
    const f = fake({ env: { PATH: 'C:\\staged', CODEMM_TEST_FIXED_PATH: '1' } });
    await f.refresh();
    expect(f.calls).toEqual([]);
    expect(f.deps.env.PATH).toBe('C:\\staged');
  });

  it('does nothing off Windows, where a GUI app gets no shell PATH to refresh', async () => {
    const f = fake({ platform: 'darwin', env: { PATH: '/usr/bin:/bin' } });
    await f.refresh();
    expect(f.calls).toEqual([]);
    expect(f.deps.env.PATH).toBe('/usr/bin:/bin');
  });
});
