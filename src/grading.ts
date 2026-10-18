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
export type RawCase = { name: string; exit: number; stdout: string; stderr: string; big?: boolean };
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

/** One io case as the driver framed it: its output (from a `case` or `big` frame), then its stderr. */
export type CaseFrames = { name: string; exit: number; stdout: string; stderr: string; big: boolean };

/**
 * Follows the driver's frames as they stream, for progress: "built" when the build frame arrives, then the count
 * of finished io cases (case or big). Without `onCase` it keeps no bodies and decodes only headers. With it, each
 * case is handed over whole once its stderr frame ends; the caller passes it only for visible tests.
 */

export function frameProgress(on: (milestone: "built" | number) => void, onCase?: (c: CaseFrames) => void): (chunk: Buffer) => void {
  let pending = Buffer.alloc(0); // a marker or header split across chunks
  let skip = 0; // body bytes still to pass over
  let cases = 0;
  // With onCase, case, big and stderr bodies are kept; a case is handed over once its stderr frame ends.
  let kept: { kind: string; name: string; exit: number; parts: Buffer[] } | undefined;
  let waiting: Omit<CaseFrames, "stderr"> | undefined;
  const finish = () => {
    const f = kept!;
    kept = undefined;
    const body = Buffer.concat(f.parts).toString("utf8");
    if (f.kind !== "stderr") waiting = { name: f.name, exit: f.exit, stdout: body, big: f.kind === "big" };
    else {
      if (waiting?.name === f.name) onCase!({ ...waiting, stderr: body });
      waiting = undefined;
    }
  };
  return (chunk) => {
    const buf = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    pending = Buffer.alloc(0);
    let pos = 0;
    while (pos < buf.length) {
      if (skip > 0) {
        const n = Math.min(skip, buf.length - pos);
        kept?.parts.push(Buffer.from(buf.subarray(pos, pos + n)));
        skip -= n;
        pos += n;
        if (skip === 0 && kept) finish();
        continue;
      }
      const start = buf.indexOf(MARKER, pos);
      if (start < 0) {
        pending = Buffer.from(buf.subarray(Math.max(pos, buf.length - (MARKER.length - 1)))); // maybe a partial marker
        return;
      }
      const headerEnd = buf.indexOf(0x0a, start + MARKER.length);
      if (headerEnd < 0) {
        if (buf.length - start <= 1024) pending = Buffer.from(buf.subarray(start)); // a real header is short
        return;
      }
      const [kind, name, exit, bytes] = buf.toString("utf8", start + MARKER.length, headerEnd).split(" ");
      const size = Number(bytes);
      pos = headerEnd + 1;
      if (!Number.isInteger(size) || size < 0) continue;
      skip = size;
      if (kind === "build") on("built");
      if (kind === "case" || kind === "big") on((cases += 1));
      if (onCase && (kind === "case" || kind === "big" || kind === "stderr")) {
        kept = { kind, name: name ?? "", exit: Number(exit), parts: [] };
        if (size === 0) finish();
      }
    }
  };
}

/** `flooded` and `outOfMemory` mean the program got the whole container killed, so every test in the set is an error. */
export type IoRun = { build?: RawBuild; cases: RawCase[]; flooded: boolean; outOfMemory?: boolean };
export type UnitRun = { report: RawReport; flooded: boolean; outOfMemory?: boolean };
export type Runs = Partial<Record<TestSet, IoRun | UnitRun>>;
/** What a set is graded against: io expected outputs by test name, or each unit set's test names. */
export type Expectation = { expected?: Record<string, string>; inventory?: Partial<Record<TestSet, string[]>> };

const FLOODED = "Output limit exceeded: the program printed more than 4 MB.";
const OUT_OF_MEMORY = "Memory limit exceeded: the program used more memory than the track allows.";
const killedBy = (run: { flooded: boolean; outOfMemory?: boolean }) => (run.flooded ? FLOODED : run.outOfMemory ? OUT_OF_MEMORY : undefined);

export function gradeIoRun(run: IoRun, expected: Record<string, string>): TestResult[] {
  const killed = killedBy(run);
  if (killed) return Object.keys(expected).map((name) => ({ set: name.startsWith("hidden/") ? "hidden" : "visible", name, status: "error", message: killed }));
  return gradeIo(run.cases, expected, run.build);
}

export function gradeUnitRun(set: TestSet, run: UnitRun, inventory?: string[]): TestResult[] {
  const killed = killedBy(run);
  if (killed) return (inventory ?? ["report"]).map((n) => ({ set, name: `${set}/${n}`, status: "error", message: killed }));
  return gradeUnit(set, run.report, inventory);
}

/** Grades each set of runs, visible first: io against that set's expected outputs, unit against its inventory. */
export function gradeRuns(style: "io" | "unit", runs: Runs, exp: Expectation): TestResult[] {
  const tests: TestResult[] = [];
  for (const set of ["visible", "hidden"] as const) {
    const run = runs[set];
    if (!run) continue;
    if (style === "io") {
      const expected = Object.fromEntries(Object.entries(exp.expected ?? {}).filter(([k]) => k.startsWith(`${set}/`)));
      tests.push(...gradeIoRun(run as IoRun, expected));
    } else tests.push(...gradeUnitRun(set, run as UnitRun, exp.inventory?.[set]));
  }
  return tests;
}

/** A result as Codemm shows it outside: a visible test in full; a hidden one only its `index` and status. */
export type ShownResult = { name: string; status: Status; message?: string; actual?: string; index?: number };

/** The hidden-results rule (DESIGN §4.2), in one place: nothing about a hidden test but its index and status. */
export function redact(tests: TestResult[]): ShownResult[] {
  let hidden = 0;
  return tests.map((t) => {
    if (t.set === "hidden") {
      hidden += 1;
      return { name: `hidden #${hidden}`, index: hidden, status: t.status };
    }
    // A passing test's output adds nothing.
    return { name: t.name, status: t.status, ...(t.message ? { message: t.message } : {}), ...(t.actual !== undefined && t.status !== "pass" ? { actual: t.actual } : {}) };
  });
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
    if (c.big) return { set, name, status: "error", message: "Printed more than 64 KB of output." };
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
