import { describe, expect, it } from "vitest";
import { gradeIo, gradeUnit, normalizeOutput, parseFrames } from "../src/grading.js";

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
