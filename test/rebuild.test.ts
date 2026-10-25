import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as app from "../src/app.js";
import * as gates from "../src/gates.js";
import { CodemmError } from "../src/errors.js";
import * as store from "../src/store.js";
import { fakeDocker, posix } from "./fake-docker.js";
import { tempDir } from "./temp.js";

// The gates are stood in for: the track's image verifies, then re-checking an exercise meets a Docker failure.
vi.mock("../src/gates.js", async (original) => ({
  ...(await original<typeof import("../src/gates.js")>()),
  verifyTrack: vi.fn(async () => ({ spec: {}, image: "codemm-track-shell-io:1-candidate", imageId: "sha256:new" })),
  verifyExercise: async () => {
    throw new CodemmError("The container runtime failed during the run, so it wasn't counted. Run `codemm doctor`, then retry.", "docker");
  },
}));

beforeEach(() => vi.stubEnv("CODEMM_HOME", tempDir("codemm-home-")));
afterEach(() => vi.unstubAllEnvs());

describe.runIf(posix)("rebuilding a track", () => {
  it("passes on this computer's Docker failure, with its kind, instead of calling it changed behaviour", async () => {
    const { id, version } = store.parseTrackRef("shell-io@1");
    store.writeTrackRecord("shell-io@1", {
      format_version: 1, id, version, styles: ["io"], files: ["main.sh"], run: "sh main.sh",
      limits: { time_ms: 2000, memory_mb: 256 }, image: "codemm-track-shell-io:1", imageId: "sha256:old", installedAt: new Date().toISOString(),
    });
    await app.saveRoadmap(tempDir("codemm-ws-"), "shell", "goal: Shell\ntrack: shell-io@1\nstyle: io\nconcepts:\n  - { id: sh.basics, title: Basics, requires: [] }\n");
    store.commitFolder(store.exerciseDir("shell", "e1"), { "README.md": "x" }, {
      "exercise.json": { format_version: 1, slug: "e1", style: "io", concepts: ["sh.basics"], difficulty: 1, track: "shell-io@1", createdAt: new Date().toISOString(), expected: {} },
    });
    fakeDocker("builds");
    const rebuild = app.rebuildTrack("shell-io@1");
    await expect(rebuild).rejects.toMatchObject({ kind: "docker", message: expect.stringMatching(/container runtime failed/) });
    await expect(rebuild).rejects.not.toThrow(/behaves differently/);
    expect(store.readTrack("shell-io@1")?.imageId).toBe("sha256:old");
    // The track's gates run as it was installed: a stricter speed gate added since must not strand its courses.
    expect(vi.mocked(gates.verifyTrack)).toHaveBeenCalledWith(expect.anything(), "codemm-track-shell-io:1-candidate", undefined, { rebuild: true });
  });
});
