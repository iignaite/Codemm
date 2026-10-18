import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as app from "../src/app.js";
import { readFileMap } from "../src/files.js";
import { runMarkers, runProgram } from "../src/judge.js";
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
    const out = { stdout: "", stderr: "" };
    const run = await app.runInteractive(ws, undefined, undefined, (text, stream) => (out[stream] += text));
    run.write("Ada\n");
    expect(await run.done).toMatchObject({ exit: 0, timedOut: false, flooded: false });
    expect(out).toEqual({ stdout: "name? hello Ada\n", stderr: "a warning\n" });
    expect(store.readEvents("shell")).toEqual([]);
  });

  it("stops the program when asked", async () => {
    const ws = await installedExercise();
    fakeDocker("waits");
    const run = await app.runInteractive(ws, undefined, undefined, () => undefined);
    run.kill();
    expect(await run.done).toMatchObject({ stopped: true, timedOut: false });
  });

  it("stops a program that runs past the time limit", async () => {
    const ws = await installedExercise();
    // No build step, so the host deadline is the run limit plus a little (the fake ignores `timeout`).
    store.writeTrackRecord("shell-io@1", { ...store.readTrack("shell-io@1")!, build: undefined } as never);
    fakeDocker("waits");
    const run = await app.runInteractive(ws, undefined, undefined, () => undefined, { limitMs: 300 });
    expect(await run.done).toMatchObject({ timedOut: true });
  });

  it("knows a timeout from the driver's deadline marker, not from timing or an exit code: build or run", async () => {
    const ws = await installedExercise();
    const result = async (scenario: Parameters<typeof fakeDocker>[0]) => {
      fakeDocker(scenario);
      return (await app.runInteractive(ws, undefined, undefined, () => undefined)).done;
    };
    expect(await result("quickkill")).toMatchObject({ exit: 137, stage: "run", timedOut: false });
    expect(await result("exits138")).toMatchObject({ exit: 138, stage: "run", timedOut: false });
    expect(await result("timesout")).toMatchObject({ stage: "run", timedOut: true });
    expect(await result("buildtimesout")).toMatchObject({ stage: "build", timedOut: true });
  });

  it("says the program ran out of memory when the runtime killed it for memory, though the driver went on", async () => {
    const ws = await installedExercise();
    fakeDocker("childoom");
    const run = await app.runInteractive(ws, undefined, undefined, () => undefined);
    expect(await run.done).toMatchObject({ exit: 137, outOfMemory: true, timedOut: false });
  });

  it("reports what the program printed and its exit code as its own, even when they look like Docker's", async () => {
    const ws = await installedExercise();
    fakeDocker("forges");
    let err = "";
    const run = await app.runInteractive(ws, undefined, undefined, (text, stream) => stream === "stderr" && (err += text));
    expect(await run.done).toMatchObject({ exit: 125, timedOut: false });
    expect(err).toBe("error waiting for container: unexpected EOF\n");
  });

  it("says the program ran out of memory when the runtime killed its container for it", async () => {
    const ws = await installedExercise();
    fakeDocker("oom");
    const run = await app.runInteractive(ws, undefined, undefined, () => undefined);
    expect(await run.done).toMatchObject({ outOfMemory: true });
  });

  it("reports a program's own exit 124 as its exit, not a timeout", async () => {
    const ws = await installedExercise();
    fakeDocker("exits124");
    const run = await app.runInteractive(ws, undefined, undefined, () => undefined);
    expect(await run.done).toMatchObject({ exit: 124, timedOut: false });
  });

  it("bounds typed input a program isn't reading, instead of buffering it without limit", async () => {
    const ws = await installedExercise();
    fakeDocker("ignores");
    const run = await app.runInteractive(ws, undefined, undefined, () => undefined);
    const line = "x".repeat(1023) + "\n";
    let accepted = 0;
    for (let i = 0; i < 4096; i++) if (run.write(line)) accepted++;
    expect(accepted).toBeLessThan(4096);
    expect(run.write("y".repeat(100_000))).toBe(false); // one write is bounded too
    run.kill();
    await run.done;
    expect(run.write("after\n")).toBe(false);
  });

  it("keeps characters split across output chunks whole", async () => {
    const ws = await installedExercise();
    fakeDocker("euro");
    let out = "";
    const run = await app.runInteractive(ws, undefined, undefined, (text) => (out += text));
    await run.done;
    expect(out).toBe("€\n");
  });

  it("treats a dropped connection to Docker as an infrastructure failure, not a program result", async () => {
    const ws = await installedExercise();
    fakeDocker("drops");
    const run = await app.runInteractive(ws, undefined, undefined, () => undefined);
    await expect(run.done).rejects.toThrow(/container runtime/i);
  });

  it("leaves no temporary folder behind, whatever happens", async () => {
    const ws = await installedExercise();
    // A temp folder of its own: other test runs on the machine make codemm-run- folders too.
    const own = mkdtempSync(join(tmpdir(), "codemm-test-tmp-"));
    for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, own);
    const runs = () => readdirSync(own).filter((f) => f.startsWith("codemm-run-"));
    fakeDocker("interactive");
    const ok = await app.runInteractive(ws, undefined, undefined, () => undefined);
    ok.write("Ada\n");
    await ok.done;
    fakeDocker("drops");
    await (await app.runInteractive(ws, undefined, undefined, () => undefined)).done.catch(() => undefined);
    fakeDocker("missing");
    expect(() => runProgram({ image: "img", run: "sh main.sh", limits: { time_ms: 1000, memory_mb: 64 } }, { "main.sh": "" }, () => undefined)).toThrow();
    expect(runs()).toEqual([]);
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

describe.runIf(posix)("live lesson examples", () => {
  /** Writes a lesson whose examples were already checked, as save_lesson stores it. */
  const lesson = (examples: Record<string, string>[], style: "io" | "unit" = "io") =>
    store.writeLesson("shell", { format_version: 1, id: "echo", concept: "sh.basics", title: "Echo", created: new Date().toISOString(), examples: examples.length, track: "shell-io@1", style }, "```example\n1\n```\n", examples);

  it("runs an io example live with the learner's input, and records nothing", async () => {
    const ws = await installedExercise();
    lesson([{ "main.sh": "read -r x; echo $x\n" }]);
    fakeDocker("interactive");
    const out = { stdout: "", stderr: "" };
    const run = await app.runExampleLive(ws, "echo", 1, (text, stream) => (out[stream] += text));
    run.write("Ada\n");
    expect(await run.done).toMatchObject({ exit: 0, timedOut: false });
    expect(out.stdout).toContain("hello Ada");
    expect(store.readEvents("shell")).toEqual([]);
  });

  it("refuses a missing example, a unit example (which runs as tests), and files that no longer fit the track", async () => {
    const ws = await installedExercise();
    fakeDocker("interactive");
    lesson([{ "main.sh": "echo 1\n" }], "unit");
    await expect(app.runExampleLive(ws, "echo", 2, () => undefined)).rejects.toThrow(/no example 2/);
    await expect(app.runExampleLive(ws, "echo", 1, () => undefined)).rejects.toThrow(/runs as tests/);
    rmSync(store.lessonDir("shell", "echo"), { recursive: true });
    lesson([{ "other.sh": "echo 1\n" }]);
    await expect(app.runExampleLive(ws, "echo", 1, () => undefined)).rejects.toThrow(/exactly the track's learner files/);
  });
});

describe("Run's driver markers", () => {
  const feed = (chunks: string[]) => {
    let text = "";
    const marks: string[] = [];
    const f = runMarkers((t) => (text += t), (m) => marks.push(m.join(" ")));
    for (const c of chunks) f.write(c);
    f.end();
    return { text, marks };
  };
  // What the driver adds is exactly "\n@@codemm-run <fields>\n"; the rest is the program's own stderr.
  const stream = "warn\n" + "\n@@codemm-run start run\n" + "oops: no newline" + "\n@@codemm-run end run 3\n";

  it("passes the program's stderr through and takes out the driver's markers, however it's split", () => {
    const want = { text: "warn\noops: no newline", marks: ["start run", "end run 3"] };
    expect(feed([stream])).toEqual(want);
    for (let at = 1; at < stream.length; at++) expect(feed([stream.slice(0, at), stream.slice(at)])).toEqual(want);
  });

  it("holds back only what could still become a marker, and lets it go at the end", () => {
    expect(feed(["prompt> \n@@codemm"]).text).toBe("prompt> \n@@codemm");
    expect(feed(["a", "\n", "@", "b"]).text).toBe("a\n@b");
  });
});
