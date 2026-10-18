// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { downloaded, isPrerelease, updates, verifyWindowsSignature, type Updater } from './updates';

/** An updater whose next check finds `next` (or nothing), recording downloads and installs. */
function fake(next: string | null = '1.2.0') {
  const calls: string[] = [];
  let finish!: () => void;
  const updater: Updater = {
    check: async () => (calls.push('check'), next ? { version: next } : null),
    download: () => (calls.push('download'), new Promise<void>((r) => (finish = r))),
    install: () => void calls.push('install'),
  };
  return { updater, calls, finish: () => finish() };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('updates', () => {
  it('a signed build downloads a new version in the background, then offers Restart to update', async () => {
    const f = fake();
    const u = updates({ signed: true, updater: f.updater });
    u.start();
    await tick();
    expect(u.status()).toEqual({ kind: 'downloading', version: '1.2.0' });
    f.finish();
    await tick();
    expect(u.status()).toEqual({ kind: 'ready', version: '1.2.0' });
    await u.restart();
    expect(f.calls).toEqual(['check', 'download', 'install']);
    u.stop();
  });

  it('installs only after Codemm has stopped its jobs and removed its containers', async () => {
    const f = fake();
    let finishCleanup!: () => void;
    const cleanup = vi.fn(() => new Promise<void>((r) => (finishCleanup = r)));
    const u = updates({ signed: true, updater: f.updater, cleanup });
    u.start();
    await tick();
    f.finish();
    await tick();
    const restarting = u.restart();
    await tick();
    expect(cleanup).toHaveBeenCalled();
    expect(f.calls).not.toContain('install');
    finishCleanup();
    await restarting;
    expect(f.calls.at(-1)).toBe('install');
    u.stop();
  });

  it('an unsigned build only says a new version is out, with its Releases page', async () => {
    const f = fake('1.2.0-beta.2');
    const u = updates({ signed: false, updater: f.updater });
    u.start();
    await tick();
    expect(u.status()).toEqual({ kind: 'available', version: '1.2.0-beta.2', url: 'https://github.com/iignaite/Codemm/releases/tag/v1.2.0-beta.2' });
    await u.restart();
    expect(f.calls).toEqual(['check']);
    u.stop();
  });

  it('checks at start and every 6 hours, and stays quiet when nothing is new or the check fails', async () => {
    vi.useFakeTimers();
    try {
      const f = fake(null);
      const log = vi.fn();
      const u = updates({ signed: true, updater: f.updater, log });
      u.start();
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 - 1);
      expect(f.calls).toEqual(['check']);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.calls).toEqual(['check', 'check']);
      expect(u.status()).toEqual({ kind: 'none' });
      f.updater.check = async () => {
        throw new Error('offline');
      };
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      expect(u.status()).toEqual({ kind: 'none' });
      expect(log).toHaveBeenCalledWith('update-error', expect.objectContaining({ message: 'offline' }));
      u.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a download that fails goes back to quiet, and the next check tries again', async () => {
    const f = fake();
    f.updater.download = async () => {
      throw new Error('disk full');
    };
    const u = updates({ signed: true, updater: f.updater, log: () => undefined });
    u.start();
    await tick();
    expect(u.status()).toEqual({ kind: 'none' });
    u.stop();
  });

  it('never builds a link from a version that is not one', async () => {
    const f = fake('1.2.0/../../evil?x=1');
    const u = updates({ signed: false, updater: f.updater, log: () => undefined });
    u.start();
    await tick();
    expect(u.status()).toEqual({ kind: 'none' });
    u.stop();
  });

  it('knows a prerelease version: those builds see prereleases, stable builds stable ones only', () => {
    expect(isPrerelease('1.0.0-beta.1')).toBe(true);
    expect(isPrerelease('1.0.0')).toBe(false);
  });

  it("a download is done only when the platform has checked it; an error until then fails it", async () => {
    // On macOS, electron-updater says "downloaded" when it hands the zip to Squirrel.Mac, which then checks the
    // signature: only Electron's own autoUpdater says when that's done. Errors arrive through electron-updater.
    const wrapper = new EventEmitter();
    const native = new EventEmitter();
    let settled = '';
    const first = downloaded(native, wrapper, async () => undefined).then(() => (settled = 'done'), () => (settled = 'failed'));
    wrapper.emit('update-downloaded');
    await tick();
    expect(settled).toBe('');
    native.emit('update-downloaded');
    await first;
    expect(settled).toBe('done');

    const second = downloaded(native, wrapper, async () => undefined);
    wrapper.emit('update-downloaded');
    wrapper.emit('error', new Error('Code signature did not pass validation'));
    await expect(second).rejects.toThrow('Code signature');
    expect(native.listenerCount('update-downloaded') + wrapper.listenerCount('error')).toBe(0);

    // Elsewhere, electron-updater's own event is the end.
    const third = downloaded(wrapper, wrapper, async () => undefined);
    wrapper.emit('update-downloaded');
    await expect(third).resolves.toBeUndefined();
  });

  describe('the Windows signature check, which fails closed', () => {
    const signed = (subject: string, status = 0) => async () => JSON.stringify({ Status: status, SignerCertificate: { Subject: subject } });
    const file = 'C:\\Users\\me\\AppData\\Local\\codemm-desktop-updater\\pending\\Codemm-1.2.0.exe';

    it('accepts only a valid signature from the expected publisher, by name or by full name', async () => {
      expect(await verifyWindowsSignature(['Codemm'], file, signed('CN=Codemm, O=Codemm, C=PH'))).toBeNull();
      expect(await verifyWindowsSignature(['CN=Codemm, O=Codemm'], file, signed('CN=Codemm, O=Codemm, C=PH'))).toBeNull();
      expect(await verifyWindowsSignature(['Codemm'], file, signed('CN=Someone Else, O=Codemm'))).toMatch(/signed by someone else/);
      expect(await verifyWindowsSignature(['Codemm'], file, signed('CN=Codemm', 2))).toMatch(/isn't validly signed/);
    });

    it("rejects the update when the check can't run or its answer can't be read", async () => {
      const blocked = async () => {
        throw new Error('powershell is disabled by policy');
      };
      expect(await verifyWindowsSignature(['Codemm'], file, blocked)).toMatch(/couldn't be checked/);
      expect(await verifyWindowsSignature(['Codemm'], file, async () => 'not json')).toMatch(/couldn't be read/);
      expect(await verifyWindowsSignature([], file, signed('CN=Codemm'))).toMatch(/no publisher/);
    });

    it('passes the file to PowerShell in the environment, never inside the command', async () => {
      let seen: { args: string[]; env: Record<string, string | undefined> } | undefined;
      await verifyWindowsSignature(['Codemm'], "C:\\x\\a';calc;'.exe", async (_exe, args, env) => ((seen = { args, env }), JSON.stringify({ Status: 0, SignerCertificate: { Subject: 'CN=Codemm' } })));
      expect(seen!.args.join(' ')).not.toContain('calc');
      expect(seen!.env.CODEMM_UPDATE_FILE).toBe("C:\\x\\a';calc;'.exe");
    });
  });
});
