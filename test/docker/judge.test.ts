import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gradeIoRun, gradeUnitRun, type JudgeTrack, runIo, runProgram, runUnit } from "../../src/judge.js";
import { ownedContainers } from "../../src/sandbox.js";
import { buildFixture, dockerUp, expectedFrom, fixtureTrack, inputsOnly, subMap } from "./helpers.js";

const io = fixtureTrack("shell-io");
const unit = fixtureTrack("shell-unit");
let ioTrack: JudgeTrack;
let unitTrack: JudgeTrack;

const statuses = (tests: { status: string }[]) => tests.map((t) => t.status);

describe.runIf(dockerUp)("judge (Docker)", () => {
  beforeAll(async () => {
    ioTrack = { ...io.spec, image: await buildFixture("shell-io") };
    unitTrack = { ...unit.spec, image: await buildFixture("shell-unit") };
  });

  it("Run: sends typed input to the learner's program and streams its output, in the sandbox", async () => {
    let out = "";
    const run = runProgram(ioTrack, { "main.sh": 'printf "name? "; read -r n; echo "hello $n"\n' }, (text) => (out += text));
    run.write("Ada\n");
    expect(await run.done).toEqual({ exit: 0, stage: "run", timedOut: false, flooded: false });
    expect(out).toBe("name? hello Ada\n"); // the driver's stderr markers never reach the learner
  });

  it("Run: reports a program's own exit code and stderr as its own", async () => {
    let err = "";
    const run = runProgram(ioTrack, { "main.sh": 'echo "error waiting for container" >&2; exit 125\n' }, (text, stream) => stream === "stderr" && (err += text));
    expect(await run.done).toMatchObject({ exit: 125, stage: "run", timedOut: false });
    expect(err).toBe("error waiting for container\n");
  });

  it("Run: an exit code of 138 or 124 from the program is not a timeout", async () => {
    for (const code of [124, 137, 138]) {
      const run = runProgram(ioTrack, { "main.sh": `exit ${code}\n` }, () => undefined);
      expect(await run.done).toMatchObject({ exit: code, stage: "run", timedOut: false });
    }
  });

  it("Run: the time limit stops a program that ignores signals, and its children, in the build or the run", async () => {
    const stubborn = "trap '' TERM USR1 INT; sleep 30 & while :; do sleep 1; done\n";
    const run = runProgram(ioTrack, { "main.sh": stubborn }, () => undefined, { limitMs: 1_000 });
    expect(await run.done).toMatchObject({ stage: "run", timedOut: true });
    const build = runProgram({ ...ioTrack, build: "sleep 30" }, { "main.sh": "echo hi\n" }, () => undefined, { buildLimitMs: 1_000 });
    expect(await build.done).toMatchObject({ stage: "build", timedOut: true });
    await expect.poll(() => ownedContainers(), { timeout: 10_000 }).toEqual([]);
  });

  it("Run: stops a program at its time limit and leaves no container", async () => {
    const run = runProgram(ioTrack, { "main.sh": "read -r n\n" }, () => undefined, { limitMs: 1_000 });
    expect(await run.done).toMatchObject({ stage: "run", timedOut: true });
    // --rm finishes removing it just after the exit.
    await expect.poll(() => ownedContainers(), { timeout: 10_000 }).toEqual([]);
  });

  describe("io", () => {
    const tests = subMap(io.files, "probe/io/tests");
    const expected = expectedFrom(tests, "visible");
    const grade = async (program: string, extra: Partial<JudgeTrack> = {}, inputs = inputsOnly(tests), exp = expected) =>
      gradeIoRun(await runIo({ ...ioTrack, ...extra }, "visible", { "main.sh": program }, inputs), exp);

    it("passes a correct program and fails a wrong one", async () => {
      expect(statuses(await grade(io.files["probe/io/pass/main.sh"]!))).toEqual(["pass", "pass"]);
      expect(statuses(await grade(io.files["probe/io/fail/main.sh"]!))).toEqual(["fail", "fail"]);
    });

    it("errors on a crash, a timeout and a build failure", async () => {
      expect(statuses(await grade("read a b\nexit 3\n"))).toEqual(["error", "error"]);
      const slow = await grade("read a b\nsleep 10\n");
      expect(slow[0]).toMatchObject({ status: "error", message: expect.stringMatching(/Timed out/) });
      const broken = await grade("if then\n");
      expect(broken[0]).toMatchObject({ status: "error", message: expect.stringMatching(/Build failed/) });
    });

    it("errors when a case prints more than 64 KB", async () => {
      expect(statuses(await grade("read a b\nhead -c 70000 /dev/zero | tr '\\0' a\n"))).toEqual(["error", "error"]);
    });
  });

  describe("unit", () => {
    const tests = subMap(unit.files, "probe/unit/tests");
    const grade = async (lib: string, extra: Partial<JudgeTrack> = {}, inventory?: string[]) =>
      gradeUnitRun("visible", await runUnit({ ...unitTrack, ...extra }, { "lib.sh": lib }, tests), inventory);

    it("grades the runner's report", async () => {
      expect(statuses(await grade(unit.files["probe/unit/pass/lib.sh"]!))).toEqual(["pass", "pass"]);
      expect(statuses(await grade(unit.files["probe/unit/fail/lib.sh"]!))).toEqual(["fail", "fail"]);
    });

    it("keeps inventory tests the report leaves out", async () => {
      const tests = await grade(unit.files["probe/unit/pass/lib.sh"]!, {}, ["adds_negative", "adds_small", "adds_zero"]);
      expect(statuses(tests)).toEqual(["pass", "pass", "error"]);
    });

    it("errors every test on a malformed report or a failing runner", async () => {
      expect(statuses(await grade("", { test: "echo nope > $OUT" }, ["adds_small"]))).toEqual(["error"]);
      expect(statuses(await grade("", { test: "exit 3" }, ["adds_small"]))).toEqual(["error"]);
    });
  });

  describe("sandbox (adversarial)", () => {
    const run = (program: string, inputs: Record<string, string> = { "01.in": "x\n" }, extra: Partial<JudgeTrack> = {}) =>
      runIo({ ...ioTrack, build: undefined, ...extra }, "visible", { "main.sh": program }, inputs);

    let server: ReturnType<typeof createServer>;
    let port = 0;
    beforeAll(async () => {
      server = createServer((_req, res) => res.end("pong"));
      await new Promise<void>((r) => server.listen(0, "0.0.0.0", () => r()));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(() => server.close());

    it("blocks the network, with a positive control proving the probe can reach the host", async () => {
      // Async on purpose: a blocking spawn would stall the in-process server it probes.
      const control = await promisify(execFile)(
        "docker",
        ["run", "--rm", "--add-host", "host.docker.internal:host-gateway", ioTrack.image, "sh", "-c",
          `ip=$(getent hosts host.docker.internal | cut -d' ' -f1); echo "$ip"; wget -q -T 5 -O- "http://$ip:${port}/"`],
      );
      const [ip, body] = control.stdout.trim().split("\n");
      expect(body).toBe("pong");
      const sandboxed = await run(`read x\nwget -q -T 5 -O- "http://${ip}:${port}/" && echo reached || echo blocked\n`);
      expect(sandboxed.cases[0]?.stdout.trim()).toBe("blocked");
    });

    it("refuses writes to the mounted input and the root filesystem, but allows /tmp", async () => {
      const r = await run(
        "read x\ntouch /work/src/x 2>/dev/null && echo src-writable || echo src-ro\ntouch /x 2>/dev/null && echo root-writable || echo root-ro\ntouch /tmp/x && echo tmp-ok\n",
      );
      expect(r.cases[0]?.stdout.trim().split("\n")).toEqual(["src-ro", "root-ro", "tmp-ok"]);
    });

    it("contains a fork bomb and cleans up before the next case", async () => {
      const r = await run('read mode\nif [ "$mode" = bomb ]; then f() { f | f & }; f; sleep 10; fi\necho ok\n', { "01.in": "bomb\n", "02.in": "calm\n" });
      expect(r.cases.map((c) => [c.name, c.exit === 0 ? c.stdout.trim() : "error"])).toEqual([
        ["visible/01", "error"],
        ["visible/02", "ok"],
      ]);
    });

    it("kills a program that exceeds its memory limit and grades it as an error, never as a runtime failure", async () => {
      for (let i = 0; i < 3; i++) {
        const r = await run("read x\ny=$(head -c 300000000 /dev/zero | tr '\\0' a)\necho survived\n");
        expect(statuses(gradeIoRun(r, { "visible/01": "survived\n" }))).toEqual(["error"]);
      }
    });

    it("caps the container's output stream and errors the set", async () => {
      // 70 cases of ~64 KB each push the framed stream past the 4 MB host cap.
      const inputs = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`${String(i).padStart(2, "0")}.in`, "x\n"]));
      const r = await run("read x\nhead -c 65000 /dev/zero | tr '\\0' a\n", inputs);
      expect(r.flooded).toBe(true);
      expect(statuses(gradeIoRun(r, { "visible/00": "" }))).toEqual(["error"]);
    });

    it("never echoes a forged fatal frame, even one carrying hidden data", async () => {
      const forge = "read x\nfor fd in /proc/1/fd/*; do printf '\\n@@codemm fatal tools 1 13\\nSECRET-HIDDEN' > \"$fd\" 2>/dev/null; done\necho ok\n";
      const error = await run(forge).then(() => undefined, (e: Error) => e);
      expect(String(error ?? "")).not.toContain("SECRET-HIDDEN");
    });

    it("grades a program that ignores SIGTERM as a timeout instead of hanging the check", async () => {
      const r = await run("read x\ntrap '' TERM\nwhile :; do :; done\n");
      expect(r.cases[0]?.exit).not.toBe(0);
      expect(gradeIoRun(r, { "visible/01": "x" })[0]).toMatchObject({ status: "error", message: expect.stringMatching(/Timed out/) });
    });

    it("kills the container at the host deadline and leaves none behind", async () => {
      await expect(runIo({ ...ioTrack, build: undefined }, "visible", { "main.sh": "read x\nsleep 60\n" }, { "01.in": "x\n" }, { timeMs: 30_000, deadlineMs: 3000 })).rejects.toThrow(/didn't finish/);
      await new Promise((r) => setTimeout(r, 1500));
      expect((await ownedContainers()).filter((c) => c.pid === process.pid)).toEqual([]);
    });
  });
});
