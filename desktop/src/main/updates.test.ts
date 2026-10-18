// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { isPrerelease, updates, type Updater } from './updates';

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
});
