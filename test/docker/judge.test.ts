import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gradeIoRun, gradeUnitRun } from "../../src/grading.js";
import { type JudgeTrack, runIo, runUnit } from "../../src/judge.js";
import { runProgram } from "../../src/program.js";
import { buildImage, ownedContainers } from "../../src/sandbox.js";
import { buildFixture, dockerUp, expectedFrom, fixtureTrack, inputsOnly, subMap } from "./helpers.js";
import { tempDir } from "../temp.js";

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

  it("an image without sleep: Run isn't cut short as a timeout, and grading names the missing tool", async () => {
    const dir = tempDir("codemm-nosleep-");
    writeFileSync(join(dir, "Dockerfile"), `${io.files["Dockerfile"]!.trim()}\nRUN rm /bin/sleep\n`);
    const built = await buildImage(dir, "codemm-test-nosleep:1");
    expect(built.ok).toBe(true);
    const track = { ...ioTrack, image: "codemm-test-nosleep:1" };
    let out = "";
    const run = runProgram(track, { "main.sh": 'read -r n\necho "got $n"\n' }, (text) => (out += text), { limitMs: 5_000 });
    await new Promise((r) => setTimeout(r, 500));
    run.write("Ada\n");
    expect(await run.done).toEqual({ exit: 0, stage: "run", timedOut: false, flooded: false });
    expect(out).toBe("got Ada\n");
    await expect(runIo(track, "visible", { "main.sh": "echo hi\n" }, { "01.in": "" })).rejects.toThrow(/missing a tool/);
  });

  it("Run: stops a program at its time limit, says nothing of its own, and leaves no container", async () => {
    let err = "";
    const run = runProgram(ioTrack, { "main.sh": "read -r n\n" }, (text, stream) => (err += stream === "stderr" ? text : ""), { limitMs: 1_000 });
    expect(await run.done).toMatchObject({ stage: "run", timedOut: true });
    // Codemm's own "time's up" is the only word on it: the driver's shell doesn't report the kill ("Killed").
    expect(err).toBe("");
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
      expect(slow[0]).toMatchObject({ status: "error", message: expect.stringMatching(/took longer than \d+ ms/) });
      const broken = await grade("if then\n");
      expect(broken[0]).toMatchObject({ status: "error", message: expect.stringMatching(/Build failed/) });
    });

    it("errors when a case prints more than 32 MB, and compares one just under it in full", async () => {
      expect(statuses(await grade("read a b\nhead -c 34000000 /dev/zero | tr '\\0' a\n"))).toEqual(["error", "error"]);
      const long = await runIo({ ...ioTrack, build: undefined }, "visible", { "main.sh": "read a b\nhead -c 33000000 /dev/zero | tr '\\0' a\n" }, { "01.in": "1 2\n" });
      expect(long.cases[0]).toMatchObject({ exit: 0, bytes: 33_000_000, digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(long.cases[0]!.stdout).toHaveLength(65_536);
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

    it("keeps each case's stderr with that case", async () => {
      const r = await run("read x\necho \"warn $x\" >&2\nexit 3\n", { "01.in": "a\n", "02.in": "b\n" });
      expect(r.cases.map((c) => [c.name, c.exit, c.stderr])).toEqual([["visible/01", 3, "warn a\n"], ["visible/02", 3, "warn b\n"]]);
    });

    it("kills a program that exceeds its memory limit and grades it as an error, never as a runtime failure", async () => {
      for (let i = 0; i < 3; i++) {
        const r = await run("read x\ny=$(head -c 300000000 /dev/zero | tr '\\0' a)\necho survived\n");
        expect(statuses(gradeIoRun(r, { "visible/01": "survived\n" }))).toEqual(["error"]);
      }
    });

    it("says a program ran out of memory when the runtime recorded it, though the driver went on", async () => {
      // One allocation past the limit, as the program's last command: killed for memory well within the time limit.
      const r = await run("read x\ndd if=/dev/zero of=/dev/null bs=300M count=1 2>/dev/null\n");
      expect(gradeIoRun(r, { "visible/01": "survived\n" })[0]).toMatchObject({ status: "error", message: expect.stringMatching(/^It ran out of memory \(memory_mb 128\)/) });
    });

    it("caps the container's output stream and errors the set", async () => {
      // Each case's own output is bounded inside the container, so only writing to the stream the driver saved while the
      // case runs (DESIGN §4.2) can pass the host cap: 4 MB plus 32 MB per case. A long time limit lets a slow pipe finish.
      const flood = "read x\nfor fd in /proc/1/fd/*; do case $(readlink \"$fd\") in pipe:*) head -c 40000000 /dev/zero > \"$fd\";; esac; done\n";
      const r = await run(flood, undefined, { limits: { time_ms: 60_000, memory_mb: 128 } });
      expect(r.flooded).toBe(true);
      expect(statuses(gradeIoRun(r, { "visible/01": "" }))).toEqual(["error"]);
    });

    it("never echoes a forged fatal frame, even one carrying hidden data", async () => {
      const forge = "read x\nfor fd in /proc/1/fd/*; do printf '\\n@@codemm fatal tools 1 13\\nSECRET-HIDDEN' > \"$fd\" 2>/dev/null; done\necho ok\n";
      const error = await run(forge).then(() => undefined, (e: Error) => e);
      expect(String(error ?? "")).not.toContain("SECRET-HIDDEN");
    });

    it("grades a program that ignores SIGTERM as a timeout instead of hanging the check", async () => {
      const r = await run("read x\ntrap '' TERM\nwhile :; do :; done\n");
      expect(r.cases[0]?.exit).not.toBe(0);
      expect(gradeIoRun(r, { "visible/01": "x" })[0]).toMatchObject({ status: "error", message: expect.stringMatching(/took longer than \d+ ms/) });
    });

    it("kills the container at the host deadline and leaves none behind", async () => {
      await expect(runIo({ ...ioTrack, build: undefined }, "visible", { "main.sh": "read x\nsleep 60\n" }, { "01.in": "x\n" }, { timeMs: 30_000, deadlineMs: 3000 })).rejects.toThrow(/didn't finish/);
      await expect.poll(async () => (await ownedContainers()).filter((c) => c.pid === process.pid), { timeout: 10_000 }).toEqual([]);
    });
  });
});
