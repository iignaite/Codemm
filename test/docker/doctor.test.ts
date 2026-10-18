import { Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { networkIsolation } from "../../src/doctor.js";
import { cli, OWNER_LABEL } from "../../src/sandbox.js";
import { dockerUp } from "./helpers.js";

describe.runIf(dockerUp)("network isolation check", () => {
  afterEach(() => vi.restoreAllMocks());

  it("proves the sandbox can't reach a server an ordinary container can, without listening on the host", async () => {
    // A host server needs the host's firewall to let containers in (macOS and Windows ask, or block).
    const listen = vi.spyOn(Server.prototype, "listen");
    const check = await networkIsolation();
    expect(check).toMatchObject({ ok: true });
    expect(listen).not.toHaveBeenCalled();
  });

  it("leaves no container behind", async () => {
    const before = (await cli(["ps", "-aq", "--filter", `label=${OWNER_LABEL}`])).output.trim();
    await networkIsolation();
    expect((await cli(["ps", "-aq", "--filter", `label=${OWNER_LABEL}`])).output.trim()).toBe(before);
  });
});
