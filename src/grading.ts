import { z } from "zod";

export type TestSet = "visible" | "hidden";
export type Status = "pass" | "fail" | "error";

export type TestResult = {
  set: TestSet;
  name: string;
  status: Status;
  message?: string;
  /** io only: what the program printed (capped). */
  actual?: string;
};

export type Frame = { kind: string; name: string; exit: number; body: string };
export type RawCase = { name: string; exit: number; stdout: string; stderr: string };
export type RawReport = { exit: number; body: string; log: string };
export type RawBuild = { exit: number; output: string };

const MARKER = Buffer.from("@@codemm ");
const MESSAGE_CAP = 2000;
const cap = (s: string) => (s.length > MESSAGE_CAP ? `${s.slice(0, MESSAGE_CAP)}\n… (truncated)` : s);

/**
 * Reads the driver's length-framed records: `@@codemm <kind> <name> <exit> <bytes>\n<bytes>`.
 * Program output only ever appears inside a frame body, so it can't forge a frame.
 */
export function parseFrames(buf: Buffer): Frame[] {
  const frames: Frame[] = [];
  let pos = 0;
  for (;;) {
    const start = buf.indexOf(MARKER, pos);
    if (start < 0) break;
    const headerEnd = buf.indexOf(0x0a, start);
    if (headerEnd < 0) break;
    const [kind, name, exit, bytes] = buf.toString("utf8", start + MARKER.length, headerEnd).split(" ");
    const size = Number(bytes);
    const bodyStart = headerEnd + 1;
    if (!kind || !name || !Number.isInteger(size) || size < 0 || bodyStart + size > buf.length) break;
    frames.push({ kind, name, exit: Number(exit), body: buf.toString("utf8", bodyStart, bodyStart + size) });
    pos = bodyStart + size;
  }
  return frames;
}

export function normalizeOutput(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

const setOf = (name: string): TestSet => (name.startsWith("hidden/") ? "hidden" : "visible");

function exitMessage(exit: number, stderr: string): string {
  const reason = exit === 124 || exit === 143 || exit === 137 ? "Timed out or was killed" : `Exited with code ${exit}`;
  return cap(stderr ? `${reason}:\n${stderr}` : reason);
}

/** Grades io cases against expected outputs, keyed by case name (e.g. "hidden/02"). */
export function gradeIo(cases: RawCase[], expected: Record<string, string>, build?: RawBuild): TestResult[] {
  const byName = new Map(cases.map((c) => [c.name, c]));
  return Object.keys(expected).map((name): TestResult => {
    const set = setOf(name);
    if (build && build.exit !== 0) return { set, name, status: "error", message: cap(`Build failed (exit ${build.exit}):\n${build.output}`) };
    const c = byName.get(name);
    if (!c) return { set, name, status: "error", message: "This case did not run." };
    if (c.exit !== 0) return { set, name, status: "error", message: exitMessage(c.exit, c.stderr), actual: c.stdout };
    const pass = normalizeOutput(c.stdout) === normalizeOutput(expected[name]!);
    return pass ? { set, name, status: "pass", actual: c.stdout } : { set, name, status: "fail", message: "Output differs from the expected output.", actual: c.stdout };
  });
}

const Report = z.object({
  tests: z
    .array(z.object({ name: z.string().min(1).max(200), status: z.enum(["pass", "fail", "error"]), message: z.string().optional() }))
    .min(1, "the report lists no tests")
    .refine((tests) => new Set(tests.map((t) => t.name)).size === tests.length, "test names must be unique"),
});

function parseReport(raw: RawReport): z.infer<typeof Report>["tests"] | string {
  if (raw.exit !== 0) return `The test runner exited with code ${raw.exit}.${raw.log ? `\n${raw.log}` : ""}`;
  let json: unknown;
  try {
    json = JSON.parse(raw.body);
  } catch {
    return "The test report is not valid JSON.";
  }
  const parsed = Report.safeParse(json);
  return parsed.success ? parsed.data.tests : `Invalid test report: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
}

/**
 * Grades one unit-test set. With an inventory (recorded from the reference), every
 * expected test counts even if the report leaves it out; extra names are ignored.
 */
export function gradeUnit(set: TestSet, raw: RawReport, inventory?: string[]): TestResult[] {
  const tests = parseReport(raw);
  if (typeof tests === "string") {
    const names = inventory ?? ["report"];
    return names.map((n) => ({ set, name: `${set}/${n}`, status: "error", message: cap(tests) }));
  }
  const byName = new Map(tests.map((t) => [t.name, t]));
  const names = inventory ?? tests.map((t) => t.name);
  return names.map((n): TestResult => {
    const t = byName.get(n);
    if (!t) return { set, name: `${set}/${n}`, status: "error", message: "Missing from the test report." };
    return t.message ? { set, name: `${set}/${n}`, status: t.status, message: cap(t.message) } : { set, name: `${set}/${n}`, status: t.status };
  });
}
