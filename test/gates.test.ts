import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFileMap } from "../src/files.js";
import { buildOutput, checkTrackFiles, comparedEarlier, probeFastMs, unitReferenceFailure, unpinnedBases, verifyExercise } from "../src/gates.js";
import type { UnitRun } from "../src/grading.js";
import { type CourseRecord, parseRoadmapYaml, type TrackRecord } from "../src/schemas.js";

const PINNED = "alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc";

describe("comparedEarlier", () => {
  const e = (slug: string, concepts: string[], day: number, style: "io" | "unit" = "io") =>
    ({ slug, style, concepts, createdAt: new Date(Date.UTC(2026, 0, day)).toISOString(), solution: {} });

  it("compares at most 3 earlier exercises on a shared concept and the 3 most recent others, newest first, same style only", () => {
    const pool = [
      e("a1", ["a"], 1), e("a2", ["a"], 2), e("a3", ["a", "b"], 3), e("a4", ["a"], 4),
      e("b1", ["b"], 5), e("c1", ["c"], 6), e("c2", ["c"], 7), e("c3", ["c"], 8), e("u1", ["a"], 9, "unit"),
    ];
    expect(comparedEarlier(pool, "io", ["a"]).map((x) => x.slug)).toEqual(["a4", "a3", "a2", "c3", "c2", "c1"]);
  });
});

describe("unpinnedBases", () => {
  it("accepts base images pinned by digest", () => {
    expect(unpinnedBases(`FROM ${PINNED}\nRUN true\n`)).toEqual([]);
  });

  it("lists base images pinned only by tag, or not at all", () => {
    expect(unpinnedBases("# base\nfrom alpine:3.20\nFROM --platform=linux/amd64 debian AS tools\n")).toEqual(["alpine:3.20", "debian"]);
  });

  it("resolves ARG defaults in FROM", () => {
    expect(unpinnedBases(`ARG BASE=${PINNED}\nARG TAG="alpine:3.20"\nFROM \${BASE}\nFROM $TAG\n`)).toEqual(["alpine:3.20"]);
  });

  it("joins continued lines", () => {
    expect(unpinnedBases(`FROM \\\n  ${PINNED}\nFROM \\\n  alpine:3.20\n`)).toEqual(["alpine:3.20"]);
  });

  it("ignores scratch and earlier build stages", () => {
    expect(unpinnedBases(`FROM ${PINNED} AS build\nFROM scratch\nFROM build\nCOPY --from=build /a /a\n`)).toEqual([]);
  });
});

describe("buildOutput", () => {
  // BuildKit's plain progress, as \`npm ci\` failed in a real track build: the cause comes first, then npm's usage, then
  // BuildKit's summary, which repeats the step's last lines and the Dockerfile.
  const usage = Array.from({ length: 30 }, (_, i) => `#8 3.299 npm error [--option-${i}]`).join("\n");
  const log = [
    "#7 [3/6] COPY package.json package-lock.json ./",
    "#7 DONE 0.0s",
    "",
    "#8 [4/6] RUN npm ci --omit=dev && chmod -R a+rX /opt/track",
    "#8 3.120 npm error code EUSAGE",
    "#8 3.121 npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.",
    usage,
    '#8 ERROR: process "/bin/sh -c npm ci --omit=dev && chmod -R a+rX /opt/track" did not complete successfully: exit code: 1',
    "------",
    " > [4/6] RUN npm ci --omit=dev && chmod -R a+rX /opt/track:",
    ...Array.from({ length: 10 }, (_, i) => `3.299 npm error [--option-${20 + i}]`),
    "------",
    "Dockerfile:4",
    "--------------------",
    "   3 |     COPY package.json package-lock.json ./",
    "   4 | >>> RUN npm ci --omit=dev && chmod -R a+rX /opt/track",
    "--------------------",
    'ERROR: failed to solve: process "/bin/sh -c npm ci --omit=dev" did not complete successfully: exit code: 1',
    "",
    "View build details: docker-desktop://dashboard/build/desktop-linux/desktop-linux/abc",
  ].join("\n");

  it("shows the failing step's own first and last lines, not BuildKit's summary", () => {
    const shown = buildOutput(log);
    expect(shown).toContain("[4/6] RUN npm ci --omit=dev");
    expect(shown).toContain("can only install packages when your package.json and package-lock.json are in sync");
    expect(shown).toContain("npm error [--option-29]");
    expect(shown).toContain("did not complete successfully: exit code: 1");
    expect(shown).not.toContain("Dockerfile:4");
    expect(shown).not.toContain("View build details");
    expect(shown).not.toContain("COPY package.json");
    expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(4096);
  });

  it("keeps a long step's start and end within 4 KB", () => {
    const long = ["#5 [2/2] RUN make", "#5 0.1 first: the real cause", ...Array.from({ length: 500 }, (_, i) => `#5 1.0 ${"x".repeat(100)} ${i}`), "#5 ERROR: process \"make\" did not complete successfully: exit code: 2"].join("\n");
    const shown = buildOutput(long);
    expect(shown).toContain("first: the real cause");
    expect(shown).toContain(" 499");
    expect(shown).toContain("exit code: 2");
    expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(4096);
  });

  it("keeps the cause when the step's command line is longer than the whole budget", () => {
    // An agent's RUN line can install hundreds of packages, and BuildKit repeats the command in its ERROR line.
    const command = `apt-get install -y ${Array.from({ length: 300 }, (_, i) => `package-${i}`).join(" ")}`;
    const long = [`#6 [3/4] RUN ${command}`, "#6 0.5 E: Unable to locate package package-7", ...Array.from({ length: 60 }, (_, i) => `#6 0.6 noise ${i}`), `#6 ERROR: process "/bin/sh -c ${command}" did not complete successfully: exit code: 100`].join("\n");
    const shown = buildOutput(long);
    expect(shown).toContain("Unable to locate package package-7");
    expect(shown).toContain("noise 59");
    expect(shown).toContain("exit code: 100");
    expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(4096);
  });

  it("reads a log with CRLF line endings", () => {
    const crlf = "#5 [2/2] RUN false\r\n#5 0.1 the cause\r\n#5 ERROR: process \"false\" did not complete successfully: exit code: 1\r\n";
    expect(buildOutput(crlf)).toContain("the cause");
  });

  it("shows the end of any other builder's log", () => {
    const legacy = ["Step 1/2 : FROM alpine", "Step 2/2 : RUN false", "The command '/bin/sh -c false' returned a non-zero code: 1"].join("\n");
    expect(buildOutput(legacy)).toBe(legacy);
  });
});

describe("probeFastMs", () => {
  it("gives a new track's pass probe a sixth of time_ms, so every reference (a third) has twice its time", () => {
    expect(probeFastMs({ time_ms: 2000 })).toBe(333);
  });

  it("keeps a third at the ceiling, where time_ms can't be raised, so heavy toolchains still install", () => {
    expect(probeFastMs({ time_ms: 120_000 })).toBe(40_000);
  });

  it("keeps a third on a rebuild: an installed track's files can't change, and its course can't change track", () => {
    expect(probeFastMs({ time_ms: 2000 }, { rebuild: true })).toBe(666);
  });
});

describe("unitReferenceFailure", () => {
  const noReport = [
    { set: "visible" as const, name: "visible/report", status: "error" as const, message: "Traceback: SECRET_REFERENCE_LINE" },
    { set: "hidden" as const, name: "hidden/report", status: "error" as const, message: "SECRET_REFERENCE_LINE" },
  ];
  const run = (over: Partial<UnitRun> = {}, report: Partial<UnitRun["report"]> = {}): UnitRun => ({ report: { exit: 1, body: "", log: "SECRET", ...report }, flooded: false, ...over });

  it("says the runner failed before any test when the reference's report is missing, and what to check, without its output", () => {
    // Recorded with Codex on a Django track: three saves got only "visible/report: error" and repeated the same mistake.
    const message = unitReferenceFailure(noReport, run());
    expect(message).toMatch(/The test runner stopped before reporting any test/);
    expect(message).toMatch(/contract\.examples/);
    expect(message).not.toMatch(/SECRET_REFERENCE_LINE/);
  });

  it.each([
    ["the time limit", run({}, { timedOut: true })],
    ["the memory limit", run({ outOfMemory: true })],
    ["the output limit", run({ flooded: true })],
  ])("says the runner was stopped at %s, not that the tests didn't load", (_, stopped) => {
    const message = unitReferenceFailure(noReport, stopped);
    expect(message).toMatch(/stopped at a time, memory or output limit/);
    expect(message).not.toMatch(/didn't load/);
    expect(message).not.toMatch(/SECRET/);
  });

  it("gives no advice when the runner did report, even a test named report", () => {
    const message = unitReferenceFailure([{ set: "visible", name: "visible/report", status: "error" }, { set: "visible", name: "visible/x", status: "pass" }], run({}, { exit: 0, body: "{}" }));
    expect(message).not.toMatch(/stopped/);
  });

  it("lists statuses only when the runner reported tests", () => {
    const message = unitReferenceFailure([
      { set: "visible", name: "visible/test_a", status: "fail", message: "SECRET" },
      { set: "hidden", name: "hidden/test_b", status: "pass" },
    ], run({}, { exit: 0, body: "{}" }));
    expect(message).toBe("the reference must pass every test:\n  visible/test_a: fail\n  hidden #1: pass");
  });
});

describe("checkTrackFiles", () => {
  const track = () => readFileMap(join(import.meta.dirname, "fixtures", "tracks", "custom-unit"));

  it("accepts a track whose probe is small enough to show authors as an example", () => {
    expect(checkTrackFiles(track()).spec.id).toBe("custom-unit");
  });

  it("refuses a probe example over 64 KB, since every author receives it", () => {
    const big = { ...track(), "probe/unit/tests/sums.check": `${"# padding\n".repeat(7_000)}2 3 => 5\n` };
    expect(() => checkTrackFiles(big)).toThrow(/64 KB/);
  });
});

describe("verifyExercise's io test files", () => {
  const fixtures = join(import.meta.dirname, "fixtures");
  const track: TrackRecord = {
    format_version: 1, id: "shell-io", version: 1, styles: ["io"], files: ["main.sh"], run: "sh main.sh",
    limits: { time_ms: 2000, memory_mb: 128 }, image: "codemm-track-shell-io:1", imageId: "sha256:none", installedAt: "now",
  };
  const course: CourseRecord = { format_version: 1, course: "demo", ...parseRoadmapYaml(readFileSync(join(fixtures, "roadmaps", "shell-io.yaml"), "utf8")) };
  const files = () => readFileMap(join(fixtures, "exercises", "io-max"));
  // These are refused before anything runs, so no container runtime is needed.
  const verify = (extra: Record<string, string>) => verifyExercise(track, course, { ...files(), ...extra }, new Set());

  it("refuses an expected output or any other file beside the NN.in inputs and NN.gen generators", async () => {
    await expect(verify({ "tests/visible/02.out": "3\n" })).rejects.toThrow(/may only hold NN.in inputs and NN.gen input generators[\s\S]*Remove: 02.out/);
    await expect(verify({ "tests/hidden/gen.sh": "echo 1\n" })).rejects.toThrow(/Remove: 1 file\(s\)/);
  });

  it("refuses an input given both ways, without naming a hidden one", async () => {
    await expect(verify({ "tests/visible/01.gen": "echo 1 2 3\n" })).rejects.toThrow(/both NN.in and NN.gen for 01\./);
    const hidden = verify({ "tests/hidden/02.gen": "echo 1 2 3\n" });
    await expect(hidden).rejects.toThrow(/both NN.in and NN.gen for 1 test\(s\)/);
    await expect(hidden).rejects.not.toThrow(/02/);
  });
});
