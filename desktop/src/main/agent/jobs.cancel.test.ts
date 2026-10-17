// @vitest-environment node
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

// A cancel whose process group survives (§3.1): simulated, since a real group can't be made to outlive SIGKILL.
const launches = vi.hoisted(() => ({ count: 0 }));
vi.mock('./bridge', async (actual) => ({
  ...(await actual<typeof import('./bridge')>()),
  run: async () => {
    launches.count++;
    return { code: null, cancelled: true, stopped: false };
  },
}));

const { runJob } = await import('./jobs');

describe('a job whose agent could not be stopped', () => {
  it('fails as unstoppable and never launches another agent', async () => {
    const outcome = await runJob({
      kind: 'lesson',
      agent: 'claude',
      exe: { path: '/bin/claude', js: false },
      brief: 'Write.',
      server: () => ({ command: '/app', args: [] }),
      cwd: tmpdir(),
      done: () => false,
      signedIn: async () => true,
    });
    expect(outcome).toMatchObject({ ok: false, problem: 'unstoppable' });
    expect(launches.count).toBe(1);
  });
});
