import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cli, runSandboxed } from "../../src/sandbox.js";
import { dockerUp } from "./helpers.js";
import { tempDir } from "../temp.js";

describe.runIf(dockerUp)("container cleanup", () => {
  afterAll(async () => {
    delete process.env.CODEMM_CONTAINER_CLI;
    delete process.env.CODEMM_CLEANUP_MS;
    const leftovers = await cli(["ps", "-aq", "--filter", "label=codemm-stalled-test=1"]);
    for (const id of leftovers.output.split(/\s+/).filter(Boolean)) await cli(["rm", "-f", id]);
  });

  it("gives up on a stalled `rm` after a bounded time and reports it", async () => {
    // A wrapper CLI whose `rm` hangs, standing in for a stuck daemon.
    const dir = tempDir("codemm-fakecli-");
    const fake = join(dir, "docker");
    writeFileSync(fake, `#!/bin/sh\nif [ "$1" = rm ]; then sleep 60; exit 1; fi\nif [ "$1" = run ]; then shift; exec docker run --label codemm-stalled-test=1 "$@"; fi\nexec docker "$@"\n`);
    chmodSync(fake, 0o755);
    process.env.CODEMM_CONTAINER_CLI = fake;
    process.env.CODEMM_CLEANUP_MS = "2000";
    const started = Date.now();
    const r = await runSandboxed({ image: "codemm-test-shell-io:1", script: "sleep 60", env: {}, mounts: [], memoryMb: 64, deadlineMs: 1500 });
    expect(r.timedOut).toBe(true);
    expect(r.cleanupFailed).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});
