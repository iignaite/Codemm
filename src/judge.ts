import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodemmError } from "./errors.js";
import { type FileMap, writeFileMap } from "./files.js";
import { type CaseFrames, type Expectation, type Frame, frameProgress, gradeRuns, type IoRun, parseFrames, type RawCase, type Runs, type TestResult, type TestSet, type UnitRun } from "./grading.js";
import { runtimeDown, runtimeKind, startHelp, startSandboxed } from "./sandbox.js";

/** What the judge needs from an installed track. */
export type JudgeTrack = {
  image: string;
  build?: string | undefined;
  run?: string | undefined;
  test?: string | undefined;
  limits: { time_ms: number; memory_mb: number };
};
/** `onProgress`: "built" when the build is done, then how many io cases have finished, as each does (for progress, never grading). */
/** `onCase` hands over each io case as it finishes: pass it only for visible tests. */
export type RunOptions = { timeMs?: number; deadlineMs?: number; onProgress?: (milestone: "built" | number) => void; onCase?: (c: CaseFrames) => void };


export const BUILD_SECONDS = 60;
const SLACK_MS = 30_000;
/** What the driver needs in a track image besides `sh`. The track rules name them too (templates.ts). */
export const DRIVER_TOOLS = ["timeout", "sleep", "head", "wc", "cat", "basename"];
/** `timeout` and `sleep` take seconds; busybox and coreutils both accept decimals. */
export const seconds = (ms: number) => Math.max(0.1, ms / 1000).toFixed(3);

// The driver is PID 1. Program output only leaves the container inside a length-framed
// record, and `kill -9 -1` clears leftover processes between cases. Every command the track or learner
// supplies starts with $OOM, which makes it the out-of-memory killer's first choice (raising
// oom_score_adj needs no privilege), so a program that runs out of memory usually dies instead of the
// driver. It's best effort: the program could lower its score back to 0. If the write fails, nothing changes.
// Shell functions share variables, so emit() keeps its own (size) apart from the loop's case name (n).
const EMIT = `OOM='{ echo 1000 > /proc/self/oom_score_adj; } 2>/dev/null || :; '
emit() { size=$(($(wc -c < "$4"))); printf '\\n@@codemm %s %s %s %s\\n' "$1" "$2" "$3" "$size"; cat "$4"; }
for u in ${DRIVER_TOOLS.join(" ")}; do command -v "$u" >/dev/null 2>&1 || { echo "the image has no '$u'" > /tmp/m; emit fatal tools 1 /tmp/m; exit 0; }; done`;

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
done
exit 0`;

const UNIT_DRIVER = `${EMIT}
TESTS=/work/tests OUT=/tmp/report.json timeout -s KILL "$CODEMM_TIME_S" sh -c "$OOM$CODEMM_TEST" > /tmp/o 2>&1; c=$?
kill -9 -1 2>/dev/null
if [ -f /tmp/report.json ] && [ $(($(wc -c < /tmp/report.json))) -le 1048576 ]; then emit report report "$c" /tmp/report.json; else : > /tmp/r; emit report report "$c" /tmp/r; fi
head -c 4096 /tmp/o > /tmp/oc; emit log log "$c" /tmp/oc
exit 0`;

async function runDriver(track: JudgeTrack, script: string, env: Record<string, string>, src: FileMap, tests: FileMap, deadlineMs: number, onStdout?: (chunk: Buffer) => void): Promise<{ frames: Frame[]; flooded: boolean; outOfMemory?: boolean; memoryKill?: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), "codemm-run-"));
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
    }, onStdout ? { stdout: onStdout } : {});
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
      // Exit 125 is the runtime's own failure. With no output, no code ran, so its stderr is the runtime's own too.
      if (result.exit === 125 && result.stdout.length === 0) {
        const shown = result.stderr.trim().slice(0, 500);
        throw new CodemmError(`The container couldn't start: ${shown}`, runtimeKind(shown));
      }
      if (result.exit === -1) throw new CodemmError("The container couldn't start. Run `codemm doctor`.", "docker");
      throw new CodemmError("The container runtime failed during the run, so it wasn't counted. Run `codemm doctor`, then retry.", "docker");
    }
    const frames = parseFrames(result.stdout);
    // A working driver always reports at least one frame. None, or a runtime connection error, means the
    // runtime failed, not the learner's code, so nothing may be graded or recorded.
    if (frames.length === 0 || /cannot connect to the docker daemon|error during connect|connection refused/i.test(result.stderr)) {
      throw new CodemmError("The container runtime failed during the run, so it wasn't counted. Run `codemm doctor`, then retry.", "docker");
    }
    // Never echo a fatal frame's body: code in the container could forge one (DESIGN §4.2).
    if (frames.some((f) => f.kind === "fatal")) throw new CodemmError(`The track image is missing a tool Codemm needs: sh, ${DRIVER_TOOLS.join(", ")}.`);
    // A case or runner killed with 137 while the driver went on hit its time limit or the memory limit: only the
    // runtime's record tells which (DESIGN §4.3).
    const memoryKill = frames.some((f) => f.exit === 137 && ["case", "big", "report"].includes(f.kind)) && (await started.hadOomKill());
    return { frames, flooded: result.flooded, ...(memoryKill ? { memoryKill } : {}) };
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
  const { frames, flooded, outOfMemory, memoryKill } = await runDriver(track, IO_DRIVER, env, src, inputs, deadline, (opts.onProgress || opts.onCase) && frameProgress(opts.onProgress ?? (() => undefined), opts.onCase));

  const buildFrame = frames.find((f) => f.kind === "build");
  const stderrOf = new Map(frames.filter((f) => f.kind === "stderr").map((f) => [f.name, f.body]));
  const cases = frames
    .filter((f) => f.kind === "case" || f.kind === "big")
    .map((f): RawCase => ({ name: `${set}/${f.name}`, exit: f.exit, stdout: f.body, stderr: stderrOf.get(f.name) ?? "", big: f.kind === "big" }));
  const limits = { time_ms: timeMs, memory_mb: track.limits.memory_mb };
  return { ...(buildFrame ? { build: { exit: buildFrame.exit, output: buildFrame.body } } : {}), cases, flooded, limits, ...(outOfMemory ? { outOfMemory } : {}), ...(memoryKill ? { memoryKill } : {}) };
}

/** Runs one unit test set: the track's `test` command against `tests`. */
export async function runUnit(track: JudgeTrack, src: FileMap, tests: FileMap, opts: RunOptions = {}): Promise<UnitRun> {
  if (!track.test) throw new CodemmError("This track has no test command, so it can't run unit exercises.");
  const timeMs = opts.timeMs ?? track.limits.time_ms;
  const deadline = opts.deadlineMs ?? timeMs + SLACK_MS;
  const env = { CODEMM_TEST: track.test, CODEMM_TIME_S: seconds(timeMs) };
  const { frames, flooded, outOfMemory, memoryKill } = await runDriver(track, UNIT_DRIVER, env, src, tests, deadline);
  const report = frames.find((f) => f.kind === "report");
  const log = frames.find((f) => f.kind === "log");
  const limits = { time_ms: timeMs, memory_mb: track.limits.memory_mb };
  return { report: { exit: report?.exit ?? -1, body: report?.body ?? "", log: log?.body ?? "" }, flooded, limits, ...(outOfMemory ? { outOfMemory } : {}), ...(memoryKill ? { memoryKill } : {}) };
}

/** Runs each given test set, visible first, each in its own container. `onSet` is told as a set starts and may return its options (progress). */
export async function runSets(
  track: JudgeTrack, style: "io" | "unit", src: FileMap, sets: Partial<Record<TestSet, FileMap>>,
  opts: { timeMs?: number; onSet?: (set: TestSet) => RunOptions | void } = {},
): Promise<Runs> {
  const runs: Runs = {};
  for (const set of ["visible", "hidden"] as const) {
    const tests = sets[set];
    if (!tests) continue;
    const o: RunOptions = { ...(opts.timeMs === undefined ? {} : { timeMs: opts.timeMs }), ...opts.onSet?.(set) };
    runs[set] = style === "io" ? await runIo(track, set, src, tests, o) : await runUnit(track, src, tests, o);
  }
  return runs;
}

/** Runs the given test sets and grades them. */
export async function judgeSets(
  track: JudgeTrack, style: "io" | "unit", src: FileMap, sets: Partial<Record<TestSet, FileMap>>, exp: Expectation,
  opts: { timeMs?: number; onSet?: (set: TestSet) => RunOptions | void } = {},
): Promise<TestResult[]> {
  return gradeRuns(style, await runSets(track, style, src, sets, opts), exp);
}
