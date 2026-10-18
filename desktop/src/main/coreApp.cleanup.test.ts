// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

// Docker's answers, simulated: what the cleanup found and left, and whether the runtime is down.
const docker = vi.hoisted(() => ({ result: { abandoned: 0, left: 0 } as { abandoned: number; left: number } | Error, down: undefined as string | undefined }));
vi.mock('../../../src/sandbox', async (actual) => ({
  ...(await actual<typeof import('../../../src/sandbox')>()),
  removeAbandoned: async () => {
    if (docker.result instanceof Error) throw docker.result;
    return docker.result;
  },
  runtimeDown: async () => docker.down,
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
    docker.down = "The container runtime isn't running.";
    await expect(cleanupLeftovers()).resolves.toBeUndefined();
  });

  it('fails when Docker is running but the cleanup failed, a timeout included', async () => {
    docker.result = new Error("Couldn't list Codemm's containers: timed out after 60s.");
    docker.down = undefined;
    await expect(cleanupLeftovers()).rejects.toThrow('timed out');
  });
});
