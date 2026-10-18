import { describe, expect, it } from "vitest";
import { frameProgress, gradeIo, gradeIoRun, gradeRuns, gradeUnit, gradeUnitRun, normalizeOutput, parseFrames } from "../src/grading.js";

describe("parseFrames", () => {
  it("reads length-framed records and ignores stray bytes", () => {
    const body = "line one\n@@codemm case visible/99 0 3\nabc";
    const raw = `noise\n@@codemm case visible/01 0 ${Buffer.byteLength(body)}\n${body}\n@@codemm case hidden/01 1 0\n`;
    expect(parseFrames(Buffer.from(raw))).toEqual([
      { kind: "case", name: "visible/01", exit: 0, body },
      { kind: "case", name: "hidden/01", exit: 1, body: "" },
    ]);
  });

  it("stops at a truncated frame", () => {
    expect(parseFrames(Buffer.from("@@codemm case visible/01 0 100\nshort"))).toEqual([]);
  });
});

describe("normalizeOutput", () => {
  it("ignores CRLF and trailing whitespace on each line and at the end", () => {
    expect(normalizeOutput("1 2  \r\n3\t\n\n\n")).toBe(normalizeOutput("1 2\n3"));
    expect(normalizeOutput(" 1")).not.toBe(normalizeOutput("1"));
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

  it("errors a case that printed more than 64 KB instead of comparing a prefix", () => {
    const big = [{ name: "visible/01", exit: 0, stdout: "", stderr: "", big: true }];
    expect(gradeIo(big, { "visible/01": "" })[0]).toMatchObject({ status: "error", message: expect.stringMatching(/64 KB/) });
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
  const bytes = Buffer.from(frame("build", "build", "") + frame("case", "01", "@@codemm case 99 0 1\nx") + frame("stderr", "01", "") + frame("big", "02", "") + frame("stderr", "02", "oops"));
  const milestones = (chunks: Buffer[]) => {
    const seen: ("built" | number)[] = [];
    const feed = frameProgress((m) => seen.push(m));
    for (const c of chunks) feed(c);
    return seen;
  };

  it("reports the build, then each finished case, however the output is split", () => {
    expect(milestones([bytes])).toEqual(["built", 1, 2]);
    for (let at = 1; at < bytes.length; at++) expect(milestones([bytes.subarray(0, at), bytes.subarray(at)])).toEqual(["built", 1, 2]);
    expect(milestones([...bytes].map((b) => Buffer.from([b])))).toEqual(["built", 1, 2]);
  });

  it("hands over each finished case whole, with its stderr, however the output is split", () => {
    const want = [
      { name: "01", exit: 0, stdout: "@@codemm case 99 0 1\nx", stderr: "", big: false },
      { name: "02", exit: 0, stdout: "", stderr: "oops", big: true },
    ];
    const cases = (chunks: Buffer[]) => {
      const seen: unknown[] = [];
      const feed = frameProgress(() => undefined, (c) => seen.push(c));
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
