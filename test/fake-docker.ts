import { chmodSync, copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

export type Scenario = "missing" | "down" | "offline" | "disk-full" | "stops" | "drops" | "oom" | "killed" | "builds";

/** Node can't run a shell script without a shell on Windows, so only "missing" works there. */
export const posix = process.platform !== "win32";

/**
 * Makes `docker` on PATH the fake in fixtures/fake-docker for one scenario ("missing" puts no
 * `docker` there at all). Undo it with vi.unstubAllEnvs().
 */
export function fakeDocker(scenario: Scenario): void {
  const bin = mkdtempSync(join(tmpdir(), "codemm-fake-docker-"));
  if (scenario !== "missing") {
    copyFileSync(join(import.meta.dirname, "fixtures", "fake-docker"), join(bin, "docker"));
    chmodSync(join(bin, "docker"), 0o755);
  }
  vi.stubEnv("PATH", bin);
  vi.stubEnv("CODEMM_CONTAINER_CLI", "");
  vi.stubEnv("FAKE_DOCKER", scenario);
}
