import { readdirSync, realpathSync } from "node:fs";
import { Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { networkIsolation } from "../../src/doctor.js";
import { cli, OWNER_LABEL } from "../../src/sandbox.js";
import { dockerUp, recordMounts } from "./helpers.js";
import { tempDir } from "../temp.js";

describe.runIf(dockerUp)("network isolation check", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("proves the sandbox can't reach a server an ordinary container can, without listening on the host", async () => {
    // A host server needs the host's firewall to let containers in (macOS and Windows ask, or block).
    const listen = vi.spyOn(Server.prototype, "listen");
    const check = await networkIsolation();
    expect(check).toMatchObject({ ok: true });
    expect(listen).not.toHaveBeenCalled();
  });

  it("leaves no container behind", async () => {
    await networkIsolation();
    const mine = await cli(["ps", "-aq", "--filter", `label=${OWNER_LABEL}`, "--filter", `label=codemm.pid=${process.pid}`]);
    expect(mine.output.trim()).toBe("");
  });

  it("mounts a staged folder under Codemm's home, read-only, and reads a file from it, as a check does", async () => {
    const home = tempDir("codemm-home-");
    vi.stubEnv("CODEMM_HOME", home);
    const recorder = recordMounts();
    try {
      expect(await networkIsolation()).toMatchObject({ ok: true });
      const mounted = recorder.mounts();
      expect(mounted).toHaveLength(1);
      expect(mounted[0]!.startsWith(join(realpathSync.native(home), "runs"))).toBe(true);
      expect(readdirSync(join(realpathSync.native(home), "runs"))).toEqual([]);
    } finally {
      recorder.stop();
    }
  });
});
