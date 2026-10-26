import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as app from "../src/app.js";
import { ensureImage } from "../src/app/shared.js";
import { CodemmError } from "../src/errors.js";
import type { FileMap } from "../src/files.js";
import { checkTrackFiles, type TrackProgress, verifyExercise, verifyTrack } from "../src/gates.js";
import * as judge from "../src/judge.js";
import type { JudgeTrack } from "../src/judge.js";
import * as sandbox from "../src/sandbox.js";
import { type CourseRecord, parseRoadmapYaml, type TrackRecord } from "../src/schemas.js";
import * as store from "../src/store.js";
import { removeTree, setToolchainFetch } from "../src/toolchain.js";
import * as wasi from "../src/wasi.js";
import { tempDir } from "./temp.js";

/**
 * WASI tracks (DESIGN §4.5) without wasmtime: the judge is stood in for by a tiny interpreter of the learner file
 * (`echo` prints the input, `fixed N` prints N), and the toolchain is served by a stubbed fetch.
 */
vi.mock("../src/judge.js", async (original) => ({
  ...(await original<typeof import("../src/judge.js")>()),
  runSets: vi.fn(async (_track: JudgeTrack, _style: string, src: FileMap, sets: Record<string, FileMap | undefined>) => {
    const program = (src["answer.txt"] ?? "").trim();
    const out = (input: string) => (program === "echo" ? input : `${program.replace(/^fixed /, "")}\n`);
    return Object.fromEntries(Object.entries(sets).flatMap(([set, tests]) => (tests ? [[set, {
      flooded: false,
      cases: Object.keys(tests).sort().map((p) => ({ name: `${set}/${p.replace(/\.in$/, "")}`, exit: 0, stdout: out(tests[p]!), stderr: "" })),
    }]] : [])));
  }),
}));
vi.mock("../src/wasi.js", () => ({ wasmtimePath: vi.fn(() => "wasmtime") }));
vi.mock("../src/sandbox.js", async (original) => ({
  ...(await original<typeof import("../src/sandbox.js")>()),
  containerCli: vi.fn(() => "docker"),
  missingBaseImages: vi.fn(async () => []),
  cli: vi.fn(async () => ({ exit: 0, output: "" })),
  assertRuntime: vi.fn(async () => undefined),
  inspectImage: vi.fn(async () => undefined),
}));

const MODULE = new TextEncoder().encode("\0asm a stand-in toolchain");
const SHA = createHash("sha256").update(MODULE).digest("hex");
const URL = "https://example.org/tools/echo.wasm";

const track = (wasiBlock = `{ url: ${URL}, sha256: ${SHA}, module: echo.wasm, env: { MODE: plain } }`): FileMap => ({
  "track.yaml": `id: echo-wasi\nversion: 1\nstyles: [io]\nfiles: [answer.txt]\nrun: /work/src/answer.txt\nwasi: ${wasiBlock}\n`,
  "probe/io/pass/answer.txt": "echo\n",
  "probe/io/fail/answer.txt": "fixed 0\n",
  "probe/io/tests/01.in": "1\n",
  "probe/io/tests/01.out": "1\n",
});

const exercise = (extra: FileMap = {}): FileMap => ({
  "exercise.yaml": "slug: echo\nconcepts: [e.basics]\ndifficulty: 1\n",
  "README.md": "Print the input.\n",
  "starter/answer.txt": "fixed 0\n",
  "solution/answer.txt": "echo\n",
  "mutants/a/answer.txt": "fixed 1\n",
  "mutants/b/answer.txt": "fixed 9\n",
  "tests/visible/01.in": "1\n",
  "tests/hidden/01.in": "2\n",
  "tests/hidden/02.in": "3\n",
  ...extra,
});

const ROADMAP = "goal: Echo\ntrack: echo-wasi@1\nstyle: io\nconcepts:\n  - { id: e.basics, title: Basics, requires: [] }\n";

let downloads = 0;
let home: string;
beforeEach(() => {
  home = tempDir("codemm-home-");
  vi.stubEnv("CODEMM_HOME", home);
  downloads = 0;
  setToolchainFetch(async (url) => {
    downloads += 1;
    return url === URL ? new Response(MODULE) : new Response("", { status: 404 });
  });
  vi.mocked(judge.runSets).mockClear();
  vi.mocked(sandbox.cli).mockClear();
  vi.mocked(sandbox.missingBaseImages).mockClear();
});
afterEach(() => {
  removeTree(home);
  vi.unstubAllEnvs();
  setToolchainFetch();
  vi.mocked(wasi.wasmtimePath).mockImplementation(() => "wasmtime");
  vi.mocked(sandbox.containerCli).mockImplementation(() => "docker");
});

describe("checkTrackFiles", () => {
  it("accepts a wasi block in place of a Dockerfile", () => {
    expect(checkTrackFiles(track()).spec.wasi?.module).toBe("echo.wasm");
  });

  it("refuses both engines, or neither", () => {
    expect(() => checkTrackFiles({ ...track(), Dockerfile: "FROM scratch\n" })).toThrow(/Gate "valid"[\s\S]*not both/);
    const yaml = track()["track.yaml"]!.replace(/wasi: .*\n/, "");
    expect(() => checkTrackFiles({ ...track(), "track.yaml": yaml })).toThrow(/Gate "valid"[\s\S]*Dockerfile, or a wasi block/);
  });
});

describe("verifyTrack on a WASI track", () => {
  it("downloads the toolchain, then runs the probes on it, with no Docker", async () => {
    const progress: TrackProgress[] = [];
    const verified = await verifyTrack(track(), undefined, (p) => progress.push(p));
    expect(progress).toEqual([{ phase: "downloading" }, { phase: "checking" }]);
    expect(verified).toMatchObject({ wasi: { sha256: SHA, module: "echo.wasm", dirs: {}, env: { MODE: "plain" } } });
    expect(verified).not.toHaveProperty("imageId");
    const ran = vi.mocked(judge.runSets).mock.calls[0]![0];
    expect(ran).toMatchObject({ image: "", run: "/work/src/answer.txt", wasi: { root: store.toolchainDir(SHA), module: "echo.wasm", dirs: {}, env: { MODE: "plain" } } });
    expect(sandbox.cli).not.toHaveBeenCalled();
  });

  it("fails gate toolchain on a toolchain whose digest doesn't match, naming both", async () => {
    const wrong = "ab".repeat(32);
    await expect(verifyTrack(track(`{ url: ${URL}, sha256: ${wrong}, module: echo.wasm }`))).rejects.toThrow(new RegExp(`Gate "toolchain" failed: wasi.sha256 is ${wrong}, but [\\s\\S]*${SHA}`));
    expect(judge.runSets).not.toHaveBeenCalled();
  });

  it("records the digest it downloaded when the track gives none, with a warning", async () => {
    const verified = await verifyTrack(track(`{ url: ${URL}, module: echo.wasm }`));
    expect(verified).toMatchObject({ wasi: { sha256: SHA }, warning: expect.stringContaining(`wasi.sha256: ${SHA}`) });
  });

  it("passes a network failure on as this computer's, not a gate", async () => {
    setToolchainFetch(async () => new Response("", { status: 503 }));
    await expect(verifyTrack(track())).rejects.toMatchObject({ code: "offline", message: expect.not.stringMatching(/Gate/) });
  });

  it("refuses before downloading anything when this computer has no wasmtime", async () => {
    vi.mocked(wasi.wasmtimePath).mockImplementation(() => undefined);
    await expect(verifyTrack(track())).rejects.toMatchObject({ code: "no-wasmtime" });
    expect(downloads).toBe(0);
  });
});

describe("a WASI track's exercises", () => {
  const record = (): TrackRecord => ({
    format_version: 1, id: "echo-wasi", version: 1, styles: ["io"], files: ["answer.txt"], run: "/work/src/answer.txt",
    limits: { time_ms: 2000, memory_mb: 256 }, wasi: { sha256: SHA, module: "echo.wasm", dirs: {}, env: {} }, installedAt: "now",
  });
  const course: CourseRecord = { format_version: 1, course: "echo", ...parseRoadmapYaml(ROADMAP) };

  it("run on the track's toolchain", async () => {
    const saved = await verifyExercise(record(), course, exercise(), new Set());
    expect(saved.expected).toEqual({ "visible/01": "1\n", "hidden/01": "2\n", "hidden/02": "3\n" });
    expect(vi.mocked(judge.runSets).mock.calls[0]![0].wasi?.root).toBe(store.toolchainDir(SHA));
  });

  it("can't use input generators, which need sh", async () => {
    await expect(verifyExercise(record(), course, exercise({ "tests/hidden/03.gen": "echo 4\n" }), new Set())).rejects.toThrow(/Gate "valid"[\s\S]*no input generators[\s\S]*NN.in/);
    expect(judge.runSets).not.toHaveBeenCalled();
  });

  it("need the toolchain folder, else a rebuild", async () => {
    await expect(ensureImage(record())).rejects.toMatchObject({ kind: "image-missing", message: expect.stringMatching(/codemm track rebuild echo-wasi@1/) });
    await verifyTrack(track());
    await expect(ensureImage(record())).resolves.toBeUndefined();
  });
});

describe("installing a WASI track", () => {
  it("records its toolchain and no image, and lists its engine", async () => {
    expect(await app.saveTrack(track())).toEqual({ installed: "echo-wasi@1" });
    const saved = store.readTrack("echo-wasi@1")!;
    expect(saved.wasi).toEqual({ sha256: SHA, module: "echo.wasm", dirs: {}, env: { MODE: "plain" } });
    expect(saved).not.toHaveProperty("image");
    expect(saved).not.toHaveProperty("url");
    expect(app.listTracks()).toEqual([{ track: "echo-wasi@1", styles: ["io"], files: ["answer.txt"], engine: "wasi" }]);
  });

  it("proposes one without asking a registry, and installs it on consent", async () => {
    expect(await app.proposeTrack(track())).toMatchObject({ proposed: "echo-wasi@1" });
    expect(sandbox.missingBaseImages).not.toHaveBeenCalled();
    expect(app.listProposals()).toMatchObject([{ track: "echo-wasi@1", engine: "wasi" }]);
    expect(downloads).toBe(1);
    const { digest } = app.listProposals()[0]!;
    const progress: unknown[] = [];
    expect(await app.installProposal("echo-wasi@1", digest, (p) => progress.push(p))).toEqual({ installed: "echo-wasi@1" });
    expect(progress).toEqual([{ phase: "downloading" }, { phase: "checking" }]);
  });

  it("refuses to propose a track whose toolchain the server says isn't there", async () => {
    const gone = track(`{ url: https://example.org/tools/gone.wasm, module: gone.wasm }`);
    await expect(app.proposeTrack(gone)).rejects.toThrow(/https:\/\/example.org\/tools\/gone.wasm[\s\S]*isn't there/);
    expect(app.listProposals()).toEqual([]);
    // An answer it can't get refuses nothing.
    setToolchainFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(app.proposeTrack(gone)).resolves.toMatchObject({ proposed: "echo-wasi@1" });
  });

  it("still lists a proposal whose track.yaml was damaged on disk", async () => {
    await app.proposeTrack(track());
    const { digest } = app.listProposals()[0]!;
    writeFileSync(join(home, "proposals", "echo-wasi@1", digest, "files", "track.yaml"), "id: [");
    expect(app.listProposals()).toMatchObject([{ track: "echo-wasi@1", engine: "wasi" }]);
  });

  it("tells authors the track's engine", async () => {
    await app.saveTrack(track());
    const ws = tempDir("codemm-ws-");
    await app.saveRoadmap(ws, "echo", ROADMAP);
    expect(app.nextStep(ws)).toMatchObject({ kind: "author", contract: { engine: "wasi", run: "/work/src/answer.txt" } });
  });

  it("refuses a Docker track on a computer with wasmtime and no container runtime", async () => {
    vi.mocked(sandbox.containerCli).mockImplementation(() => {
      throw new CodemmError("No container runtime found.", "docker", "no-runtime");
    });
    const docker = { ...track(), "track.yaml": track()["track.yaml"]!.replace(/wasi: .*\n/, ""), Dockerfile: "FROM scratch\n" };
    await expect(app.saveTrack(docker)).rejects.toThrow(/no container runtime[\s\S]*WASI track/);
    await expect(app.proposeTrack(docker)).rejects.toThrow(/no container runtime[\s\S]*WASI track/);
    expect(app.listProposals()).toEqual([]);
    // With neither engine, the Docker track goes on, to fail with Docker's own advice.
    vi.mocked(wasi.wasmtimePath).mockImplementation(() => undefined);
    await expect(app.proposeTrack(docker)).resolves.toMatchObject({ proposed: "echo-wasi@1" });
  });

  it("rebuilds by downloading the toolchain again, repairing a damaged folder, with no docker tag", async () => {
    await app.saveTrack(track(`{ url: ${URL}, module: echo.wasm }`));
    removeTree(join(store.toolchainDir(SHA), "echo.wasm"));
    expect(await app.rebuildTrack("echo-wasi@1")).toEqual({ rebuilt: "echo-wasi@1", exercises: 0 });
    expect(existsSync(join(store.toolchainDir(SHA), "echo.wasm"))).toBe(true);
    expect(sandbox.cli).not.toHaveBeenCalled();
  });

  it("rebuilds only to the digest it recorded", async () => {
    await app.saveTrack(track(`{ url: ${URL}, module: echo.wasm }`));
    setToolchainFetch(async () => new Response("another file"));
    await expect(app.rebuildTrack("echo-wasi@1")).rejects.toThrow(new RegExp(`Gate "toolchain"[\\s\\S]*${SHA}`));
  });

  it("rebuilds a missing toolchain and re-checks every exercise", async () => {
    await app.saveTrack(track());
    const ws = tempDir("codemm-ws-");
    await app.saveRoadmap(ws, "echo", ROADMAP);
    await app.saveExercise(ws, exercise());
    removeTree(store.toolchainsDir());
    await expect(app.checkExercise(ws, "echo")).rejects.toMatchObject({ kind: "image-missing" });
    const before = downloads;
    expect(await app.rebuildTrack("echo-wasi@1")).toEqual({ rebuilt: "echo-wasi@1", exercises: 1 });
    expect(downloads).toBe(before + 1);
    expect(existsSync(store.toolchainDir(SHA))).toBe(true);
    expect(sandbox.cli).not.toHaveBeenCalled();
    expect(store.readTrack("echo-wasi@1")!.wasi?.sha256).toBe(SHA);
  });
});
