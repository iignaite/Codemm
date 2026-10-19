import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FileMap, readFileMap, subMap } from "../../src/files.js";
import { verifyExercise, verifyTrack } from "../../src/gates.js";
import { gradeIoRun, recordOutput } from "../../src/grading.js";
import { judgeSets, runIo } from "../../src/judge.js";
import { cli } from "../../src/sandbox.js";
import { type CourseRecord, parseRoadmapYaml, type TrackRecord } from "../../src/schemas.js";
import { dockerUp, FIXTURES, fixtureTrack } from "./helpers.js";

// Heavy tests (DESIGN §4.3): a million numbers in and out, seconds of CPU per test, and a JVM build tool run offline.
// Each logs how long it took. The JVM track's image is about 600 MB with its Maven cache, so it runs only when asked
// (CODEMM_BIG_IMAGES=1, as CI does) and is removed afterwards.
const bigImages = process.env.CODEMM_BIG_IMAGES === "1";

const course = (name: string): CourseRecord => ({ format_version: 1, course: "demo", ...parseRoadmapYaml(readFileSync(join(FIXTURES, "roadmaps", `${name}.yaml`), "utf8")) });
const exercise = (name: string): FileMap => readFileMap(join(FIXTURES, "exercises", name));
const record = (verified: Awaited<ReturnType<typeof verifyTrack>>): TrackRecord => ({
  format_version: 1, ...verified.spec, image: verified.image, imageId: verified.imageId, installedAt: "now",
});
async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await work();
  console.log(`${label}: ${((performance.now() - started) / 1000).toFixed(1)} s`);
  return result;
}
const statuses = (tests: { status: string }[]) => tests.map((t) => t.status);
const LONG = 900_000;

describe.runIf(dockerUp)("heavy tests (Docker)", () => {
  describe("io: big inputs and outputs, slow cases", () => {
    let heavy: TrackRecord;
    beforeAll(async () => {
      heavy = record(await timed("heavy-io: track install", () => verifyTrack(fixtureTrack("heavy-io").files, "codemm-test-heavy-io:1")));
    }, LONG);

    it("gates an exercise with a million generated numbers in and out, recording the long output by its digest", async () => {
      const r = await timed("prefix-sums (10^6 in and out): exercise gates", () => verifyExercise(heavy, course("heavy-io"), exercise("io-prefix-big"), new Set()));
      expect(r.expected!["visible/01"]).toBe("1\n3\n6\n");
      expect(r.expected!["hidden/03"]).toBe("-5\n");
      const long = r.expected!["hidden/01"] as { sha256: string; bytes: number; head: string };
      expect(long.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(long.bytes).toBeGreaterThan(10_000_000);
      expect(long.head).toHaveLength(65_536);
    }, LONG);

    it("compares all of a long output: a wrong last line out of a million fails", async () => {
      const files = exercise("io-prefix-big");
      const inputs = { "01.gen": subMap(files, "tests/hidden")["01.gen"]! };
      const reference = await timed("prefix-sums: one 10^6 case", () => runIo(heavy, "hidden", subMap(files, "solution"), inputs));
      const expected = { "hidden/01": recordOutput(reference.cases[0]!) };
      expect(statuses(gradeIoRun(reference, expected))).toEqual(["pass"]);
      const lastWrong = "NR == 1 { n = $1; next }\n{ s += $1; print (NR == n + 1 ? s + 1 : s) }\n";
      const wrong = gradeIoRun(await runIo(heavy, "hidden", { "main.awk": lastWrong }, inputs), expected);
      expect(wrong[0]).toMatchObject({ status: "fail", message: expect.stringMatching(/first 64 KB/) });
      expect(wrong[0]!.actual).toHaveLength(65_536);
    }, LONG);

    it("errors a case whose input generator fails, and stops a gate run at its first error", async () => {
      const inputs = { "01.gen": "exit 3\n", "02.in": "1\n", "03.in": "2\n" };
      const all = await runIo(heavy, "visible", { "main.awk": "{ print }\n" }, inputs);
      expect(all.cases.map((c) => [c.name, c.exit, !!c.generator])).toEqual([["visible/01", 3, true], ["visible/02", 0, false], ["visible/03", 0, false]]);
      expect(statuses(gradeIoRun(all, { "visible/01": "", "visible/02": "1", "visible/03": "2" }))).toEqual(["error", "pass", "pass"]);
      // In a check, a generator that passed the gates and fails now is no grade either way: nothing is recorded.
      await expect(judgeSets(heavy, "io", { "main.awk": "{ print }\n" }, { visible: inputs }, { expected: { "visible/01": "", "visible/02": "1", "visible/03": "2" } }))
        .rejects.toThrow(/couldn't be generated, so nothing was recorded/);
      // A program that outlives its time limit on every case: a gate run stops after the first.
      const slow = { ...heavy, limits: { time_ms: 1000, memory_mb: 512 } };
      const sleeper = { "main.awk": "{ system(\"sleep 30\") }\n" };
      const three = { "01.in": "1\n", "02.in": "2\n", "03.in": "3\n" };
      const stopped = await timed("three timeouts, stopping at the first", () => runIo(slow, "visible", sleeper, three, { stopAtError: true }));
      expect(stopped.cases.map((c) => [c.name, !!c.timedOut])).toEqual([["visible/01", true]]);
      const full = await timed("three timeouts, all run", () => runIo(slow, "visible", sleeper, three));
      expect(full.cases).toHaveLength(3);
    }, LONG);

    it("gates a CPU-heavy exercise that takes seconds per test", async () => {
      const files = exercise("io-slow-sum");
      await timed("square-sums (10^6-step loop): one case", () => runIo(heavy, "hidden", subMap(files, "solution"), { "01.in": subMap(files, "tests/hidden")["01.in"]! }));
      const r = await timed("square-sums: exercise gates", () => verifyExercise(heavy, course("heavy-io"), files, new Set()));
      expect(Object.keys(r.expected!)).toEqual(["visible/01", "hidden/01", "hidden/02"]);
      expect(r.expected!["visible/01"]).toBe("9\n");
    }, LONG);
  });

  describe.runIf(bigImages)("unit: a Maven and JUnit track, offline", () => {
    let java: TrackRecord;
    beforeAll(async () => {
      java = record(await timed("java-maven: track install (build and probes)", () => verifyTrack(fixtureTrack("java-maven").files, "codemm-test-java-maven:1")));
    }, LONG);
    afterAll(async () => {
      await cli(["image", "rm", "codemm-test-java-maven:1"]);
    });

    it("gates a unit exercise, every test run offline in the sandbox", async () => {
      const r = await timed("java count-evens: exercise gates", () => verifyExercise(java, course("java-maven"), exercise("java-count-evens"), new Set()));
      expect(r.inventory).toEqual({ visible: ["VisibleTest.countsEvens"], hidden: ["HiddenTest.countsNegativesAndZero", "HiddenTest.emptyHasNone"] });
    }, LONG);
  });
});
