import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as app from "../src/app.js";
import { doctor } from "../src/doctor.js";
import { readFileMap } from "../src/files.js";
import { buildImage, runtimeHelp, startHelp } from "../src/sandbox.js";
import { parseTrackYaml } from "../src/schemas.js";
import * as store from "../src/store.js";
import { fakeDocker, posix } from "./fake-docker.js";
import { tempDir } from "./temp.js";

/** The environment matrix: what learners see when Docker is missing, stopped, offline or out of disk. */

const fixtures = join(import.meta.dirname, "fixtures");
const track = () => readFileMap(join(fixtures, "tracks", "shell-io"));

beforeEach(() => {
  vi.stubEnv("CODEMM_HOME", tempDir("codemm-home-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("doctor", () => {
  it("says what to install when Docker isn't installed, and skips the container checks", async () => {
    fakeDocker("missing");
    const checks = await doctor(false);
    expect(checks.find((c) => c.name === "container runtime")).toEqual({
      name: "container runtime",
      ok: false,
      detail: `No container runtime found. ${runtimeHelp()}`,
    });
    expect(checks.find((c) => c.name === "Codemm home")?.ok).toBe(true);
    expect(checks.map((c) => c.name)).not.toContain("network isolation");
  });

  it.runIf(posix)("says to start Docker, not install it, when it's installed but not running", async () => {
    fakeDocker("down");
    const checks = await doctor(false);
    expect(checks.find((c) => c.name === "container CLI")?.ok).toBe(true);
    const runtime = checks.find((c) => c.name === "container runtime")!;
    expect(runtime).toMatchObject({ ok: false, detail: `The container runtime isn't running. ${startHelp()}` });
    expect(runtime.detail).not.toMatch(/install/i);
  });
});

describe.runIf(posix)("building a track image", () => {
  it("returns the ID its own build produced, never whatever the shared tag points at later", async () => {
    fakeDocker("builds");
    const built = await buildImage(tempDir("codemm-context-"), "codemm-track-shell-io:1");
    expect(built).toMatchObject({ ok: true, imageId: "sha256:built" });
  });

  it("reports each build step as a count, and nothing of the build's output", async () => {
    fakeDocker("builds");
    const steps: unknown[] = [];
    await buildImage(tempDir("codemm-context-"), "codemm-track-shell-io:1", undefined, (step) => steps.push(step));
    expect(steps).toEqual([{ done: 1, total: 3 }, { done: 2, total: 3 }, { done: 3, total: 3 }]);
  });

  it("keeps building when a step listener throws", async () => {
    fakeDocker("builds");
    const built = await buildImage(tempDir("codemm-context-"), "codemm-track-shell-io:1", undefined, () => {
      throw new Error("listener bug");
    });
    expect(built).toMatchObject({ ok: true, imageId: "sha256:built" });
  });

  it("blames the runtime, not the track, when a build reports no image ID", async () => {
    fakeDocker("no-iid");
    const built = await buildImage(tempDir("codemm-context-"), "codemm-track-shell-io:1");
    expect(built).toMatchObject({ ok: false, problem: { kind: "docker", message: expect.stringMatching(/didn't report the image ID.*not a problem with the track files/s) } });
  });
});

describe.runIf(posix)("installing a track", () => {
  it.each([
    ["down", /isn't running/, "docker"],
    ["offline", /couldn't reach the network.*no such host.*not a problem with the track files/s, "offline"],
    ["disk-full", /ran out of disk space.*not a problem with the track files/s, "disk"],
  ] as const)("is an infrastructure failure when Docker is %s, and installs nothing", async (scenario, message, kind) => {
    fakeDocker(scenario);
    const failure = app.saveTrack(track());
    await expect(failure).rejects.toThrow(message);
    // The desktop tells these apart by kind, not by reading the English.
    await expect(failure).rejects.toMatchObject({ name: "CodemmError", kind });
    await expect(failure).rejects.not.toThrow(/Gate/);
    expect(app.listTracks()).toEqual([]);
  });

  it("calls a Docker failure while inspecting the built image a Docker problem, not a gate failure", async () => {
    fakeDocker("inspect-fails");
    const failure = app.saveTrack(track());
    await expect(failure).rejects.toMatchObject({ name: "CodemmError", kind: "docker" });
    await expect(failure).rejects.not.toThrow(/Gate/);
  });

  it("reports a setup's build steps, then its checks, as phases and counts only", async () => {
    fakeDocker("builds");
    await app.proposeTrack(track());
    const { digest } = app.listProposals()[0]!;
    const seen: unknown[] = [];
    // The fake's containers fail after the build, so the install stops at the probes.
    await expect(app.installProposal("shell-io@1", digest, (p) => seen.push(p))).rejects.toThrow();
    expect(seen).toEqual([
      { phase: "building", done: 1, total: 3 },
      { phase: "building", done: 2, total: 3 },
      { phase: "building", done: 3, total: 3 },
      { phase: "checking" },
    ]);
  });

  it("keeps a proposal when its install fails offline, so Try again needs no new consent", async () => {
    fakeDocker("offline");
    await app.proposeTrack(track());
    const { digest } = app.listProposals()[0]!;
    await expect(app.installProposal("shell-io@1", digest)).rejects.toThrow(/couldn't reach the network/);
    expect(app.listTracks()).toEqual([]);
    expect(app.listProposals().map((p) => p.digest)).toEqual([digest]);
  });
});

describe.runIf(posix)("a check that loses Docker mid-run", () => {
  it("grades and records a program whose memory kill takes down the driver, instead of blaming the runtime", async () => {
    const ws = await installedExercise();
    fakeDocker("oom");
    const r = await app.checkExercise(ws);
    expect(r).toMatchObject({ passed: 0, total: 4, recorded: true });
    expect(r.tests.every((t) => t.status === "error")).toBe(true);
    expect(r.tests[0]!.message).toMatch(/memory limit/i);
    expect(store.readEvents("shell")).toEqual([expect.objectContaining({ kind: "check", passed: 0, total: 4 })]);
  });

  it.each([
    ["stops", /stopped during the run, so it wasn't counted.*Start Docker/s],
    ["drops", /failed during the run, so it wasn't counted/],
    ["killed", /failed during the run, so it wasn't counted/],
  ] as const)("records nothing and says it wasn't counted when Docker %s", async (scenario, message) => {
    const ws = await installedExercise();
    fakeDocker(scenario);
    await expect(app.checkExercise(ws)).rejects.toThrow(message);
    expect(store.readEvents("shell")).toEqual([]);
  });
});

describe.runIf(posix)("a check whose program is killed", () => {
  it.each([
    ["caseoom", /^It ran out of memory \(memory_mb 128\)/],
    ["casekill", /^It took longer than 2000 ms/],
  ] as const)("tells a time-out from a memory kill the runtime recorded (%s)", async (scenario, message) => {
    const ws = await installedExercise();
    fakeDocker(scenario);
    const r = await app.checkExercise(ws);
    expect(r.tests[0]).toMatchObject({ status: "error", message: expect.stringMatching(message) });
    expect(r.recorded).toBe(true);
  });

  it("says a track's test runner ran out of memory, not just that it was killed", async () => {
    fakeDocker("unitoom");
    const unit = readFileMap(join(fixtures, "tracks", "shell-unit"));
    await expect(app.saveTrack(unit)).rejects.toThrow(/Gate "probe pass"[\s\S]*The test runner ran out of memory \(memory_mb 128\)/);
  });
});

/** A workspace whose exercise is installed (with a fake image) and edited, ready to check. */
async function installedExercise(): Promise<string> {
  const ws = tempDir("codemm-ws-");
  const spec = parseTrackYaml(track()["track.yaml"]!);
  store.commitFolder(store.trackDir("shell-io@1"), track(), {
    "track.json": { format_version: 1, ...spec, image: "codemm-track-shell-io:1", imageId: "sha256:fake", installedAt: new Date().toISOString() },
  });
  await app.saveRoadmap(ws, "shell", readFileSync(join(fixtures, "roadmaps", "shell-io.yaml"), "utf8"));
  const exercise = readFileMap(join(fixtures, "exercises", "io-max"));
  store.commitFolder(store.exerciseDir("shell", "max-of-line"), exercise, {
    "exercise.json": {
      format_version: 1, slug: "max-of-line", style: "io", concepts: ["sh.loops"], difficulty: 1, track: "shell-io@1",
      createdAt: new Date().toISOString(), expected: { "visible/01": "3\n", "hidden/01": "5\n", "hidden/02": "-1\n", "hidden/03": "7\n" },
    },
  });
  const { path } = await app.getExercise(ws, "max-of-line");
  writeFileSync(join(path, "main.sh"), "echo 3\n");
  return ws;
}
