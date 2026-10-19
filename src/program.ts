// Run (DESIGN §4.3): the learner's program, interactively, in the sandbox, with typed stdin and its output as it
// comes. Never graded or recorded. The checks' test sets run in judge.ts.
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { CodemmError } from "./errors.js";
import { type FileMap, writeFileMap } from "./files.js";
import { BUILD_SECONDS, type JudgeTrack, seconds } from "./judge.js";
import { stageRunFolder } from "./runs.js";
import { runtimeKind, startHelp, startSandboxed } from "./sandbox.js";

/** How long Run lets a program wait for typing and run: a person types, so longer than a test case gets. */
export const RUN_LIMIT_MS = 120_000;

// Each stage runs in the foreground, so it keeps the typed stdin, with a watchdog beside it. At the limit the
// watchdog says so first (a timeout marker), then `kill -9 -1` stops everything but the driver: the shell stays
// PID 1 (no exec), and a kill aimed at PID 1 from inside is ignored. So a timeout is the driver's own statement, never
// read from an exit code or from timing, and it needs no `timeout` tool. Markers on stderr say when each stage starts
// and how it ended, then the driver exits 0: an end marker means the driver finished, whatever the program printed or
// returned. A program can print a marker too, but the driver's end marker comes last, and a forged timeout only
// mislabels the program's own unrecorded run. If `sleep` fails, the watchdog stays quiet and the host deadline stops
// the run instead; grading checks for `sleep`, so an installed track has it. A shell reports a killed command
// ("Killed") on the stderr that command was given, so the program takes the real stderr back itself (from fd 3) while
// the driver's goes to /dev/null as it waits: Codemm's own "time's up" is the only word on it.
const PROGRAM_DRIVER = `mark() { printf '\\n@@codemm-run %s\\n' "$*" >&2; }
limited() {
  ( sleep "$2" 2>/dev/null && { mark timeout "$1"; kill -9 -1 2>/dev/null; } ) &
  w=$!
  { sh -c "exec 2>&3 3>&-; $3"; c=$?; } 3>&2 2>/dev/null
  kill -9 "$w" 2>/dev/null; kill -9 -1 2>/dev/null
}
if [ -n "\${CODEMM_BUILD:-}" ]; then
  mark start build
  limited build "$CODEMM_BUILD_S" "$CODEMM_BUILD"
  if [ "$c" != 0 ]; then mark end build "$c"; exit 0; fi
fi
mark start run
limited run "$CODEMM_TIME_S" "$CODEMM_RUN"
mark end run "$c"
exit 0`;

/**
 * `stage`: where it ended, the build or the run. `timedOut`: that stage's time limit killed it. `stopped`: the
 * learner stopped it. `outOfMemory`: the runtime recorded a memory-limit kill. `exit` is the program's own code.
 */
export type ProgramResult = { exit: number; stage?: "build" | "run"; timedOut: boolean; flooded: boolean; stopped?: boolean; outOfMemory?: boolean };
/** `end` closes the program's input, so one that reads until the end can finish; it does nothing once it ran. */
export type ProgramRun = { write(text: string): boolean; end(): void; kill(): void; done: Promise<ProgramResult> };
/** Time limits, and `onStart`, told once as each stage starts with that stage's limit (for a countdown). */
export type ProgramOptions = { limitMs?: number; buildLimitMs?: number; onStart?: (stage: "build" | "run", limitMs: number) => void };

/**
 * Run: the learner's program, interactively, with typed stdin and its output as it comes. Only the learner's
 * files are mounted, never tests. The build, then the run command, in the full sandbox, time-limited. Not graded.
 */
export function runProgram(track: JudgeTrack, src: FileMap, output: (text: string, stream: "stdout" | "stderr") => void, limits: ProgramOptions = {}): ProgramRun {
  if (!track.run) throw new CodemmError("This track has no run command, so Run isn't available.");
  const limitMs = limits.limitMs ?? RUN_LIMIT_MS;
  const buildLimitMs = limits.buildLimitMs ?? BUILD_SECONDS * 1000;
  const folder = stageRunFolder();
  const dir = folder.dir;
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  const say = (stream: "stdout" | "stderr", text: string) => text && output(text, stream);
  let ended: { stage: "build" | "run"; code: number } | undefined;
  let timedOutIn: "build" | "run" | undefined;
  const begun = new Set<"build" | "run">();
  // What the runtime printed before the driver started: with exit 125 and nothing on stdout, no code ran, so
  // it's the runtime's own reason for not starting.
  let beforeStart = "";
  let printed = false;
  const markers = runMarkers(
    (text) => {
      if (begun.size === 0 && beforeStart.length < 2000) beforeStart += text;
      say("stderr", text);
    },
    ([what, stage, code]) => {
      if (stage !== "build" && stage !== "run") return;
      if (what === "end" && code !== undefined && /^\d+$/.test(code)) ended = { stage, code: Number(code) };
      if (what === "timeout") timedOutIn = stage;
      if (what === "start" && !begun.has(stage)) {
        begun.add(stage);
        limits.onStart?.(stage, stage === "build" ? buildLimitMs : limitMs);
      }
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
      { stdout: (b) => ((printed ||= b.length > 0), say("stdout", decoders.stdout.write(b))), stderr: (b) => markers.write(decoders.stderr.write(b)) },
    );
  } catch (e) {
    folder.remove();
    throw e;
  }
  const done = started.done
    .then(async (r): Promise<ProgramResult> => {
      say("stdout", decoders.stdout.end());
      markers.write(decoders.stderr.end());
      markers.end();
      if (r.cleanupFailed) throw new CodemmError("A run container couldn't be removed. Run `codemm doctor --fix`, then retry.", "docker");
      // What Codemm stopped first: the learner, the host deadline or the output cap.
      if (stopped || r.timedOut || r.flooded) return { exit: r.exit, timedOut: r.timedOut, flooded: r.flooded, ...(stopped ? { stopped } : {}) };
      if (ended) {
        // The watchdog's marker says the stage timed out. Otherwise a 137 may be the memory limit killing the program while the driver went on.
        const timedOut = timedOutIn === ended.stage;
        const memory = !timedOut && ended.code === 137 && (await started.hadOomKill()) ? { outOfMemory: true } : {};
        return { exit: ended.code, stage: ended.stage, timedOut, flooded: false, ...memory };
      }
      // No end marker: the driver itself was killed. Only a memory-limit kill is the program's doing.
      if (r.oomKilled) return { exit: 137, timedOut: false, flooded: false, outOfMemory: true };
      if (r.exit === 125 && !printed && begun.size === 0 && beforeStart.trim()) {
        const shown = beforeStart.trim().slice(0, 500);
        throw new CodemmError(`The container couldn't start: ${shown}`, runtimeKind(shown));
      }
      throw new CodemmError(`The container runtime failed during the run. ${startHelp()}`, "docker");
    })
    .finally(folder.remove);
  return {
    write: started.write,
    end: started.end,
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
