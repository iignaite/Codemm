import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProgramOptions, runProgram } from "../src/program.js";
import { tempDir } from "./temp.js";
import { wasiTrack, wasmtimeUp } from "./wasi-engine.js";

/** Run on the WASI engine (DESIGN §4.5): the learner's program, interactively, on wasmtime. */

const src = { "main.txt": "learner file" };

function run(fixture: string, opts: ProgramOptions = {}) {
  const out: { text: string; stream: string }[] = [];
  const program = runProgram(wasiTrack(fixture), src, (text, stream) => out.push({ text, stream }), opts);
  const shown = (stream: string) => out.filter((o) => o.stream === stream).map((o) => o.text).join("");
  return { program, shown };
}

describe("Run on a WASI track without wasmtime", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is an infrastructure error", () => {
    vi.stubEnv("CODEMM_WASMTIME", `${tempDir()}/no-wasmtime`);
    expect(() => run("cat")).toThrow(expect.objectContaining({ code: "no-wasmtime" }));
  });
});

describe.skipIf(!wasmtimeUp)("Run on a WASI track", () => {
  it("sends typed input to the program and its output back, and says when the run starts", async () => {
    const starts: [string, number][] = [];
    const { program, shown } = run("cat", { onStart: (stage, limit) => starts.push([stage, limit]) });
    expect(program.write("hi there\n")).toBe(true);
    program.end();
    expect(await program.done).toEqual({ exit: 0, stage: "run", timedOut: false, flooded: false });
    expect(shown("stdout")).toBe("hi there\n");
    expect(starts).toEqual([["run", 120_000]]);
  });

  it("names the learner's files as they know them in errors, and reports the program's own exit code", async () => {
    const { program, shown } = run("fail");
    expect(await program.done).toEqual({ exit: 3, stage: "run", timedOut: false, flooded: false });
    expect(shown("stderr")).toBe("boom in main.txt\n");
  });

  it("stops at the time limit, with nothing from wasmtime on the learner's screen", async () => {
    const { program, shown } = run("loop", { limitMs: 300 });
    expect(await program.done).toMatchObject({ stage: "run", timedOut: true, flooded: false });
    expect(shown("stderr")).toBe("");
  });

  it("stops a program waiting for typing at the time limit", async () => {
    const { program } = run("cat", { limitMs: 300 });
    expect(await program.done).toMatchObject({ timedOut: true });
  });

  it("stops a program that prints too much", async () => {
    const { program } = run("flood");
    expect(await program.done).toMatchObject({ flooded: true, timedOut: false });
  });

  it("stops when the learner stops it", async () => {
    const { program } = run("cat");
    program.kill();
    expect(await program.done).toMatchObject({ stopped: true, timedOut: false, flooded: false });
  });
});
