import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type JudgeTrack, runIo, runUnit } from "../../src/judge.js";
import { runProgram } from "../../src/program.js";
import { buildFixture, dockerUp, fixtureTrack, recordMounts, subMap } from "./helpers.js";
import { tempDir } from "../temp.js";

/** Where a check's files are staged (DESIGN §4.3): engines like Colima share the home folder, not /var/folders. */
describe.runIf(dockerUp)("run folders (Docker)", () => {
  let ioTrack: JudgeTrack;
  let unitTrack: JudgeTrack;
  let home: string;
  let recorder: ReturnType<typeof recordMounts>;

  beforeAll(async () => {
    ioTrack = { ...fixtureTrack("shell-io").spec, image: await buildFixture("shell-io") };
    unitTrack = { ...fixtureTrack("shell-unit").spec, image: await buildFixture("shell-unit") };
  });
  beforeEach(() => {
    home = tempDir("codemm-home-");
    vi.stubEnv("CODEMM_HOME", home);
    recorder = recordMounts();
  });
  afterEach(() => {
    recorder.stop();
    vi.unstubAllEnvs();
  });

  const runsIn = () => join(realpathSync.native(home), "runs");

  it("a check mounts folders under CODEMM_HOME, not the OS temp folder, and removes them", async () => {
    const io = await runIo(ioTrack, "visible", { "main.sh": "read x\necho \"got $x\"\n" }, { "01.in": "a\n" });
    expect(io.cases[0]?.stdout).toBe("got a\n");
    const mounted = recorder.mounts();
    expect(mounted).toHaveLength(2); // the learner's files and the tests
    for (const folder of mounted) expect(folder.startsWith(runsIn())).toBe(true);
    expect(readdirSync(runsIn())).toEqual([]);
  });

  it("unit checks and Run stage their folders the same way", async () => {
    const unit = fixtureTrack("shell-unit").files;
    const report = await runUnit(unitTrack, { "lib.sh": unit["probe/unit/pass/lib.sh"]! }, subMap(unit, "probe/unit/tests"));
    expect(report.report.exit).toBe(0);
    const run = runProgram(ioTrack, { "main.sh": "echo hi\n" }, () => undefined);
    expect(await run.done).toMatchObject({ exit: 0, stage: "run" });
    const mounted = recorder.mounts();
    expect(mounted).toHaveLength(3); // unit: files and tests; Run: files only
    for (const folder of mounted) expect(folder.startsWith(runsIn())).toBe(true);
    expect(readdirSync(runsIn())).toEqual([]);
  });
});
