import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";

export type TestSet = "visible" | "hidden";
export type Status = "pass" | "fail" | "error";

export type TestResult = {
  set: TestSet;
  name: string;
  status: Status;
  message?: string;
  /** io only: the start of what the program printed (at most SHOWN_BYTES). */
  actual?: string;
};

/** The most an io case may print. More is an error, never a comparison of the first part (DESIGN §4.2). */
export const CASE_OUTPUT_BYTES = 32 * 1024 * 1024;
export const CASE_OUTPUT_MB = CASE_OUTPUT_BYTES / 1024 / 1024;
/** How much of an io case's output Codemm keeps and shows. The comparison uses a digest of all of it. */
export const SHOWN_BYTES = 65_536;
/** The longest body any other frame carries: a unit report (1 MB). Anything past it was forged and is dropped. */
const FRAME_BYTES = 1_048_576;

/**
 * One framed record. A `case` body is the start of the program's output (at most SHOWN_BYTES): `bytes` is its full
 * size and `digest` the SHA-256 of all of it, normalized.
 */
export type Frame = { kind: string; name: string; exit: number; body: string; bytes?: number; digest?: string };
/**
 * One io case. `stdout` is the start of its output; `digest` and `bytes` cover all of it (without a digest, `stdout`
 * is all of it). `timedOut`: the driver's watchdog marked that the case reached its time limit. `generator`: the
 * case's input generator failed, with exit code `exit`, so the program never ran.
 */
export type RawCase = {
  name: string; exit: number; stdout: string; stderr: string; digest?: string; bytes?: number; big?: boolean; timedOut?: boolean; generator?: boolean;
};
/** `timedOut`: the driver's watchdog marked that the unit runner reached its time limit. */
export type RawReport = { exit: number; body: string; log: string; timedOut?: boolean };
export type RawBuild = { exit: number; output: string };

const MARKER = Buffer.from("@@codemm ");
const MESSAGE_CAP = 2000;
/**
 * Text from the sandbox as the learner sees it: their files by their own names (`/work/src/main.py` is `main.py`,
 * `/work/tests/x` is `tests/x`), at most MESSAGE_CAP characters.
 */
export const learnerPaths = (s: string) => s.replaceAll("/work/src/", "").replaceAll("/work/tests/", "tests/");
const cap = (raw: string) => {
  const s = learnerPaths(raw);
  return s.length > MESSAGE_CAP ? `${s.slice(0, MESSAGE_CAP)}\n… (truncated)` : s;
};

/**
 * Output as Codemm compares it: CRLF as LF, no trailing whitespace on any line and no blank lines at the end.
 * Linear in the length, whatever the program printed.
 */
export function normalizeOutput(text: string): string {
  const lines = text.split("\n").map((line) => line.trimEnd());
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  return lines.slice(0, end).join("\n");
}

/** The SHA-256 of normalizeOutput(text): what io outputs are compared by. */
export const digestOf = (text: string) => createHash("sha256").update(normalizeOutput(text)).digest("hex");

/**
 * digestOf the output, fed its raw bytes in pieces. A line's text is hashed as it comes; only its trailing whitespace
 * (which a later character may still need) and line breaks wait, so memory stays small however long a line is.
 */
export class OutputDigest {
  private readonly hash = createHash("sha256");
  private readonly decoder = new StringDecoder("utf8");
  /** What the current line holds that isn't written yet. */
  private line = "";
  /** Whether some of the current line is written, so its line breaks before it already are. */
  private started = false;
  /** Line breaks not written yet: they count only if text follows. */
  private held = 0;
  /** How long the current line may grow before its text is written; it doubles past a run of whitespace, so it stays linear. */
  private room = 65_536;
  private out = "";

  update(chunk: Buffer): void {
    this.take(this.decoder.write(chunk));
  }

  digest(): string {
    this.take(this.decoder.end());
    this.flush();
    this.hash.update(this.out);
    return this.hash.digest("hex");
  }

  private take(text: string): void {
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        this.flush();
        this.line = "";
        this.started = false;
        this.held += 1;
        this.room = 65_536;
      }
      this.line += parts[i]!;
      if (this.line.length > this.room) {
        this.flush();
        this.room = Math.max(65_536, this.line.length * 2);
      }
    }
  }

  /** Writes the current line's text up to its trailing whitespace, after the line breaks before it. */
  private flush(): void {
    const kept = this.line.trimEnd();
    if (kept === "") return;
    if (!this.started) {
      this.write("\n".repeat(this.held));
      this.held = 0;
      this.started = true;
    }
    this.write(kept);
    this.line = this.line.slice(kept.length);
  }

  private write(text: string): void {
    this.out += text;
    if (this.out.length >= 65_536) {
      this.hash.update(this.out);
      this.out = "";
    }
  }
}

/**
 * Reads the driver's length-framed records as they stream: `@@codemm <kind> <name> <exit> <bytes>\n<bytes>`.
 * Program output only ever appears inside a frame body, so it can't forge a frame. A case body is reduced as it
 * comes to its start and the digest of all of it, so memory stays bounded however much a program prints.
 * `onFrame` hears each frame as it completes; one that throws is dropped, and reading goes on.
 */
export class FrameReader {
  readonly frames: Frame[] = [];
  /** Past `maxFrames` the rest is ignored: the driver never frames that many, so they were forged (DESIGN §4.2). */
  private full = false;
  private pending = Buffer.alloc(0); // a marker or header split across chunks
  private body: { frame: Frame; size: number; left: number; parts: Buffer[]; kept: number; digest?: OutputDigest } | undefined;

  constructor(private onFrame?: (f: Frame) => void, private readonly maxFrames = Number.POSITIVE_INFINITY) {}

  push(chunk: Buffer): void {
    if (this.full) return;
    const buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = Buffer.alloc(0);
    let pos = 0;
    while (pos < buf.length && !this.full) {
      if (this.body) {
        pos += this.feed(buf.subarray(pos));
        continue;
      }
      const start = buf.indexOf(MARKER, pos);
      if (start < 0) {
        this.pending = Buffer.from(buf.subarray(Math.max(pos, buf.length - (MARKER.length - 1)))); // maybe a partial marker
        return;
      }
      const headerEnd = buf.indexOf(0x0a, start + MARKER.length);
      if (headerEnd < 0) {
        if (buf.length - start <= 1024) this.pending = Buffer.from(buf.subarray(start)); // a real header is short
        return;
      }
      const [kind, name, exit, bytes] = buf.toString("utf8", start + MARKER.length, headerEnd).split(" ");
      const size = Number(bytes);
      pos = headerEnd + 1;
      if (!kind || !name || !Number.isInteger(size) || size < 0) continue;
      this.body = { frame: { kind, name, exit: Number(exit), body: "" }, size, left: size, parts: [], kept: 0, ...(kind === "case" ? { digest: new OutputDigest() } : {}) };
      if (size === 0) this.close();
    }
  }

  /** Takes body bytes from the start of `buf`, and returns how many. */
  private feed(buf: Buffer): number {
    const b = this.body!;
    const piece = buf.subarray(0, Math.min(b.left, buf.length));
    b.digest?.update(piece);
    const room = (b.digest ? SHOWN_BYTES : FRAME_BYTES) - b.kept;
    if (room > 0) {
      const keep = Buffer.from(piece.subarray(0, room));
      b.parts.push(keep);
      b.kept += keep.length;
    }
    b.left -= piece.length;
    if (b.left === 0) this.close();
    return piece.length;
  }

  private close(): void {
    const b = this.body!;
    this.body = undefined;
    const kept = Buffer.concat(b.parts);
    // A cut body drops a character the cut split; a whole one decodes as it is.
    const body = b.kept < b.size ? new StringDecoder("utf8").write(kept) : kept.toString("utf8");
    const frame: Frame = { ...b.frame, body, ...(b.digest ? { bytes: b.size, digest: b.digest.digest() } : {}) };
    this.frames.push(frame);
    if (this.frames.length >= this.maxFrames) this.full = true;
    try {
      this.onFrame?.(frame);
    } catch {
      this.onFrame = undefined;
    }
  }
}

/** Every complete frame in `buf`. A truncated last frame is left out. */
export function parseFrames(buf: Buffer): Frame[] {
  const reader = new FrameReader();
  reader.push(buf);
  return reader.frames;
}

/** One io case as the driver framed it: its output (from a `case` or `big` frame), then its stderr. */
export type CaseFrames = RawCase & { big: boolean };

/**
 * Follows the frames as they complete, for progress: "built" when the build frame arrives, then the count of
 * finished io cases (case, big, or an input generator that failed). With `onCase`, each case is handed over once
 * its stderr frame ends; the caller passes it only for visible tests.
 */
export function frameProgress(on: (milestone: "built" | number) => void, onCase?: (c: CaseFrames) => void): (f: Frame) => void {
  let cases = 0;
  let waiting: Omit<CaseFrames, "stderr"> | undefined;
  return (f) => {
    if (f.kind === "build") on("built");
    if (f.kind === "case" || f.kind === "big" || f.kind === "gen") on((cases += 1));
    if (!onCase) return;
    if (f.kind === "gen") onCase({ name: f.name, exit: f.exit, stdout: "", stderr: "", big: false, generator: true });
    else if (f.kind === "case" || f.kind === "big") {
      waiting = { name: f.name, exit: f.exit, stdout: f.body, big: f.kind === "big", ...(f.digest ? { digest: f.digest, bytes: f.bytes } : {}) };
    } else if (f.kind === "stderr") {
      if (waiting?.name === f.name) onCase({ ...waiting, stderr: f.body });
      waiting = undefined;
    }
  };
}

/**
 * `flooded` and `outOfMemory` mean the program got the whole container killed, so every test in the set is an error.
 * `limits` are what the set ran with, and `memoryKill` that the runtime recorded a memory-limit kill inside it while
 * the driver went on: with each case's `timedOut`, they say why a killed case or runner stopped.
 */
export type Stops = { limits?: { time_ms: number; memory_mb: number }; memoryKill?: boolean };
export type IoRun = { build?: RawBuild; cases: RawCase[]; flooded: boolean; outOfMemory?: boolean } & Stops;
export type UnitRun = { report: RawReport; flooded: boolean; outOfMemory?: boolean } & Stops;
export type Runs = Partial<Record<TestSet, IoRun | UnitRun>>;
/**
 * A recorded io output: all of it, or for one longer than SHOWN_BYTES, the digest of all of it, its size and its start
 * (DESIGN §4.2).
 */
export type Expected = string | { sha256: string; bytes: number; head: string };
/** What a test shows of its expected output: all of it, or the start of a long one. */
export const expectedText = (e: Expected) => (typeof e === "string" ? e : e.head);
/** The digest an expected output is compared by. */
export const expectedDigest = (e: Expected) => (typeof e === "string" ? digestOf(e) : e.sha256);
/** How a reference's output is recorded: in full up to SHOWN_BYTES, else as its digest, size and start. */
export const recordOutput = (c: RawCase): Expected =>
  c.digest === undefined || c.bytes === undefined || c.bytes <= SHOWN_BYTES ? c.stdout : { sha256: c.digest, bytes: c.bytes, head: c.stdout };
/** The digest a case is compared by. */
export const caseDigest = (c: RawCase) => c.digest ?? digestOf(c.stdout);

/** What a set is graded against: io expected outputs by test name, or each unit set's test names. */
export type Expectation = { expected?: Record<string, Expected>; inventory?: Partial<Record<TestSet, string[]>> };

const FLOODED = "Output limit exceeded: the program wrote more than Codemm reads from one run.";
const OUT_OF_MEMORY = "Memory limit exceeded: the program used more memory than the track allows.";
const killedBy = (run: { flooded: boolean; outOfMemory?: boolean }) => (run.flooded ? FLOODED : run.outOfMemory ? OUT_OF_MEMORY : undefined);

export function gradeIoRun(run: IoRun, expected: Record<string, Expected>): TestResult[] {
  const killed = killedBy(run);
  if (killed) return Object.keys(expected).map((name) => ({ set: name.startsWith("hidden/") ? "hidden" : "visible", name, status: "error", message: killed }));
  return gradeIo(run.cases, expected, run.build, run);
}

export function gradeUnitRun(set: TestSet, run: UnitRun, inventory?: string[]): TestResult[] {
  const killed = killedBy(run);
  if (killed) return (inventory ?? ["report"]).map((n) => ({ set, name: `${set}/${n}`, status: "error", message: killed }));
  return gradeUnit(set, run.report, inventory, run);
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

const setOf = (name: string): TestSet => (name.startsWith("hidden/") ? "hidden" : "visible");

/**
 * Why a program killed with 137 stopped: a time-out the driver's watchdog stated, else a memory-limit kill the
 * runtime recorded. Neither is guessed from the exit code: both kinds of \`timeout\` exit 137 too.
 */
function killReason(exit: number, timedOut: boolean | undefined, stops: Stops): string | undefined {
  if (!stops.limits || exit !== 137) return undefined;
  if (timedOut) return `took longer than ${stops.limits.time_ms} ms`;
  return stops.memoryKill ? `ran out of memory (memory_mb ${stops.limits.memory_mb})` : undefined;
}

function exitMessage(c: RawCase, stops?: Stops): string {
  const why = stops?.limits ? killReason(c.exit, c.timedOut, stops) : undefined;
  // Without limits (a case graded as it streams), the driver's statements aren't known yet.
  const killed = stops?.limits ? "It was killed" : "Timed out or was killed";
  // An exit code means little to most learners; the program's own errors below say what went wrong.
  const reason = why ? `It ${why}` : c.exit === 143 || c.exit === 137 || (!stops?.limits && c.exit === 124) ? killed : "It stopped with an error";
  return cap(c.stderr ? `${reason}:\n${c.stderr}` : reason);
}

/** Grades io cases against expected outputs, keyed by case name (e.g. "hidden/02"). */
export function gradeIo(cases: RawCase[], expected: Record<string, Expected>, build?: RawBuild, stops?: Stops): TestResult[] {
  const byName = new Map(cases.map((c) => [c.name, c]));
  return Object.entries(expected).map(([name, want]): TestResult => {
    const set = setOf(name);
    if (build && build.exit !== 0) return { set, name, status: "error", message: cap(`The build failed:\n${build.output}`) };
    const c = byName.get(name);
    if (!c) return { set, name, status: "error", message: "This case did not run." };
    if (c.generator) return { set, name, status: "error", message: `The test's input generator failed (exit ${c.exit}), so the program didn't run.` };
    if (c.big) return { set, name, status: "error", message: `Printed more than ${CASE_OUTPUT_MB} MB of output.` };
    if (c.exit !== 0) return { set, name, status: "error", message: exitMessage(c, stops), actual: c.stdout };
    if (caseDigest(c) === expectedDigest(want)) return { set, name, status: "pass", actual: c.stdout };
    const long = typeof want !== "string" || (c.bytes ?? 0) > SHOWN_BYTES;
    const message = long ? `Output differs from the expected output. Only the first ${SHOWN_BYTES / 1024} KB of each are shown.` : "Output differs from the expected output.";
    return { set, name, status: "fail", message, actual: c.stdout };
  });
}

const Report = z.object({
  tests: z
    .array(z.object({ name: z.string().min(1).max(200), status: z.enum(["pass", "fail", "error"]), message: z.string().optional() }))
    .min(1, "the report lists no tests")
    .refine((tests) => new Set(tests.map((t) => t.name)).size === tests.length, "test names must be unique"),
});

function parseReport(raw: RawReport, stops?: Stops): z.infer<typeof Report>["tests"] | string {
  if (raw.exit !== 0) {
    const why = stops?.limits ? (killReason(raw.exit, raw.timedOut, stops) ?? (raw.exit === 137 ? "was killed" : undefined)) : undefined;
    return `The test runner ${why ?? "stopped with an error"}.${raw.log ? `\n${raw.log}` : ""}`;
  }
  // The driver frames an empty body when $OUT is missing or over 1 MB: often a runner that printed its report instead.
  if (!raw.body.trim()) return "The test command wrote no report to $OUT. Write the JSON report to the file $OUT names; what it prints isn't read as the report.";
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
export function gradeUnit(set: TestSet, raw: RawReport, inventory?: string[], stops?: Stops): TestResult[] {
  const tests = parseReport(raw, stops);
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
