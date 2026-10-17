import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as app from "../src/app.js";
import { doctor } from "../src/doctor.js";
import { readFileMap } from "../src/files.js";
import { runtimeHelp, startHelp } from "../src/sandbox.js";
import { parseTrackYaml } from "../src/schemas.js";
import * as store from "../src/store.js";
import { fakeDocker, posix } from "./fake-docker.js";

/** The environment matrix: what learners see when Docker is missing, stopped, offline or out of disk. */

const fixtures = join(import.meta.dirname, "fixtures");
const track = () => readFileMap(join(fixtures, "tracks", "shell-io"));

beforeEach(() => {
  vi.stubEnv("CODEMM_HOME", mkdtempSync(join(tmpdir(), "codemm-home-")));
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

describe.runIf(posix)("installing a track", () => {
  it.each([
    ["down", /isn't running/],
    ["offline", /couldn't reach the network.*no such host.*not a problem with the track files/s],
    ["disk-full", /ran out of disk space.*not a problem with the track files/s],
  ] as const)("is an infrastructure failure when Docker is %s, and installs nothing", async (scenario, message) => {
    fakeDocker(scenario);
    const failure = app.saveTrack(track());
    await expect(failure).rejects.toThrow(message);
    await expect(failure).rejects.not.toThrow(/Gate/);
    expect(app.listTracks()).toEqual([]);
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

/** A workspace whose exercise is installed (with a fake image) and edited, ready to check. */
async function installedExercise(): Promise<string> {
  const ws = mkdtempSync(join(tmpdir(), "codemm-ws-"));
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
