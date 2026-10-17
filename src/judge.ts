import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { CodemmError } from "./errors.js";
import { type FileMap, writeFileMap } from "./files.js";
import { frameProgress, gradeIo, gradeUnit, parseFrames, type RawBuild, type RawCase, type TestResult, type TestSet } from "./grading.js";
import { runSandboxed, runtimeDown, startHelp, startSandboxed } from "./sandbox.js";

/** What the judge needs from an installed track. */
export type JudgeTrack = {
  image: string;
  build?: string | undefined;
  run?: string | undefined;
  test?: string | undefined;
  limits: { time_ms: number; memory_mb: number };
};
/** `onProgress`: "built" when the build is done, then how many io cases have finished, as each does (for progress, never grading). */
export type RunOptions = { timeMs?: number; deadlineMs?: number; onProgress?: (milestone: "built" | number) => void };

/** `flooded` and `outOfMemory` mean the program got the whole container killed, so every test in the set is an error. */
export type IoRun = { build?: RawBuild; cases: RawCase[]; flooded: boolean; outOfMemory?: boolean };
export type UnitRun = { report: { exit: number; body: string; log: string }; flooded: boolean; outOfMemory?: boolean };

const BUILD_SECONDS = 60;
const SLACK_MS = 30_000;
/** `timeout` takes seconds; busybox and coreutils both accept decimals. */
const seconds = (ms: number) => Math.max(0.1, ms / 1000).toFixed(3);

// The driver is PID 1. Program output only leaves the container inside a length-framed
// record, and `kill -9 -1` clears leftover processes between cases. Every command the track or learner
// supplies starts with $OOM, which makes it the out-of-memory killer's first choice (raising
// oom_score_adj needs no privilege), so a program that runs out of memory usually dies instead of the
// driver. It's best effort: the program could lower its score back to 0. If the write fails, nothing changes.
const EMIT = `OOM='{ echo 1000 > /proc/self/oom_score_adj; } 2>/dev/null || :; '
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
done
exit 0`;

const UNIT_DRIVER = `${EMIT}
TESTS=/work/tests OUT=/tmp/report.json timeout -s KILL "$CODEMM_TIME_S" sh -c "$OOM$CODEMM_TEST" > /tmp/o 2>&1; c=$?
kill -9 -1 2>/dev/null
if [ -f /tmp/report.json ] && [ $(($(wc -c < /tmp/report.json))) -le 1048576 ]; then emit report report "$c" /tmp/report.json; else : > /tmp/r; emit report report "$c" /tmp/r; fi
head -c 4096 /tmp/o > /tmp/oc; emit log log "$c" /tmp/oc
exit 0`;

async function runDriver(track: JudgeTrack, script: string, env: Record<string, string>, src: FileMap, tests: FileMap, deadlineMs: number, onStdout?: (chunk: Buffer) => void) {
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
      ...(onStdout ? { onStdout } : {}),
    });
    if (result.cleanupFailed) throw new CodemmError("A check container couldn't be removed, so nothing was recorded. Run `codemm doctor --fix`, then retry.");
    if (result.timedOut) throw new CodemmError("The check didn't finish in time, so nothing was recorded. Check that the container runtime is healthy and retry.");
    // A flood is the program's doing and is graded; the host kill makes the exit code meaningless.
    if (result.flooded) return { frames: [], flooded: true };
    // The driver always ends with exit 0. Anything else means it was killed or the runtime failed, whatever was
    // printed so far. Only a memory-limit kill is the program's doing; everything else records nothing.
    if (result.exit !== 0) {
      if (await runtimeDown()) throw new CodemmError(`The container runtime stopped during the run, so it wasn't counted. ${startHelp()}`);
      if (result.oomKilled) return { frames: [], flooded: false, outOfMemory: true };
      // Exit 125 is the runtime's own failure. With no output, no code ran, so its stderr is the runtime's own too.
      if (result.exit === 125 && result.stdout.length === 0) throw new CodemmError(`The container couldn't start: ${result.stderr.trim().slice(0, 500)}`);
      if (result.exit === -1) throw new CodemmError("The container couldn't start. Run `codemm doctor`.");
      throw new CodemmError("The container runtime failed during the run, so it wasn't counted. Run `codemm doctor`, then retry.");
    }
    const frames = parseFrames(result.stdout);
    // A working driver always reports at least one frame. None, or a runtime connection error, means the
    // runtime failed, not the learner's code, so nothing may be graded or recorded.
    if (frames.length === 0 || /cannot connect to the docker daemon|error during connect|connection refused/i.test(result.stderr)) {
      throw new CodemmError("The container runtime failed during the run, so it wasn't counted. Run `codemm doctor`, then retry.");
    }
    // Never echo a fatal frame's body: code in the container could forge one (DESIGN §4.2).
    if (frames.some((f) => f.kind === "fatal")) throw new CodemmError("The track image is missing a tool Codemm needs (sh, timeout, head, wc, cat or basename).");
    return { frames, flooded: result.flooded };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** How long Run lets a program wait for typing and run: a person types, so longer than a test case gets. */
export const RUN_LIMIT_MS = 120_000;

// The shell stays PID 1 (no exec), so timeout's kill reaches the program; a kill aimed at PID 1 from inside is
// ignored. `kill -9 -1` clears what the program left behind (a script's own child can outlive its shell).
// Markers on stderr say when each stage starts and how it ended, then the driver exits 0: an end marker means
// the driver finished, whatever the program printed or returned, and the host times each stage from its start.
const PROGRAM_DRIVER = `mark() { printf '\\n@@codemm-run %s\\n' "$*" >&2; }
if [ -n "\${CODEMM_BUILD:-}" ]; then
  mark start build
  timeout -s KILL "$CODEMM_BUILD_S" sh -c "$CODEMM_BUILD"; c=$?
  if [ "$c" != 0 ]; then kill -9 -1 2>/dev/null; mark end build "$c"; exit 0; fi
fi
mark start run
timeout -s KILL "$CODEMM_TIME_S" sh -c "$CODEMM_RUN"; c=$?
kill -9 -1 2>/dev/null
mark end run "$c"
exit 0`;

/**
 * `stage`: where it ended, the build or the run. `timedOut`: that stage's time limit killed it. `stopped`: the
 * learner stopped it. `outOfMemory`: the runtime recorded a memory-limit kill. `exit` is the program's own code.
 */
export type ProgramResult = { exit: number; stage?: "build" | "run"; timedOut: boolean; flooded: boolean; stopped?: boolean; outOfMemory?: boolean };
export type ProgramRun = { write(text: string): boolean; kill(): void; done: Promise<ProgramResult> };
export type ProgramLimits = { limitMs?: number; buildLimitMs?: number };

/**
 * Run: the learner's program, interactively, with typed stdin and its output as it comes. Only the learner's
 * files are mounted, never tests. The build, then the run command, in the full sandbox, time-limited. Not graded.
 */
export function runProgram(track: JudgeTrack, src: FileMap, output: (text: string, stream: "stdout" | "stderr") => void, limits: ProgramLimits = {}): ProgramRun {
  if (!track.run) throw new CodemmError("This track has no run command, so Run isn't available.");
  const limitMs = limits.limitMs ?? RUN_LIMIT_MS;
  const buildLimitMs = limits.buildLimitMs ?? BUILD_SECONDS * 1000;
  const dir = mkdtempSync(join(tmpdir(), "codemm-run-"));
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  const say = (stream: "stdout" | "stderr", text: string) => text && output(text, stream);
  const began = Date.now();
  const stageStart: Partial<Record<"build" | "run", number>> = {};
  let ended: { stage: "build" | "run"; code: number; at: number } | undefined;
  const markers = runMarkers(
    (text) => say("stderr", text),
    ([what, stage, code]) => {
      if (stage !== "build" && stage !== "run") return;
      if (what === "start") stageStart[stage] = Date.now();
      if (what === "end" && code !== undefined && /^\d+$/.test(code)) ended = { stage, code: Number(code), at: Date.now() };
    },
  );
  let stopped = false;
  let started: ReturnType<typeof startSandboxed>;
  try {
    writeFileMap(join(dir, "src"), src);
    const env: Record<string, string> = { CODEMM_RUN: track.run, CODEMM_TIME_S: seconds(limitMs), CODEMM_BUILD_S: seconds(buildLimitMs) };
    if (track.build) env.CODEMM_BUILD = track.build;
    started = startSandboxed(
      {
        image: track.image,
        script: PROGRAM_DRIVER,
        env,
        mounts: [{ host: join(dir, "src"), container: "/work/src" }],
        memoryMb: track.limits.memory_mb,
        deadlineMs: (track.build ? buildLimitMs : 0) + limitMs + 5_000,
        stdin: true,
      },
      { stdout: (b) => say("stdout", decoders.stdout.write(b)), stderr: (b) => markers.write(decoders.stderr.write(b)) },
    );
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const done = started.done
    .then((r): ProgramResult => {
      say("stdout", decoders.stdout.end());
      markers.write(decoders.stderr.end());
      markers.end();
      if (r.cleanupFailed) throw new CodemmError("A run container couldn't be removed. Run `codemm doctor --fix`, then retry.");
      // What Codemm stopped first: the learner, the host deadline or the output cap.
      if (stopped || r.timedOut || r.flooded) return { exit: r.exit, timedOut: r.timedOut, flooded: r.flooded, ...(stopped ? { stopped } : {}) };
      const memory = r.oomKilled ? { outOfMemory: true } : {};
      if (ended) {
        // Killed (137) once its stage's time was up: it ran out of time. Any other code is the program's own.
        const limit = ended.stage === "build" ? buildLimitMs : limitMs;
        const timedOut = ended.code === 137 && ended.at - (stageStart[ended.stage] ?? began) >= limit - 50;
        return { exit: ended.code, stage: ended.stage, timedOut, flooded: false, ...memory };
      }
      // No end marker: the driver itself was killed. Only a memory-limit kill is the program's doing.
      if (r.oomKilled) return { exit: 137, timedOut: false, flooded: false, ...memory };
      throw new CodemmError(`The container runtime failed during the run. ${startHelp()}`);
    })
    .finally(() => rmSync(dir, { recursive: true, force: true }));
  return {
    write: started.write,
    kill: () => {
      stopped = true;
      started.kill();
    },
    done,
  };
}

const MARK = "\n@@codemm-run ";

/**
 * Splits the driver's markers ("\n@@codemm-run <fields>\n") out of Run's stderr as it streams. The program's own
 * text passes through at once, except a tail that could still become a marker, which waits for the next chunk.
 */
export function runMarkers(onText: (text: string) => void, onMarker: (fields: string[]) => void) {
  let held = "";
  const text = (t: string) => t && onText(t);
  return {
    write(chunk: string) {
      let buf = held + chunk;
      held = "";
      for (;;) {
        const at = buf.indexOf(MARK);
        if (at < 0) {
          let keep = Math.min(buf.length, MARK.length - 1);
          while (keep > 0 && !MARK.startsWith(buf.slice(buf.length - keep))) keep--;
          text(buf.slice(0, buf.length - keep));
          held = buf.slice(buf.length - keep);
          return;
        }
        text(buf.slice(0, at));
        const end = buf.indexOf("\n", at + MARK.length);
        if (end < 0) {
          // A real marker is short; a long line that only starts like one is the program's own text.
          if (buf.length - at > 256) text(buf.slice(at));
          else held = buf.slice(at);
          return;
        }
        onMarker(buf.slice(at + MARK.length, end).split(" "));
        buf = buf.slice(end + 1);
      }
    },
    end() {
      text(held);
      held = "";
    },
  };
}

/** Runs one io test set. `inputs` holds `NN.in` files. Case names come back as `<set>/NN`. */
export async function runIo(track: JudgeTrack, set: TestSet, src: FileMap, inputs: FileMap, opts: RunOptions = {}): Promise<IoRun> {
  if (!track.run) throw new CodemmError("This track has no run command, so it can't run io exercises.");
  const timeMs = opts.timeMs ?? track.limits.time_ms;
  const caseCount = Object.keys(inputs).filter((p) => p.endsWith(".in")).length;
  const deadline = opts.deadlineMs ?? BUILD_SECONDS * 1000 + caseCount * (timeMs + 1000) + SLACK_MS;
  const env: Record<string, string> = { CODEMM_RUN: track.run, CODEMM_TIME_S: seconds(timeMs) };
  if (track.build) env.CODEMM_BUILD = track.build;
  const { frames, flooded, outOfMemory } = await runDriver(track, IO_DRIVER, env, src, inputs, deadline, opts.onProgress && frameProgress(opts.onProgress));

  const buildFrame = frames.find((f) => f.kind === "build");
  const stderrOf = new Map(frames.filter((f) => f.kind === "stderr").map((f) => [f.name, f.body]));
  const cases = frames
    .filter((f) => f.kind === "case" || f.kind === "big")
    .map((f): RawCase => ({ name: `${set}/${f.name}`, exit: f.exit, stdout: f.body, stderr: stderrOf.get(f.name) ?? "", big: f.kind === "big" }));
  return { ...(buildFrame ? { build: { exit: buildFrame.exit, output: buildFrame.body } } : {}), cases, flooded, ...(outOfMemory ? { outOfMemory } : {}) };
}

/** Runs one unit test set: the track's `test` command against `tests`. */
export async function runUnit(track: JudgeTrack, src: FileMap, tests: FileMap, opts: RunOptions = {}): Promise<UnitRun> {
  if (!track.test) throw new CodemmError("This track has no test command, so it can't run unit exercises.");
  const timeMs = opts.timeMs ?? track.limits.time_ms;
  const deadline = opts.deadlineMs ?? timeMs + SLACK_MS;
  const env = { CODEMM_TEST: track.test, CODEMM_TIME_S: seconds(timeMs) };
  const { frames, flooded, outOfMemory } = await runDriver(track, UNIT_DRIVER, env, src, tests, deadline);
  const report = frames.find((f) => f.kind === "report");
  const log = frames.find((f) => f.kind === "log");
  return { report: { exit: report?.exit ?? -1, body: report?.body ?? "", log: log?.body ?? "" }, flooded, ...(outOfMemory ? { outOfMemory } : {}) };
}

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
