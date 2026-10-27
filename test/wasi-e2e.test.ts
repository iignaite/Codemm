import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as app from "../src/app.js";
import type { FileMap } from "../src/files.js";
import * as store from "../src/store.js";
import { removeTree, setToolchainFetch } from "../src/toolchain.js";
import { tempDir } from "./temp.js";
import { removeHome } from "./toolchains.js";
import { wasmtimeUp } from "./wasi-engine.js";

/**
 * A WASI track end to end on real wasmtime (DESIGN §4.5): installed from a toolchain served through the injected
 * fetch, then an io exercise saved through every gate and checked. Codemm ships no languages, so the toolchain is a
 * language-free module (fixtures/wasi/answer.wat): answer.txt starting with "e" echoes stdin, anything else prints
 * itself.
 */

const MODULE = new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures", "wasi", "answer.wat")));
const SHA = createHash("sha256").update(MODULE).digest("hex");
const URL = "https://example.org/tools/answer.wasm";

const track: FileMap = {
  "track.yaml": `id: answer-wasi\nversion: 1\nstyles: [io]\nfiles: [answer.txt]\nrun: /work/src/answer.txt\nlimits: { time_ms: 3000, memory_mb: 64 }\nwasi: { url: ${URL}, sha256: ${SHA}, module: answer.wasm }\n`,
  "probe/io/pass/answer.txt": "e\n",
  "probe/io/fail/answer.txt": "0\n",
  "probe/io/tests/01.in": "1\n",
  "probe/io/tests/01.out": "1\n",
};

const exercise: FileMap = {
  "exercise.yaml": "slug: echo\nconcepts: [e.basics]\ndifficulty: 1\n",
  "README.md": "# Echo\n\nPrint the input.\n",
  "starter/answer.txt": "todo\n",
  "solution/answer.txt": "e\n",
  "mutants/a/answer.txt": "a\n",
  "mutants/b/answer.txt": "z\n",
  "tests/visible/01.in": "a\n",
  "tests/hidden/01.in": "b\n",
  "tests/hidden/02.in": "c\n",
};

let home: string;
beforeEach(() => {
  home = tempDir("codemm-home-");
  vi.stubEnv("CODEMM_HOME", home);
  setToolchainFetch(async (url) => (url === URL ? new Response(MODULE) : new Response("", { status: 404 })));
});
afterEach(() => {
  removeHome(home);
  vi.unstubAllEnvs();
  setToolchainFetch();
});

describe.skipIf(!wasmtimeUp)("a WASI track on wasmtime", () => {
  it("installs, saves an io exercise through every gate, and checks the learner's solution", async () => {
    const progress: string[] = [];
    await app.proposeTrack(track);
    const { digest, engine } = app.listProposals()[0]!;
    expect(engine).toBe("wasi");
    expect(await app.installProposal("answer-wasi@1", digest, (p) => progress.push(p.phase))).toEqual({ installed: "answer-wasi@1" });
    expect(progress).toEqual(["downloading", "checking"]);
    expect(app.listTracks()).toEqual([{ track: "answer-wasi@1", styles: ["io"], files: ["answer.txt"], engine: "wasi" }]);

    const ws = tempDir("codemm-ws-");
    await app.saveRoadmap(ws, "echo", "goal: Echo\ntrack: answer-wasi@1\nstyle: io\nconcepts:\n  - { id: e.basics, title: Basics, requires: [] }\n");
    expect(await app.saveExercise(ws, exercise)).toEqual({ exercise: "echo" });

    const starter = await app.checkExercise(ws, "echo");
    expect(starter).toMatchObject({ passed: 0, total: 3 });
    writeFileSync(join(ws, "exercises", "echo", "echo", "answer.txt"), "e\n");
    const solved = await app.checkExercise(ws, "echo");
    expect(solved).toMatchObject({ passed: 3, total: 3, recorded: true });
    expect(solved.tests.filter((t) => t.name.startsWith("hidden"))).toEqual([
      { name: "hidden #1", index: 1, status: "pass" },
      { name: "hidden #2", index: 2, status: "pass" },
    ]);
  }, 120_000);

  it("rebuilds a track whose toolchain folder is gone", async () => {
    await app.saveTrack(track);
    removeTree(store.toolchainDir(SHA));
    expect(await app.rebuildTrack("answer-wasi@1")).toEqual({ rebuilt: "answer-wasi@1", exercises: 0 });
  }, 120_000);
});
