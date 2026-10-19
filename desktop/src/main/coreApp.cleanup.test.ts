// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

// Docker's answers, simulated: what the cleanup found and left.
const docker = vi.hoisted(() => ({ result: { abandoned: 0, left: 0 } as { abandoned: number; left: number } | Error }));
vi.mock('../../../src/sandbox', async (actual) => ({
  ...(await actual<typeof import('../../../src/sandbox')>()),
  removeAbandoned: async () => {
    if (docker.result instanceof Error) throw docker.result;
    return docker.result;
  },
}));

const { cleanupLeftovers } = await import('../../scripts/core-entry');

describe("the bundled core's leftover cleanup", () => {
  it('succeeds once every abandoned container is gone', async () => {
    docker.result = { abandoned: 2, left: 0 };
    await expect(cleanupLeftovers()).resolves.toBeUndefined();
  });

  it('fails when an abandoned container is still there', async () => {
    docker.result = { abandoned: 2, left: 1 };
    await expect(cleanupLeftovers()).rejects.toThrow();
  });

  it("succeeds when Docker isn't running: there's nothing it could have left", async () => {
    // Listing asked the runtime, which said it isn't running.
    docker.result = Object.assign(new Error("The container runtime isn't running."), { name: 'CodemmError', kind: 'docker', code: 'runtime-down' });
    await expect(cleanupLeftovers()).resolves.toBeUndefined();
  });

  it.each(['container-list', 'runtime-busy'])('fails when Docker answers but the cleanup failed (%s), a timeout included', async (code) => {
    // A busy Docker may still run the containers it didn't list.
    docker.result = Object.assign(new Error("Couldn't list Codemm's containers: timed out after 60s."), { name: 'CodemmError', kind: 'docker', code });
    await expect(cleanupLeftovers()).rejects.toThrow('timed out');
  });
});
