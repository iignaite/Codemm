import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodemmError } from "./errors.js";
import { type FileMap, writeFileMap } from "./files.js";
import { gradeIo, gradeUnit, parseFrames, type RawBuild, type RawCase, type TestResult, type TestSet } from "./grading.js";
import { runSandboxed, runtimeDown, startHelp } from "./sandbox.js";

/** What the judge needs from an installed track. */
export type JudgeTrack = {
  image: string;
  build?: string | undefined;
  run?: string | undefined;
  test?: string | undefined;
  limits: { time_ms: number; memory_mb: number };
};
export type RunOptions = { timeMs?: number; deadlineMs?: number };

export type IoRun = { build?: RawBuild; cases: RawCase[]; flooded: boolean };
export type UnitRun = { report: { exit: number; body: string; log: string }; flooded: boolean };

const BUILD_SECONDS = 60;
const SLACK_MS = 30_000;
/** `timeout` takes seconds; busybox and coreutils both accept decimals. */
const seconds = (ms: number) => Math.max(0.1, ms / 1000).toFixed(3);

// The driver is PID 1. Program output only leaves the container inside a length-framed
// record, and `kill -9 -1` clears leftover processes between cases. Every command the track or learner
// supplies starts with $OOM, which makes it the out-of-memory killer's first choice (raising
// oom_score_adj needs no privilege), so a program that exhausts memory dies instead of the driver.
const EMIT = `OOM='{ echo 1000 > /proc/self/oom_score_adj; } 2>/dev/null; '
emit() { n=$(($(wc -c < "$4"))); printf '\\n@@codemm %s %s %s %s\\n' "$1" "$2" "$3" "$n"; cat "$4"; }
for u in timeout head wc cat basename; do command -v "$u" >/dev/null 2>&1 || { echo "the image has no '$u'" > /tmp/m; emit fatal tools 1 /tmp/m; exit 0; }; done`;

const IO_DRIVER = `${EMIT}
if [ -n "\${CODEMM_BUILD:-}" ]; then
  timeout -s KILL ${BUILD_SECONDS} sh -c "$OOM$CODEMM_BUILD" > /tmp/b 2>&1; c=$?
  head -c 16384 /tmp/b > /tmp/bc; emit build build "$c" /tmp/bc
  [ "$c" = 0 ] || exit 0
fi
for f in /work/tests/*.in; do
  [ -e "$f" ] || continue
  n=$(basename "$f" .in)
  timeout -s KILL "$CODEMM_TIME_S" sh -c "$OOM$CODEMM_RUN" < "$f" > /tmp/o 2> /tmp/e; c=$?
  kill -9 -1 2>/dev/null
  head -c 4096 /tmp/e > /tmp/ec
  if [ $(($(wc -c < /tmp/o))) -gt 65536 ]; then : > /tmp/oc; emit big "$n" "$c" /tmp/oc; else emit case "$n" "$c" /tmp/o; fi
  emit stderr "$n" "$c" /tmp/ec
done`;

const UNIT_DRIVER = `${EMIT}
TESTS=/work/tests OUT=/tmp/report.json timeout -s KILL "$CODEMM_TIME_S" sh -c "$OOM$CODEMM_TEST" > /tmp/o 2>&1; c=$?
kill -9 -1 2>/dev/null
if [ -f /tmp/report.json ] && [ $(($(wc -c < /tmp/report.json))) -le 1048576 ]; then emit report report "$c" /tmp/report.json; else : > /tmp/r; emit report report "$c" /tmp/r; fi
head -c 4096 /tmp/o > /tmp/oc; emit log log "$c" /tmp/oc`;

async function runDriver(track: JudgeTrack, script: string, env: Record<string, string>, src: FileMap, tests: FileMap, deadlineMs: number) {
  const dir = mkdtempSync(join(tmpdir(), "codemm-run-"));
  try {
    writeFileMap(join(dir, "src"), src);
    writeFileMap(join(dir, "tests"), tests);
    const result = await runSandboxed({
      image: track.image,
      script,
      env,
      mounts: [
        { host: join(dir, "src"), container: "/work/src" },
        { host: join(dir, "tests"), container: "/work/tests" },
      ],
      memoryMb: track.limits.memory_mb,
      deadlineMs,
    });
    if (result.cleanupFailed) throw new CodemmError("A check container couldn't be removed, so nothing was recorded. Run `codemm doctor --fix`, then retry.");
    if (result.timedOut) throw new CodemmError("The check didn't finish in time, so nothing was recorded. Check that the container runtime is healthy and retry.");
    // A flood is the program's doing and is graded; the host kill makes the exit code meaningless.
    if (result.flooded) return { frames: [], flooded: true };
    // The driver exits 0. Anything else may mean the runtime went away mid-run, whatever was printed so far.
    if (result.exit !== 0) {
      if (await runtimeDown()) throw new CodemmError(`The container runtime stopped during the run, so it wasn't counted. ${startHelp()}`);
    }
    // Exit 125 is the runtime's own failure. With no output, no code ran, so its stderr is the runtime's own too.
    if (result.exit === 125 && result.stdout.length === 0) throw new CodemmError(`The container couldn't start: ${result.stderr.trim().slice(0, 500)}`);
    if (result.exit === -1) throw new CodemmError("The container couldn't start. Run `codemm doctor`.");
    const frames = parseFrames(result.stdout);
    // A working driver always reports at least one frame. None, exit 125 after some output, or a runtime
    // connection error means the runtime failed, not the learner's code, so nothing may be graded or recorded.
    if (frames.length === 0 || result.exit === 125 || /cannot connect to the docker daemon|error during connect|connection refused/i.test(result.stderr)) {
      throw new CodemmError("The container runtime failed during the run, so it wasn't counted. Run `codemm doctor`, then retry.");
    }
    // Never echo a fatal frame's body: code in the container could forge one (DESIGN §4.2).
    if (frames.some((f) => f.kind === "fatal")) throw new CodemmError("The track image is missing a tool Codemm needs (sh, timeout, head, wc, cat or basename).");
    return { frames, flooded: result.flooded };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs one io test set. `inputs` holds `NN.in` files. Case names come back as `<set>/NN`. */
export async function runIo(track: JudgeTrack, set: TestSet, src: FileMap, inputs: FileMap, opts: RunOptions = {}): Promise<IoRun> {
  if (!track.run) throw new CodemmError("This track has no run command, so it can't run io exercises.");
  const timeMs = opts.timeMs ?? track.limits.time_ms;
  const caseCount = Object.keys(inputs).filter((p) => p.endsWith(".in")).length;
  const deadline = opts.deadlineMs ?? BUILD_SECONDS * 1000 + caseCount * (timeMs + 1000) + SLACK_MS;
  const env: Record<string, string> = { CODEMM_RUN: track.run, CODEMM_TIME_S: seconds(timeMs) };
  if (track.build) env.CODEMM_BUILD = track.build;
  const { frames, flooded } = await runDriver(track, IO_DRIVER, env, src, inputs, deadline);

  const buildFrame = frames.find((f) => f.kind === "build");
  const stderrOf = new Map(frames.filter((f) => f.kind === "stderr").map((f) => [f.name, f.body]));
  const cases = frames
    .filter((f) => f.kind === "case" || f.kind === "big")
    .map((f): RawCase => ({ name: `${set}/${f.name}`, exit: f.exit, stdout: f.body, stderr: stderrOf.get(f.name) ?? "", big: f.kind === "big" }));
  return { ...(buildFrame ? { build: { exit: buildFrame.exit, output: buildFrame.body } } : {}), cases, flooded };
}

/** Runs one unit test set: the track's `test` command against `tests`. */
export async function runUnit(track: JudgeTrack, src: FileMap, tests: FileMap, opts: RunOptions = {}): Promise<UnitRun> {
  if (!track.test) throw new CodemmError("This track has no test command, so it can't run unit exercises.");
  const timeMs = opts.timeMs ?? track.limits.time_ms;
  const deadline = opts.deadlineMs ?? timeMs + SLACK_MS;
  const env = { CODEMM_TEST: track.test, CODEMM_TIME_S: seconds(timeMs) };
  const { frames, flooded } = await runDriver(track, UNIT_DRIVER, env, src, tests, deadline);
  const report = frames.find((f) => f.kind === "report");
  const log = frames.find((f) => f.kind === "log");
  return { report: { exit: report?.exit ?? -1, body: report?.body ?? "", log: log?.body ?? "" }, flooded };
}

const FLOODED = "Output limit exceeded: the program printed more than 4 MB.";

export function gradeIoRun(run: IoRun, expected: Record<string, string>): TestResult[] {
  if (run.flooded) return Object.keys(expected).map((name) => ({ set: name.startsWith("hidden/") ? "hidden" : "visible", name, status: "error", message: FLOODED }));
  return gradeIo(run.cases, expected, run.build);
}

export function gradeUnitRun(set: TestSet, run: UnitRun, inventory?: string[]): TestResult[] {
  if (run.flooded) return (inventory ?? ["report"]).map((n) => ({ set, name: `${set}/${n}`, status: "error", message: FLOODED }));
  return gradeUnit(set, run.report, inventory);
}
