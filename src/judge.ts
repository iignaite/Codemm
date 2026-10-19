import { join } from "node:path";
import { CodemmError } from "./errors.js";
import { type FileMap, writeFileMap } from "./files.js";
import {
  CASE_OUTPUT_BYTES, type CaseFrames, type Expectation, type Frame, frameProgress, FrameReader, gradeRuns, type IoRun, type RawCase, type Runs, type TestResult, type TestSet, type UnitRun,
} from "./grading.js";
import { stageRunFolder } from "./runs.js";
import { OUTPUT_CAP, runtimeDown, runtimeKind, startHelp, startSandboxed } from "./sandbox.js";

/** What the judge needs from an installed track. */
export type JudgeTrack = {
  image: string;
  build?: string | undefined;
  run?: string | undefined;
  test?: string | undefined;
  limits: { time_ms: number; memory_mb: number };
};
/**
 * `onProgress`: "built" when the build is done, then how many io cases have finished, as each does (for progress,
 * never grading). `onCase` hands over each io case as it finishes: pass it only for visible tests. `stopAtError` ends
 * an io set at its first case that errors (a crash, a timeout, a failed input generator): for gate runs that only ask
 * whether everything passes, so a slow wrong solution costs one time limit, not one per case.
 */
export type RunOptions = {
  timeMs?: number; deadlineMs?: number; onProgress?: (milestone: "built" | number) => void; onCase?: (c: CaseFrames) => void; stopAtError?: boolean;
  /** How long each input generator may run (default GENERATOR_SECONDS); the gates' fast run gives it a third. */
  generatorMs?: number;
};


/** Why a check's container couldn't start, in words the desktop's text classification reads the same way. */
const START_FAILURES = { disk: "Docker ran out of disk space", offline: "Docker couldn't reach the network", docker: "the runtime refused it" };

export const BUILD_SECONDS = 60;
/** How long a test's input generator (`NN.gen`) may run, before and outside the program's time limit. */
export const GENERATOR_SECONDS = 30;
const SLACK_MS = 30_000;
/** What the driver needs in a track image besides `sh`. The track rules name them too (templates.ts). */
export const DRIVER_TOOLS = ["timeout", "sleep", "head", "wc", "cat", "basename"];
/** `timeout` and `sleep` take seconds; busybox and coreutils both accept decimals. */
export const seconds = (ms: number) => Math.max(0.1, ms / 1000).toFixed(3);
/** The time limit, which the watchdog enforces, and \`timeout\`'s backstop a second later. */
const timeEnv = (ms: number) => ({ CODEMM_TIME_S: seconds(ms), CODEMM_BACKSTOP_S: seconds(ms + 1000) });

// The driver is PID 1. Program output only leaves the container inside a length-framed
// record, and `kill -9 -1` clears leftover processes between cases. Every command the track or learner
// supplies starts with $OOM, which makes it the out-of-memory killer's first choice (raising
// oom_score_adj needs no privilege), so a program that runs out of memory usually dies instead of the
// driver. It's best effort: the program could lower its score back to 0. If the write fails, nothing changes.
// Shell functions share variables, so emit() keeps its own (size) apart from the loop's case name (n).
// watch() makes a time-out the driver's own statement, as Run's driver does (program.ts): both kinds of \`timeout\`
// exit 137 on one, as a memory kill does. At the limit a watchdog writes /tmp/t, then \`kill -9 -1\` stops everything
// but the driver (PID 1). \`timeout\` only backs it up, a second later. The watchdog starts before the program, so the
// program's own forks can't stop it; \`kill -9 -1\` after each case stops it if the case ends first.
const EMIT = `OOM='{ echo 1000 > /proc/self/oom_score_adj; } 2>/dev/null || :; '
emit() { size=$(($(wc -c < "$4"))); printf '\\n@@codemm %s %s %s %s\\n' "$1" "$2" "$3" "$size"; cat "$4"; }
watch() { : > /tmp/t; ( sleep "$CODEMM_TIME_S" 2>/dev/null && { echo t > /tmp/t; kill -9 -1 2>/dev/null; } ) & }
for u in ${DRIVER_TOOLS.join(" ")}; do command -v "$u" >/dev/null 2>&1 || { echo "the image has no '$u'" > /tmp/m; emit fatal tools 1 /tmp/m; exit 0; }; done`;

const IO_DRIVER = `${EMIT}
if [ -n "\${CODEMM_BUILD:-}" ]; then
  timeout -s KILL ${BUILD_SECONDS} sh -c "$OOM$CODEMM_BUILD" > /tmp/b 2>&1; c=$?
  head -c 16384 /tmp/b > /tmp/bc; emit build build "$c" /tmp/bc
  [ "$c" = 0 ] || exit 0
fi
for f in /work/tests/*; do
  case "$f" in
    *.in) n=$(basename "$f" .in); i=$f ;;
    *.gen)
      n=$(basename "$f" .gen); i=/tmp/in
      timeout -s KILL "$CODEMM_GEN_S" sh -c "$OOM"'exec sh "$0"' "$f" > /tmp/in 2>/dev/null; c=$?
      kill -9 -1 2>/dev/null
      if [ "$c" != 0 ]; then rm -f /tmp/in; emit gen "$n" "$c" /dev/null; [ -n "\${CODEMM_STOP:-}" ] && exit 0; continue; fi ;;
    *) continue ;;
  esac
  watch
  timeout -s KILL "$CODEMM_BACKSTOP_S" sh -c "$OOM$CODEMM_RUN" < "$i" > /tmp/o 2> /tmp/e; c=$?
  kill -9 -1 2>/dev/null
  head -c 4096 /tmp/e > /tmp/ec
  if [ $(($(wc -c < /tmp/o))) -gt ${CASE_OUTPUT_BYTES} ]; then : > /tmp/oc; emit big "$n" "$c" /tmp/oc; s=big; else emit case "$n" "$c" /tmp/o; s=$c; fi
  emit stderr "$n" "$c" /tmp/ec
  [ -s /tmp/t ] && emit timeout "$n" "$c" /dev/null
  rm -f /tmp/in
  [ -n "\${CODEMM_STOP:-}" ] && [ "$s" != 0 ] && exit 0
done
exit 0`;

const UNIT_DRIVER = `${EMIT}
watch
TESTS=/work/tests OUT=/tmp/report.json timeout -s KILL "$CODEMM_BACKSTOP_S" sh -c "$OOM$CODEMM_TEST" > /tmp/o 2>&1; c=$?
kill -9 -1 2>/dev/null
if [ -f /tmp/report.json ] && [ $(($(wc -c < /tmp/report.json))) -le 1048576 ]; then emit report report "$c" /tmp/report.json; else : > /tmp/r; emit report report "$c" /tmp/r; fi
head -c 4096 /tmp/o > /tmp/oc; emit log log "$c" /tmp/oc
[ -s /tmp/t ] && emit timeout report "$c" /dev/null
exit 0`;

/**
 * Runs the driver in one sandboxed container and reads its frames as they stream (`onFrame` hears each). `outputCap`
 * bounds the stream: an io set's is sized to its cases, since each may print up to CASE_OUTPUT_BYTES.
 */
async function runDriver(
  track: JudgeTrack, script: string, env: Record<string, string>, src: FileMap, tests: FileMap, deadlineMs: number,
  outputCap: number, maxFrames: number, onFrame?: (f: Frame) => void,
): Promise<{ frames: Frame[]; flooded: boolean; outOfMemory?: boolean; memoryKill?: boolean }> {
  const reader = new FrameReader(onFrame, maxFrames);
  const run = stageRunFolder();
  const dir = run.dir;
  try {
    writeFileMap(join(dir, "src"), src);
    writeFileMap(join(dir, "tests"), tests);
    const started = startSandboxed({
      image: track.image,
      script,
      env,
      mounts: [
        { host: join(dir, "src"), container: "/work/src" },
        { host: join(dir, "tests"), container: "/work/tests" },
      ],
      memoryMb: track.limits.memory_mb,
      deadlineMs,
      outputCap,
    }, { stdout: (chunk) => reader.push(chunk) });
    const result = await started.done;
    if (result.cleanupFailed) throw new CodemmError("A check container couldn't be removed, so nothing was recorded. Run `codemm doctor --fix`, then retry.", "docker");
    if (result.timedOut) throw new CodemmError("The check didn't finish in time, so nothing was recorded. Check that the container runtime is healthy and retry.", "docker");
    // A flood is the program's doing and is graded; the host kill makes the exit code meaningless.
    if (result.flooded) return { frames: [], flooded: true };
    // The driver always ends with exit 0. Anything else means it was killed or the runtime failed, whatever was
    // printed so far. Only a memory-limit kill is the program's doing; everything else records nothing.
    if (result.exit !== 0) {
      if (await runtimeDown()) throw new CodemmError(`The container runtime stopped during the run, so it wasn't counted. ${startHelp()}`, "docker");
      if (result.oomKilled) return { frames: [], flooded: false, outOfMemory: true };
      // Exit 125 is the runtime's own failure. Its stderr is read for the kind of failure but never shown: code that
      // had already started can write there too, and a check runs hidden tests and hidden code.
      if (result.exit === 125 && result.stdout.length === 0) {
        const kind = runtimeKind(result.stderr.trim().slice(0, 500));
        throw new CodemmError(`The container couldn't start (${START_FAILURES[kind]}), so it wasn't counted. Run \`codemm doctor\`, then retry.`, kind);
      }
      if (result.exit === -1) throw new CodemmError("The container couldn't start. Run `codemm doctor`.", "docker");
      throw new CodemmError("The container runtime failed during the run, so it wasn't counted. Run `codemm doctor`, then retry.", "docker");
    }
    const frames = reader.frames;
    // A working driver always reports at least one frame. None, or a runtime connection error, means the
    // runtime failed, not the learner's code, so nothing may be graded or recorded.
    if (frames.length === 0 || /cannot connect to the docker daemon|error during connect|connection refused/i.test(result.stderr)) {
      throw new CodemmError("The container runtime failed during the run, so it wasn't counted. Run `codemm doctor`, then retry.", "docker");
    }
    // Never echo a fatal frame's body: code in the container could forge one (DESIGN §4.2).
    if (frames.some((f) => f.kind === "fatal")) throw new CodemmError(`The track image is missing a tool Codemm needs: sh, ${DRIVER_TOOLS.join(", ")}.`);
    // A case or runner killed with 137 that the watchdog didn't mark as a time-out may have hit the memory limit while
    // the driver went on: only the runtime's record says so (DESIGN §4.3).
    const marked = new Set(frames.filter((f) => f.kind === "timeout").map((f) => f.name));
    const memoryKill = frames.some((f) => f.exit === 137 && (f.kind === "case" || f.kind === "report") && !marked.has(f.name)) && (await started.hadOomKill());
    return { frames, flooded: result.flooded, ...(memoryKill ? { memoryKill } : {}) };
  } finally {
    run.remove();
  }
}

/** Runs one io test set. `inputs` holds `NN.in` files. Case names come back as `<set>/NN`. */
export async function runIo(track: JudgeTrack, set: TestSet, src: FileMap, inputs: FileMap, opts: RunOptions = {}): Promise<IoRun> {
  if (!track.run) throw new CodemmError("This track has no run command, so it can't run io exercises.");
  const timeMs = opts.timeMs ?? track.limits.time_ms;
  const generated = Object.keys(inputs).filter((p) => p.endsWith(".gen")).length;
  const caseCount = Object.keys(inputs).filter((p) => p.endsWith(".in")).length + generated;
  const generatorMs = opts.generatorMs ?? GENERATOR_SECONDS * 1000;
  const deadline = opts.deadlineMs ?? BUILD_SECONDS * 1000 + caseCount * (timeMs + 1000) + generated * generatorMs + SLACK_MS;
  const env: Record<string, string> = { CODEMM_RUN: track.run, CODEMM_GEN_S: seconds(generatorMs), ...timeEnv(timeMs) };
  if (track.build) env.CODEMM_BUILD = track.build;
  if (opts.stopAtError) env.CODEMM_STOP = "1";
  // Each case frames at most CASE_OUTPUT_BYTES of output and 4 KB of errors; the rest of the stream is small.
  const outputCap = OUTPUT_CAP + caseCount * (CASE_OUTPUT_BYTES + 8192);
  const progress = (opts.onProgress || opts.onCase) ? frameProgress(opts.onProgress ?? (() => undefined), opts.onCase) : undefined;
  // The driver frames at most a build, a fatal and three per case (output, stderr, timeout).
  const { frames, flooded, outOfMemory, memoryKill } = await runDriver(track, IO_DRIVER, env, src, inputs, deadline, outputCap, 3 * caseCount + 8, progress);

  const buildFrame = frames.find((f) => f.kind === "build");
  const stderrOf = new Map(frames.filter((f) => f.kind === "stderr").map((f) => [f.name, f.body]));
  const timedOut = new Set(frames.filter((f) => f.kind === "timeout").map((f) => f.name));
  const cases = frames
    .filter((f) => f.kind === "case" || f.kind === "big" || f.kind === "gen")
    .map((f): RawCase => ({
      name: `${set}/${f.name}`, exit: f.exit, stdout: f.body, stderr: stderrOf.get(f.name) ?? "", big: f.kind === "big",
      ...(f.digest ? { digest: f.digest, bytes: f.bytes } : {}), ...(f.kind === "gen" ? { generator: true } : {}), ...(timedOut.has(f.name) ? { timedOut: true } : {}),
    }));
  const limits = { time_ms: timeMs, memory_mb: track.limits.memory_mb };
  return { ...(buildFrame ? { build: { exit: buildFrame.exit, output: buildFrame.body } } : {}), cases, flooded, limits, ...(outOfMemory ? { outOfMemory } : {}), ...(memoryKill ? { memoryKill } : {}) };
}

/** Runs one unit test set: the track's `test` command against `tests`. */
export async function runUnit(track: JudgeTrack, src: FileMap, tests: FileMap, opts: RunOptions = {}): Promise<UnitRun> {
  if (!track.test) throw new CodemmError("This track has no test command, so it can't run unit exercises.");
  const timeMs = opts.timeMs ?? track.limits.time_ms;
  const deadline = opts.deadlineMs ?? timeMs + SLACK_MS;
  const env = { CODEMM_TEST: track.test, ...timeEnv(timeMs) };
  const { frames, flooded, outOfMemory, memoryKill } = await runDriver(track, UNIT_DRIVER, env, src, tests, deadline, OUTPUT_CAP, 8);
  const report = frames.find((f) => f.kind === "report");
  const log = frames.find((f) => f.kind === "log");
  const limits = { time_ms: timeMs, memory_mb: track.limits.memory_mb };
  const timedOut = frames.some((f) => f.kind === "timeout" && f.name === "report");
  return { report: { exit: report?.exit ?? -1, body: report?.body ?? "", log: log?.body ?? "", ...(timedOut ? { timedOut } : {}) }, flooded, limits, ...(outOfMemory ? { outOfMemory } : {}), ...(memoryKill ? { memoryKill } : {}) };
}

/** Runs each given test set, visible first, each in its own container. `onSet` is told as a set starts and may return its options (progress). */
export async function runSets(
  track: JudgeTrack, style: "io" | "unit", src: FileMap, sets: Partial<Record<TestSet, FileMap>>,
  opts: { timeMs?: number; generatorMs?: number; stopAtError?: boolean; onSet?: (set: TestSet) => RunOptions | void } = {},
): Promise<Runs> {
  const runs: Runs = {};
  for (const set of ["visible", "hidden"] as const) {
    const tests = sets[set];
    if (!tests) continue;
    const { onSet, ...shared } = opts;
    const o: RunOptions = { ...shared, ...onSet?.(set) };
    runs[set] = style === "io" ? await runIo(track, set, src, tests, o) : await runUnit(track, src, tests, o);
  }
  return runs;
}

/** Runs the given test sets and grades them. */
export async function judgeSets(
  track: JudgeTrack, style: "io" | "unit", src: FileMap, sets: Partial<Record<TestSet, FileMap>>, exp: Expectation,
  opts: { timeMs?: number; onSet?: (set: TestSet) => RunOptions | void } = {},
): Promise<TestResult[]> {
  const runs = await runSets(track, style, src, sets, opts);
  // Each generator passed the gates three times, so one failing now is this computer (a slow moment) or the program
  // filling /tmp before it: not grounds for a grade either way, so nothing is recorded (DESIGN §4.3).
  if (generatorFailed(runs)) throw new CodemmError("A test's input couldn't be generated, so nothing was recorded. Retry; if it keeps happening, ask Codemm for a new exercise.");
  return gradeRuns(style, runs, exp);
}

/** Whether a test's input generator failed in any of these runs. */
export const generatorFailed = (runs: Runs) => Object.values(runs).some((r) => r !== undefined && "cases" in r && r.cases.some((c) => c.generator));
