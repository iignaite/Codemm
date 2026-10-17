import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as app from "../src/app.js";
import { readFileMap } from "../src/files.js";
import { sandboxArgs } from "../src/sandbox.js";
import { parseTrackYaml } from "../src/schemas.js";
import * as store from "../src/store.js";
import { fakeDocker, posix } from "./fake-docker.js";

/** Run: the learner's io program, interactively, in the sandbox. Never recorded. */

const fixtures = join(import.meta.dirname, "fixtures");

beforeEach(() => {
  vi.stubEnv("CODEMM_HOME", mkdtempSync(join(tmpdir(), "codemm-home-")));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("interactive run: the sandbox", () => {
  it("keeps every isolation flag, and adds only an open stdin", () => {
    const base = { image: "img", script: "true", env: {}, mounts: [], memoryMb: 128, deadlineMs: 1000 };
    const plain = sandboxArgs(base, "n", "1:1");
    const interactive = sandboxArgs({ ...base, stdin: true }, "n", "1:1");
    expect(interactive.filter((a) => !plain.includes(a))).toEqual(["-i"]);
    expect(interactive).toEqual(expect.arrayContaining(["--network", "none", "--read-only", "--cap-drop", "ALL"]));
  });
});

describe.runIf(posix)("interactive run", () => {
  it("sends typed lines to the program and streams what it prints, recording nothing", async () => {
    const ws = await installedExercise();
    fakeDocker("interactive");
    const out: string[] = [];
    const run = await app.runInteractive(ws, undefined, undefined, (text, stream) => out.push(`${stream}:${text}`));
    run.write("Ada\n");
    expect(await run.done).toMatchObject({ exit: 0, timedOut: false, flooded: false });
    expect(out.join("")).toContain("stdout:hello Ada");
    expect(out.join("")).toContain("stderr:a warning");
    expect(store.readEvents("shell")).toEqual([]);
  });

  it("stops the program when asked", async () => {
    const ws = await installedExercise();
    fakeDocker("waits");
    const run = await app.runInteractive(ws, undefined, undefined, () => undefined);
    run.kill();
    expect((await run.done).exit).not.toBe(0);
  });

  it("stops a program that runs past the time limit", async () => {
    const ws = await installedExercise();
    // No build step, so the host deadline is the run limit plus a little (the fake ignores `timeout`).
    store.writeTrackRecord("shell-io@1", { ...store.readTrack("shell-io@1")!, build: undefined } as never);
    fakeDocker("waits");
    const run = await app.runInteractive(ws, undefined, undefined, () => undefined, { limitMs: 300 });
    expect(await run.done).toMatchObject({ timedOut: true });
  });

  it("isn't offered for a track with no run command", async () => {
    const ws = await installedExercise();
    const track = store.readTrack("shell-io@1")!;
    store.writeTrackRecord("shell-io@1", { ...track, run: undefined, styles: ["unit"], test: "true" } as never);
    fakeDocker("interactive");
    await expect(app.runInteractive(ws, undefined, undefined, () => undefined)).rejects.toThrow(/no run command/);
  });
});

/** A workspace whose io exercise is installed (with a fake image) and edited. */
async function installedExercise(): Promise<string> {
  const ws = mkdtempSync(join(tmpdir(), "codemm-ws-"));
  const track = readFileMap(join(fixtures, "tracks", "shell-io"));
  store.commitFolder(store.trackDir("shell-io@1"), track, {
    "track.json": { format_version: 1, ...parseTrackYaml(track["track.yaml"]!), image: "codemm-track-shell-io:1", imageId: "sha256:fake", installedAt: new Date().toISOString() },
  });
  await app.saveRoadmap(ws, "shell", readFileSync(join(fixtures, "roadmaps", "shell-io.yaml"), "utf8"));
  store.commitFolder(store.exerciseDir("shell", "max-of-line"), readFileMap(join(fixtures, "exercises", "io-max")), {
    "exercise.json": {
      format_version: 1, slug: "max-of-line", style: "io", concepts: ["sh.loops"], difficulty: 1, track: "shell-io@1",
      createdAt: new Date().toISOString(), expected: { "visible/01": "3\n", "hidden/01": "5\n", "hidden/02": "-1\n", "hidden/03": "7\n" },
    },
  });
  const { path } = await app.getExercise(ws, "max-of-line");
  writeFileSync(join(path, "main.sh"), "read -r x; echo $x\n");
  return ws;
}
