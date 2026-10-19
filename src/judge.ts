import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodemmError, infraError } from "./errors.js";
import { type FileMap, writeFileMap } from "./files.js";
import { type CaseFrames, type Expectation, type Frame, frameProgress, gradeRuns, type IoRun, parseFrames, type RawCase, type Runs, type TestResult, type TestSet, type UnitRun } from "./grading.js";
import { BUSY_HELP, lostRun, runtimeDown, startRefusal, startSandboxed } from "./sandbox.js";

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
for f in /work/tests/*.in; do
  [ -e "$f" ] || continue
  n=$(basename "$f" .in)
  watch
  timeout -s KILL "$CODEMM_BACKSTOP_S" sh -c "$OOM$CODEMM_RUN" < "$f" > /tmp/o 2> /tmp/e; c=$?
  kill -9 -1 2>/dev/null
  head -c 4096 /tmp/e > /tmp/ec
  if [ $(($(wc -c < /tmp/o))) -gt 65536 ]; then : > /tmp/oc; emit big "$n" "$c" /tmp/oc; else emit case "$n" "$c" /tmp/o; fi
  emit stderr "$n" "$c" /tmp/ec
  [ -s /tmp/t ] && emit timeout "$n" "$c" /dev/null
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
    // A flood is the program's doing and is graded, even when removing its container was slow; the host kill makes the
    // exit code meaningless.
    if (result.flooded) return { frames: [], flooded: true };
    // The driver stops every case at its limit, so only a slow runtime reaches the host deadline.
    if (result.timedOut) throw infraError(`The check didn't finish in time, so nothing was recorded. The container runtime may be slow. ${BUSY_HELP}`, "check-timeout");
    if (result.cleanupFailed) throw infraError("A check container couldn't be removed, so nothing was recorded. Run `codemm doctor --fix`, then retry.", "container-remove");
    // The driver always ends with exit 0. Anything else means it was killed or the runtime failed, whatever was
    // printed so far. Only a memory-limit kill is the program's doing; everything else records nothing.
    if (result.exit !== 0) {
      const down = await runtimeDown();
      if (down) throw lostRun(down, ", so it wasn't counted");
      if (result.oomKilled) return { frames: [], flooded: false, outOfMemory: true };
      // 126 and 127 before the driver printed anything: the image can't run its /bin/sh. That's the track's to fix.
      if ((result.exit === 126 || result.exit === 127) && result.stdout.length === 0) {
        throw new CodemmError(`The track image can't run /bin/sh (exit ${result.exit}), which every check runs in. Base it on an image that has sh, ${DRIVER_TOOLS.join(", ")}.`);
      }
      // Exit 125 is the runtime's own failure. Its stderr is read for why, as a fixed phrase, but never shown: code that
      // had already started can write there too, and a check runs hidden tests and hidden code.
      if (result.exit === 125 && result.stdout.length === 0) {
        const { code, why } = startRefusal(result.stderr.slice(0, 2000));
        throw infraError(`The container couldn't start (${why}), so it wasn't counted. Run \`codemm doctor\`, then retry.`, code);
      }
      if (result.exit === -1) throw infraError("The container couldn't start. Run `codemm doctor`.", /ENOENT/.test(result.stderr) ? "no-runtime" : "container-start");
      throw infraError("The container runtime failed during the run, so it wasn't counted. Try again, and restart Docker if it happens again.", "runtime-failed");
    }
    const frames = parseFrames(result.stdout);
    // A working driver always reports at least one frame. None, or a runtime connection error, means the
    // runtime failed, not the learner's code, so nothing may be graded or recorded.
    if (frames.length === 0 || /cannot connect to the docker daemon|error during connect|connection refused/i.test(result.stderr)) {
      throw infraError("The container runtime failed during the run, so it wasn't counted. Try again, and restart Docker if it happens again.", "runtime-failed");
    }
    // Never echo a fatal frame's body: code in the container could forge one (DESIGN §4.2).
    if (frames.some((f) => f.kind === "fatal")) throw new CodemmError(`The track image is missing a tool Codemm needs: sh, ${DRIVER_TOOLS.join(", ")}.`);
    // A case or runner killed with 137 that the watchdog didn't mark as a time-out may have hit the memory limit while
    // the driver went on: only the runtime's record says so (DESIGN §4.3).
    const marked = new Set(frames.filter((f) => f.kind === "timeout").map((f) => f.name));
    const memoryKill = frames.some((f) => f.exit === 137 && (f.kind === "case" || f.kind === "report") && !marked.has(f.name)) && (await started.hadOomKill());
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
  const env: Record<string, string> = { CODEMM_RUN: track.run, ...timeEnv(timeMs) };
  if (track.build) env.CODEMM_BUILD = track.build;
  const { frames, flooded, outOfMemory, memoryKill } = await runDriver(track, IO_DRIVER, env, src, inputs, deadline, (opts.onProgress || opts.onCase) && frameProgress(opts.onProgress ?? (() => undefined), opts.onCase));

  const buildFrame = frames.find((f) => f.kind === "build");
  const stderrOf = new Map(frames.filter((f) => f.kind === "stderr").map((f) => [f.name, f.body]));
  const timedOut = new Set(frames.filter((f) => f.kind === "timeout").map((f) => f.name));
  const cases = frames
    .filter((f) => f.kind === "case" || f.kind === "big")
    .map((f): RawCase => ({ name: `${set}/${f.name}`, exit: f.exit, stdout: f.body, stderr: stderrOf.get(f.name) ?? "", big: f.kind === "big", ...(timedOut.has(f.name) ? { timedOut: true } : {}) }));
  const limits = { time_ms: timeMs, memory_mb: track.limits.memory_mb };
  return { ...(buildFrame ? { build: { exit: buildFrame.exit, output: buildFrame.body } } : {}), cases, flooded, limits, ...(outOfMemory ? { outOfMemory } : {}), ...(memoryKill ? { memoryKill } : {}) };
}

/** Runs one unit test set: the track's `test` command against `tests`. */
export async function runUnit(track: JudgeTrack, src: FileMap, tests: FileMap, opts: RunOptions = {}): Promise<UnitRun> {
  if (!track.test) throw new CodemmError("This track has no test command, so it can't run unit exercises.");
  const timeMs = opts.timeMs ?? track.limits.time_ms;
  const deadline = opts.deadlineMs ?? timeMs + SLACK_MS;
  const env = { CODEMM_TEST: track.test, ...timeEnv(timeMs) };
  const { frames, flooded, outOfMemory, memoryKill } = await runDriver(track, UNIT_DRIVER, env, src, tests, deadline);
  const report = frames.find((f) => f.kind === "report");
  const log = frames.find((f) => f.kind === "log");
  const limits = { time_ms: timeMs, memory_mb: track.limits.memory_mb };
  const timedOut = frames.some((f) => f.kind === "timeout" && f.name === "report");
  return { report: { exit: report?.exit ?? -1, body: report?.body ?? "", log: log?.body ?? "", ...(timedOut ? { timedOut } : {}) }, flooded, limits, ...(outOfMemory ? { outOfMemory } : {}), ...(memoryKill ? { memoryKill } : {}) };
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
