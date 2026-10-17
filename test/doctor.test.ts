import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doctor } from "../src/doctor.js";
import { runtimeHelp } from "../src/sandbox.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("doctor without a container runtime", () => {
  it("says what to install and start on this OS, and skips the container checks", async () => {
    vi.stubEnv("CODEMM_CONTAINER_CLI", "codemm-no-such-runtime");
    vi.stubEnv("CODEMM_HOME", mkdtempSync(join(tmpdir(), "codemm-home-")));
    const checks = await doctor(false);
    expect(checks.find((c) => c.name === "container runtime")).toEqual({
      name: "container runtime",
      ok: false,
      detail: `The container runtime isn't running. ${runtimeHelp()}`,
    });
    expect(checks.find((c) => c.name === "Codemm home")?.ok).toBe(true);
    expect(checks.map((c) => c.name)).not.toContain("network isolation");
  });
});
