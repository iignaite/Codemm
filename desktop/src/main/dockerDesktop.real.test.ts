// @vitest-environment node
// Opt-in, on a Mac with network: the real download from Docker and the real signature checks, stopping short
// of installing. CODEMM_REAL_DOCKER_DOWNLOAD=1 npx vitest run src/main/dockerDesktop.real.test.ts
import { describe, expect, it } from 'vitest';
import { dockerDesktop, nodeDesktopDeps } from './dockerDesktop';

const real = process.env.CODEMM_REAL_DOCKER_DOWNLOAD === '1' && process.platform === 'darwin';

describe.skipIf(!real)("Docker's real download (opt-in)", () => {
  it('downloads Docker Desktop for this Mac and accepts it only because Docker signed it', { timeout: 20 * 60_000 }, async () => {
    const deps = nodeDesktopDeps();
    const ran: string[] = [];
    const progress: number[] = [];
    let dir = '';
    const desktop = dockerDesktop({
      ...deps,
      tempDir: () => (dir = deps.tempDir()),
      download: (url, file, report) => deps.download(url, file, (f) => (progress.push(f), report(f))),
      // Everything up to the signature checks is real; installing and opening are not.
      run: async (file, args, opts) => {
        ran.push([file, ...args].join(' '));
        if (file === 'ditto' || file === 'mv' || file === 'open') return { code: 0, output: '' };
        return deps.run(file, args, opts);
      },
      exists: (p) => p !== '/Applications/Docker.app' && deps.exists(p),
    });
    desktop.install();
    await desktop.done();
    expect(desktop.status()).toEqual({ phase: 'starting' });
    expect(progress.at(-1)).toBe(1);
    expect(ran.filter((c) => /^(codesign|spctl)/.test(c))).toHaveLength(3);
    expect(deps.exists(dir)).toBe(false);
  });
});
