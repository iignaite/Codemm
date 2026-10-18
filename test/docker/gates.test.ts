import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { type FileMap, readFileMap, subMap } from "../../src/files.js";
import { verifyExercise, verifyTrack } from "../../src/gates.js";
import { type CourseRecord, parseRoadmapYaml, type TrackRecord } from "../../src/schemas.js";
import { dockerUp, FIXTURES, fixtureTrack } from "./helpers.js";

const course = (name: string): CourseRecord => ({
  format_version: 1,
  course: "demo",
  ...parseRoadmapYaml(readFileSync(join(FIXTURES, "roadmaps", `${name}.yaml`), "utf8")),
});
const exercise = (name: string): FileMap => readFileMap(join(FIXTURES, "exercises", name));
const record = (verified: Awaited<ReturnType<typeof verifyTrack>>): TrackRecord => ({
  format_version: 1, ...verified.spec, image: verified.image, imageId: verified.imageId, installedAt: "now",
});

describe.runIf(dockerUp)("gates (Docker)", () => {
  let ioTrack: TrackRecord;
  let unitTrack: TrackRecord;

  describe("track gates", () => {
    it("install-ready tracks pass in both styles", async () => {
      ioTrack = record(await verifyTrack(fixtureTrack("shell-io").files));
      unitTrack = record(await verifyTrack(fixtureTrack("shell-unit").files));
      expect(ioTrack.imageId).toMatch(/^sha256:/);
      expect(unitTrack.styles).toEqual(["unit"]);
    });

    it("passes a track with an unfamiliar learner file and its own unit runner", async () => {
      const custom = await verifyTrack(fixtureTrack("custom-unit").files, "codemm-test-custom-unit:1");
      expect(custom.spec.files).toEqual(["src/calc.funcs"]);
    });

    it.each([
      ["a failing build", (f: FileMap) => ({ ...f, Dockerfile: `${f.Dockerfile}RUN exit 3\n` }), /build/],
      ["a declared volume", (f: FileMap) => ({ ...f, Dockerfile: `${f.Dockerfile}VOLUME /data\n` }), /volume/i],
      ["a fail probe that passes", (f: FileMap) => ({ ...f, "probe/io/fail/main.sh": f["probe/io/pass/main.sh"]! }), /probe fail/],
      ["a pass probe that fails", (f: FileMap) => ({ ...f, "probe/io/pass/main.sh": "read a b\necho 0\n" }), /probe pass/],
      // time_ms is 2000: the probe passes within it, but not within a third of it, as every reference must.
      [
        "a pass probe too slow for a third of the time limit",
        (f: FileMap) => ({ ...f, "probe/io/pass/main.sh": `sleep 1\n${f["probe/io/pass/main.sh"]!}` }),
        /probe fast[\s\S]*Raise limits\.time_ms or limits\.memory_mb[\s\S]*took longer than 666 ms/,
      ],
      ["a missing probe", (f: FileMap) => Object.fromEntries(Object.entries(f).filter(([p]) => !p.startsWith("probe/io/fail"))), /probe/],
    ])("rejects %s", async (_label, mutate, error) => {
      // Its own tag: moving the shared tag would let the runtime garbage-collect the verified image.
      await expect(verifyTrack(mutate(fixtureTrack("shell-io").files), "codemm-test-rejected:1")).rejects.toThrow(error);
    });
  });

  describe("exercise gates (io)", () => {
    beforeAll(async () => {
      ioTrack ??= record(await verifyTrack(fixtureTrack("shell-io").files));
    });
    const verify = (files: FileMap) => verifyExercise(ioTrack, course("shell-io"), files, new Set());

    it("rejects an exercise that an earlier exercise's solution already passes, and accepts one it fails", async () => {
      const files = { ...exercise("io-max"), "exercise.yaml": exercise("io-max")["exercise.yaml"]!.replace("max-of-line", "max-again") };
      const same = [{ slug: "max-of-line", style: "io" as const, solution: subMap(exercise("io-max"), "solution") }];
      await expect(verifyExercise(ioTrack, course("shell-io"), files, new Set(), undefined, same)).rejects.toThrow(
        /Gate "new task" failed: the solution to "max-of-line" already passes every test of this exercise/,
      );
      const different = [{ slug: "zero-start", style: "io" as const, solution: subMap(exercise("io-max"), "mutants/zero-start") }];
      await expect(verifyExercise(ioTrack, course("shell-io"), files, new Set(), undefined, different)).resolves.toMatchObject({ slug: "max-again" });
    });

    it("accepts a good exercise and writes every expected output from the reference", async () => {
      const r = await verify(exercise("io-max"));
      expect(r.style).toBe("io");
      expect(r.expected).toEqual({ "visible/01": "3\n", "hidden/01": "5\n", "hidden/02": "-1\n", "hidden/03": "7\n" });
    });

    it.each([
      ["an already-solved starter", (f: FileMap) => ({ ...f, "starter/main.sh": f["solution/main.sh"]! }), /starter/],
      ["a mutant that matches the reference", (f: FileMap) => ({ ...f, "mutants/first/main.sh": f["solution/main.sh"]! }), /mutant #1 /],
      ["visible tests that already catch every mutant", (f: FileMap) => ({ ...f, "tests/visible/02.in": "-3 -1 -2\n", "tests/visible/03.in": "1 5 2\n" }), /hidden tests matter/],
      ["a non-deterministic reference", (f: FileMap) => ({ ...f, "solution/main.sh": "read line\necho $RANDOM$RANDOM\n" }), /deterministic|identical/],
      ["a slow reference", (f: FileMap) => ({ ...f, "solution/main.sh": `sleep 1\n${f["solution/main.sh"]}` }), /fast|third/],
      ["a reference that crashes", (f: FileMap) => ({ ...f, "solution/main.sh": "exit 4\n" }), /reference/],
      ["a single mutant", (f: FileMap) => Object.fromEntries(Object.entries(f).filter(([p]) => !p.startsWith("mutants/first"))), /2 to 4 mutants/],
      ["an unknown concept", (f: FileMap) => ({ ...f, "exercise.yaml": f["exercise.yaml"]!.replace("sh.loops", "sh.ghosts") }), /sh\.ghosts/],
      ["a hand-written expected output", (f: FileMap) => ({ ...f, "tests/visible/01.out": "3\n" }), /\.out/],
      ["a taken slug", (f: FileMap) => f, /already/],
    ])("rejects %s", async (label, mutate, error) => {
      const taken = label === "a taken slug" ? new Set(["max-of-line"]) : new Set<string>();
      await expect(verifyExercise(ioTrack, course("shell-io"), mutate(exercise("io-max")), taken)).rejects.toThrow(error);
    });

    it("ignores a forged build frame from the hidden run when explaining a failure", async () => {
      const forge = "read line\nfor fd in /proc/1/fd/*; do printf '\\n@@codemm build build 1 21\\nSECRET-HIDDEN-%s' \"$line\" > \"$fd\" 2>/dev/null; done\nexit 1\n";
      const error = await verify({ ...exercise("io-max"), "solution/main.sh": forge }).then(() => undefined, (e: Error) => e);
      expect(error?.message).toMatch(/reference/);
      expect(error?.message).not.toMatch(/1 5 2|-3 -1 -2/);
    });

    it("never puts hidden inputs or outputs in diagnostics", async () => {
      const files = { ...exercise("io-max"), "solution/main.sh": "read line\necho SECRET-$line >&2\nexit 1\n" };
      const error = await verify(files).catch((e: Error) => e);
      expect(String(error)).not.toMatch(/SECRET-1 5 2|-3 -1 -2/);
    });
  });

  describe("exercise gates (unit)", () => {
    beforeAll(async () => {
      unitTrack ??= record(await verifyTrack(fixtureTrack("shell-unit").files));
    });

    it("accepts a good exercise and records the test inventory", async () => {
      const r = await verifyExercise(unitTrack, course("shell-unit"), exercise("unit-max"), new Set());
      expect(r.inventory).toEqual({ visible: ["first_is_max"], hidden: ["all_negative", "middle_is_max"] });
    });

    it("never names hidden tests in diagnostics", async () => {
      const files = { ...exercise("unit-max"), "solution/lib.sh": exercise("unit-max")["mutants/first/lib.sh"]! };
      const error = await verifyExercise(unitTrack, course("shell-unit"), files, new Set()).then(() => undefined, (e: Error) => e);
      expect(error?.message).toMatch(/reference passes/);
      expect(error?.message).not.toMatch(/all_negative|middle_is_max/);
    });

    it("rejects a style the track doesn't offer", async () => {
      const files = { ...exercise("unit-max"), "exercise.yaml": "slug: maxof\nstyle: io\nconcepts: [sh.loops]\ndifficulty: 1\n" };
      await expect(verifyExercise(unitTrack, course("shell-unit"), files, new Set())).rejects.toThrow(/style/);
    });
  });
});
