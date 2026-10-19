import { describe, expect, it } from "vitest";
import {
  digestOf, FrameReader, frameProgress, gradeIo, gradeIoRun, gradeRuns, gradeUnit, gradeUnitRun, normalizeOutput, OutputDigest, parseFrames, recordOutput, redact, SHOWN_BYTES,
} from "../src/grading.js";

describe("parseFrames", () => {
  it("reads length-framed records and ignores stray bytes", () => {
    const body = "line one\n@@codemm case visible/99 0 3\nabc";
    const raw = `noise\n@@codemm case visible/01 0 ${Buffer.byteLength(body)}\n${body}\n@@codemm case hidden/01 1 0\n`;
    expect(parseFrames(Buffer.from(raw))).toEqual([
      { kind: "case", name: "visible/01", exit: 0, body, bytes: Buffer.byteLength(body), digest: digestOf(body) },
      { kind: "case", name: "hidden/01", exit: 1, body: "", bytes: 0, digest: digestOf("") },
    ]);
  });

  it("stops at a truncated frame", () => {
    expect(parseFrames(Buffer.from("@@codemm case visible/01 0 100\nshort"))).toEqual([]);
  });

  it("keeps the start of a long case and the digest of all of it, however the stream is split", () => {
    const out = Array.from({ length: 200_000 }, (_, i) => `${i} é`).join("\n");
    const raw = Buffer.from(`@@codemm case visible/01 0 ${Buffer.byteLength(out)}\n${out}@@codemm stderr visible/01 0 2\nok`);
    for (const size of [raw.length, 4096, 777]) {
      const reader = new FrameReader();
      for (let at = 0; at < raw.length; at += size) reader.push(raw.subarray(at, at + size));
      const [c, e] = reader.frames;
      expect(c).toMatchObject({ kind: "case", bytes: Buffer.byteLength(out), digest: digestOf(out) });
      expect(Buffer.byteLength(c!.body)).toBeLessThanOrEqual(SHOWN_BYTES);
      expect(Buffer.byteLength(c!.body)).toBeGreaterThan(SHOWN_BYTES - 4);
      expect(out.startsWith(c!.body)).toBe(true);
      expect(e).toMatchObject({ kind: "stderr", body: "ok" });
    }
  });

  it("drops a listener that throws and goes on reading", () => {
    const reader = new FrameReader(() => {
      throw new Error("listener");
    });
    reader.push(Buffer.from("@@codemm case a 0 1\nx@@codemm case b 0 1\ny"));
    expect(reader.frames.map((f) => f.name)).toEqual(["a", "b"]);
  });
});

describe("normalizeOutput", () => {
  it("ignores CRLF and trailing whitespace on each line and at the end", () => {
    expect(normalizeOutput("1 2  \r\n3\t\n\n\n")).toBe(normalizeOutput("1 2\n3"));
    expect(normalizeOutput(" 1")).not.toBe(normalizeOutput("1"));
    expect(normalizeOutput("\n\na\n \n\nb \r\n\u00a0\n")).toBe("\n\na\n\n\nb");
  });

  it("stays linear on long runs of whitespace", () => {
    const started = performance.now();
    expect(normalizeOutput(`a${" ".repeat(2_000_000)}b${"\n".repeat(2_000_000)}`)).toBe(`a${" ".repeat(2_000_000)}b`);
    // A backtracking regular expression takes hours here; linear takes well under a second.
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe("OutputDigest", () => {
  const streamed = (text: string, size: number) => {
    const d = new OutputDigest();
    const bytes = Buffer.from(text);
    for (let at = 0; at < bytes.length; at += size) d.update(bytes.subarray(at, at + size));
    return d.digest();
  };

  it("equals the digest of the normalized text, however the bytes are split", () => {
    const texts = ["", "\n", "a", "a\n", "\n\na \r\n\n b\t\n\n", "x\r", "é€😀\r\n😀 \n", "1\n\n\n2\n   \n"];
    for (const text of texts) for (const size of [1, 2, 3, 7, 1000]) expect(streamed(text, size)).toBe(digestOf(text));
  });

  it("equals it on a random mix of lines, spaces and multibyte text", () => {
    const pieces = ["0", "42", " ", "  ", "\t", "\n", "\r\n", "é", "😀"];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    for (let round = 0; round < 50; round++) {
      const text = Array.from({ length: 300 }, () => pieces[next() % pieces.length]).join("");
      expect(streamed(text, 1 + (next() % 13))).toBe(digestOf(text));
    }
  });
});

describe("gradeIo", () => {
  const cases = [
    { name: "visible/01", exit: 0, stdout: "5\n", stderr: "" },
    { name: "hidden/01", exit: 0, stdout: "6", stderr: "" },
    { name: "hidden/02", exit: 124, stdout: "", stderr: "" },
  ];

  it("passes matching output, fails other output and errors on a non-zero exit", () => {
    const expected = { "visible/01": "5", "hidden/01": "7", "hidden/02": "1" };
    expect(gradeIo(cases, expected).map((t) => [t.name, t.status])).toEqual([
      ["visible/01", "pass"],
      ["hidden/01", "fail"],
      ["hidden/02", "error"],
    ]);
  });

  it("errors every expected case when the build failed", () => {
    const tests = gradeIo([], { "visible/01": "5" }, { exit: 1, output: "syntax error" });
    expect(tests).toEqual([{ set: "visible", name: "visible/01", status: "error", message: "Build failed (exit 1):\nsyntax error" }]);
  });

  it("errors a case that printed more than 32 MB instead of comparing a prefix", () => {
    const big = [{ name: "visible/01", exit: 0, stdout: "", stderr: "", big: true }];
    expect(gradeIo(big, { "visible/01": "" })[0]).toMatchObject({ status: "error", message: expect.stringMatching(/32 MB/) });
  });

  it("errors a case whose input generator failed, without running the program", () => {
    const gen = [{ name: "hidden/01", exit: 2, stdout: "", stderr: "", generator: true }];
    expect(gradeIo(gen, { "hidden/01": "" })[0]).toMatchObject({ status: "error", message: expect.stringMatching(/input generator failed \(exit 2\)/) });
  });

  it("compares a long output by its digest against a long expected output's record", () => {
    const long = "7\n".repeat(40_000);
    const run = { name: "visible/01", exit: 0, stdout: long.slice(0, 100), stderr: "", digest: digestOf(long), bytes: long.length };
    const recorded = recordOutput(run);
    expect(recorded).toEqual({ sha256: digestOf(long), bytes: long.length, head: long.slice(0, 100) });
    expect(gradeIo([run], { "visible/01": recorded })[0]).toMatchObject({ status: "pass" });
    const wrong = { ...run, digest: digestOf(`${long}8\n`) };
    expect(gradeIo([wrong], { "visible/01": recorded })[0]).toMatchObject({ status: "fail", message: expect.stringMatching(/first 64 KB/) });
    // A short output is recorded in full, and compared ignoring trailing whitespace as ever.
    expect(recordOutput({ ...run, stdout: "5\n", digest: digestOf("5\n"), bytes: 2 })).toBe("5\n");
    expect(gradeIo([{ ...run, stdout: "5  \r\n", digest: digestOf("5  \r\n"), bytes: 5 }], { "visible/01": "5" })[0]).toMatchObject({ status: "pass" });
  });

  it("errors an expected case the run never reached", () => {
    expect(gradeIo([], { "hidden/01": "x" })[0]).toMatchObject({ status: "error" });
  });
});

describe("gradeUnit", () => {
  const report = (tests: unknown) => ({ exit: 0, body: JSON.stringify({ tests }), log: "" });

  it("maps statuses and keeps missing inventory tests in the denominator", () => {
    const tests = gradeUnit("hidden", report([{ name: "a", status: "pass" }, { name: "extra", status: "pass" }]), ["a", "b"]);
    expect(tests.map((t) => [t.name, t.status])).toEqual([
      ["hidden/a", "pass"],
      ["hidden/b", "error"],
    ]);
  });

  it("uses the report's names when no inventory exists yet", () => {
    const tests = gradeUnit("visible", report([{ name: "a", status: "fail", message: "nope" }]));
    expect(tests).toEqual([{ set: "visible", name: "visible/a", status: "fail", message: "nope" }]);
  });

  it.each([
    ["a non-zero exit", { exit: 1, body: JSON.stringify({ tests: [{ name: "a", status: "pass" }] }), log: "boom" }],
    ["invalid JSON", { exit: 0, body: "{", log: "" }],
    ["an empty report", report([])],
    ["duplicate names", report([{ name: "a", status: "pass" }, { name: "a", status: "pass" }])],
  ])("errors every test on %s", (_label, raw) => {
    const tests = gradeUnit("visible", raw, ["a"]);
    expect(tests).toHaveLength(1);
    expect(tests[0]).toMatchObject({ name: "visible/a", status: "error" });
  });
});

describe("redact", () => {
  it("shows visible results in full and hidden ones as an index and a status only", () => {
    const shown = redact([
      { set: "visible", name: "visible/01", status: "fail", message: "Output differs.", actual: "0\n" },
      { set: "hidden", name: "hidden/edge", status: "fail", message: "secret", actual: "secret" },
      { set: "visible", name: "visible/02", status: "pass", actual: "2\n" },
      { set: "hidden", name: "hidden/other", status: "pass" },
    ]);
    expect(shown).toEqual([
      { name: "visible/01", status: "fail", message: "Output differs.", actual: "0\n" },
      { name: "hidden #1", index: 1, status: "fail" },
      // A passing test's output adds nothing.
      { name: "visible/02", status: "pass" },
      { name: "hidden #2", index: 2, status: "pass" },
    ]);
  });
});

describe("grading whole runs", () => {
  const ok = (name: string, stdout: string) => ({ name, exit: 0, stdout, stderr: "" });

  it("makes every test in a set an error when the program flooded output or ran out of memory", () => {
    const expected = { "visible/01": "1\n", "visible/02": "2\n" };
    expect(gradeIoRun({ cases: [], flooded: true }, expected).map((t) => [t.name, t.status, t.message])).toEqual([
      ["visible/01", "error", expect.stringMatching(/Output limit/)],
      ["visible/02", "error", expect.stringMatching(/Output limit/)],
    ]);
    expect(gradeUnitRun("hidden", { report: { exit: 0, body: "", log: "" }, flooded: false, outOfMemory: true }, ["a", "b"]).map((t) => [t.set, t.name, t.message])).toEqual([
      ["hidden", "hidden/a", expect.stringMatching(/Memory limit/)],
      ["hidden", "hidden/b", expect.stringMatching(/Memory limit/)],
    ]);
  });

  it("says whether a killed program took too long or ran out of memory, by the limits it ran with", () => {
    const limits = { time_ms: 2000, memory_mb: 128 };
    const killed = (exit: number, { timedOut = false, memoryKill = false } = {}) =>
      gradeIoRun(
        { cases: [{ name: "visible/01", exit, stdout: "", stderr: "Killed\n", ...(timedOut ? { timedOut } : {}) }], flooded: false, limits, ...(memoryKill ? { memoryKill } : {}) },
        { "visible/01": "1\n" },
      )[0]!.message;
    expect(killed(137, { timedOut: true })).toMatch(/^It took longer than 2000 ms:\nKilled/);
    expect(killed(137, { memoryKill: true })).toMatch(/^It ran out of memory \(memory_mb 128\)/);
    // A time-out is the driver's own statement, so a memory kill elsewhere in the set doesn't relabel it.
    expect(killed(137, { timedOut: true, memoryKill: true })).toMatch(/^It took longer than 2000 ms/);
    // Neither recorded: killed, without guessing why. A program's own 124 or 3 is its exit code.
    expect(killed(137)).toMatch(/^It was killed/);
    expect(killed(124)).toMatch(/^Exited with code 124/);
    expect(killed(3)).toMatch(/^Exited with code 3/);
    const unit = (report: { timedOut?: boolean }, memoryKill = false) =>
      gradeUnitRun("visible", { report: { exit: 137, body: "", log: "Killed", ...report }, flooded: false, limits, ...(memoryKill ? { memoryKill } : {}) }, ["t"])[0]!.message;
    expect(unit({}, true)).toMatch(/^The test runner ran out of memory \(memory_mb 128\)\.\nKilled/);
    expect(unit({ timedOut: true })).toMatch(/^The test runner took longer than 2000 ms\./);
    expect(unit({})).toMatch(/^The test runner was killed\./);
  });

  it("grades each set of runs against its own expected outputs, visible first", () => {
    const runs = { visible: { cases: [ok("visible/01", "1\n")], flooded: false }, hidden: { cases: [ok("hidden/01", "9\n")], flooded: false } };
    const tests = gradeRuns("io", runs, { expected: { "visible/01": "1\n", "hidden/01": "2\n" } });
    expect(tests.map((t) => [t.set, t.name, t.status])).toEqual([["visible", "visible/01", "pass"], ["hidden", "hidden/01", "fail"]]);
  });

  it("grades unit runs against each set's inventory", () => {
    const report = (tests: { name: string; status: string }[]) => ({ report: { exit: 0, body: JSON.stringify({ tests }), log: "" }, flooded: false });
    const tests = gradeRuns("unit", { visible: report([{ name: "a", status: "pass" }]) }, { inventory: { visible: ["a"], hidden: ["b"] } });
    expect(tests.map((t) => [t.set, t.name, t.status])).toEqual([["visible", "visible/a", "pass"]]);
  });
});

describe("frameProgress", () => {
  const frame = (kind: string, name: string, body: string) => `\n@@codemm ${kind} ${name} 0 ${Buffer.byteLength(body)}\n${body}`;
  // A body that looks like a frame header must be skipped by length, never counted.
  const bytes = Buffer.from(
    frame("build", "build", "") + frame("case", "01", "@@codemm case 99 0 1\nx") + frame("stderr", "01", "") + frame("big", "02", "") + frame("stderr", "02", "oops") + frame("gen", "03", ""),
  );
  const feeder = (listener: ReturnType<typeof frameProgress>) => {
    const reader = new FrameReader(listener);
    return (chunk: Buffer) => reader.push(chunk);
  };
  const milestones = (chunks: Buffer[]) => {
    const seen: ("built" | number)[] = [];
    const feed = feeder(frameProgress((m) => seen.push(m)));
    for (const c of chunks) feed(c);
    return seen;
  };

  it("reports the build, then each finished case, however the output is split", () => {
    expect(milestones([bytes])).toEqual(["built", 1, 2, 3]);
    for (let at = 1; at < bytes.length; at++) expect(milestones([bytes.subarray(0, at), bytes.subarray(at)])).toEqual(["built", 1, 2, 3]);
    expect(milestones([...bytes].map((b) => Buffer.from([b])))).toEqual(["built", 1, 2, 3]);
  });

  it("hands over each finished case whole, with its stderr, however the output is split", () => {
    const body = "@@codemm case 99 0 1\nx";
    const want = [
      { name: "01", exit: 0, stdout: body, digest: digestOf(body), bytes: Buffer.byteLength(body), stderr: "", big: false },
      { name: "02", exit: 0, stdout: "", stderr: "oops", big: true },
      { name: "03", exit: 0, stdout: "", stderr: "", big: false, generator: true },
    ];
    const cases = (chunks: Buffer[]) => {
      const seen: unknown[] = [];
      const feed = feeder(frameProgress(() => undefined, (c) => seen.push(c)));
      for (const c of chunks) feed(c);
      return seen;
    };
    expect(cases([bytes])).toEqual(want);
    for (let at = 1; at < bytes.length; at++) expect(cases([bytes.subarray(0, at), bytes.subarray(at)])).toEqual(want);
    expect(cases([...bytes].map((b) => Buffer.from([b])))).toEqual(want);
  });

  it("stays linear: 4 MB in 1 KB chunks", () => {
    const big = Buffer.from(Array.from({ length: 400 }, (_, i) => frame("case", String(i), "y".repeat(10_000))).join(""));
    const chunks = Array.from({ length: Math.ceil(big.length / 1024) }, (_, i) => big.subarray(i * 1024, (i + 1) * 1024));
    const started = performance.now();
    expect(milestones(chunks)).toHaveLength(400);
    // Quadratic copying would take many seconds here; linear takes milliseconds. The bound leaves room for slow runners.
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
