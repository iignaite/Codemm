// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

// Docker's answer, simulated: how many abandoned containers there were and how many are still there.
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
    docker.result = new Error("Couldn't list Codemm's containers: Cannot connect to the Docker daemon.");
    await expect(cleanupLeftovers()).resolves.toBeUndefined();
  });
});
