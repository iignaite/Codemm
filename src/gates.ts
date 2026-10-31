import { judgeTrack, trackImageTag } from "./store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodemmError, infraError } from "./errors.js";
import { type FileMap, subMap, validateFileMap, writeFileMap } from "./files.js";
import { CASE_OUTPUT_MB, caseDigest, type Expected, gradeRuns, type IoRun, type RawCase, recordOutput, redact, type Runs, type TestResult, type UnitRun } from "./grading.js";
import { GENERATOR_SECONDS, generatorFailed, type JudgeTrack, runSets, type WasiToolchain } from "./judge.js";
import { buildImage, type BuildStep, inspectImage } from "./sandbox.js";
import {
  type CourseRecord, type ExerciseRecord, type ExerciseSpec, LIMITS, parseExerciseYaml, parseTrackYaml, type Style, type TrackRecord, type TrackSpec,
  type WasiRecord,
} from "./schemas.js";
import { ensureToolchain } from "./toolchain.js";
import { compileModule, wasmtime } from "./wasi.js";

/**
 * A gate failed: the track's or the exercise's to fix. The message names the gate and never contains hidden inputs or
 * outputs. This computer's problems are never gate failures: they throw with their own code (errors.ts INFRA).
 */
export class GateError extends CodemmError {
  constructor(gate: string, details: string, output = "") {
    super(`Gate "${gate}" failed: ${details}${output}`);
  }
}



type Sets = { visible: FileMap; hidden: FileMap };

/** One line per test. Hidden tests show only an index and a status. */
function summarize(tests: TestResult[]): string {
  return redact(tests)
    .map((t) => {
      if (t.index !== undefined) return `  ${t.name}: ${t.status}`;
      const detail = [t.message, t.actual !== undefined ? `printed: ${JSON.stringify(t.actual.slice(0, 300))}` : ""].filter(Boolean).join("; ");
      return `  ${t.name}: ${t.status}${detail ? ` (${detail})` : ""}`;
    })
    .join("\n");
}

/**
 * One line per test, with its status only: for the reference, whose messages and output come from running hidden
 * code (a compiler error or a traceback can quote it). Visible tests are named, so the agent knows which to fix;
 * hidden ones stay numbered.
 */
const statuses = (tests: TestResult[]) => redact(tests).map((t) => `  ${t.name}: ${t.status}`).join("\n");

/**
 * The end of what a track's own run printed (its build, or a probe's test runner): the last 40 lines and 4 KB.
 * Track gates show it so the agent can see why its track failed. Probes are track code the agent wrote, not
 * exercise material; exercise gates never show what the reference printed.
 */
function tail(text: string): string {
  const lines = text.trimEnd().split("\n").slice(-40).join("\n");
  const bytes = Buffer.from(lines);
  // Cut by bytes, dropping a character the cut split.
  return bytes.length > 4096 ? `…${bytes.subarray(-4096).toString("utf8").replace(/^\uFFFD+/, "")}` : lines;
}
/** What a run printed, unless the lines above (\`shown\`) already show it. */
function printed(text: string, shown = ""): string {
  const end = tail(text).trim();
  return end && !shown.includes(end) ? `\nIt printed:\n${end}` : "";
}

/** The first lines of text, at most `count` lines and `max` bytes, cut at a line. */
function head(lines: string[], count: number, max: number): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines.slice(0, count)) {
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > max) break;
    kept.push(line);
  }
  return kept;
}

/**
 * What a failed track build printed. BuildKit ends its log with a summary that repeats the failing step's last lines
 * and quotes the Dockerfile, which would fill the last 40 lines and push out the tool's own error, often its first
 * line. So for BuildKit this is the failing step's own output: its first 10 lines and its last 30, each at most 300
 * characters, within 4 KB.
 * Any other builder's log ends with the failing command's output, so it is the end of the log.
 */
export function buildOutput(log: string): string {
  const failed = [...log.matchAll(/^#(\d+) ERROR: /gm)].at(-1)?.[1];
  if (!failed) return tail(log);
  // A step's lines are `#N <seconds> <text>`, or `#N <text>` for its header, DONE and ERROR lines. The header and the
  // ERROR line quote the whole command, which can be longer than the budget, so a longer line keeps its first and last
  // 150 characters (the ERROR line's exit code is at its end).
  const step = new RegExp(`^#${failed} (?:\\d+\\.\\d+ )?(.*)$`);
  const lines = log
    .split(/\r?\n/)
    .flatMap((line) => step.exec(line)?.slice(1, 2) ?? [])
    .map((line) => (line.length > 300 ? `${line.slice(0, 150)}…${line.slice(-150)}` : line));
  if (lines.length === 0) return tail(log);
  if (lines.length <= 40 && Buffer.byteLength(lines.join("\n")) <= 4096) return lines.join("\n");
  const first = head(lines, 10, 1024);
  const last = head(lines.slice(first.length).reverse(), 30, 3000).reverse();
  return [...first, ...(first.length + last.length < lines.length ? ["…"] : []), ...last].join("\n");
}

/** What a probe's run printed: a unit runner's own output, or io's build output and each case's errors. */
function probeOutput(runs: Runs): string {
  const unit = runs.visible as UnitRun;
  if (unit && "report" in unit) return unit.report.log;
  const io = runs.visible as IoRun;
  return [io.build?.output ?? "", ...io.cases.map((c) => c.stderr)].filter((t) => t.trim()).join("\n");
}

/**
 * Why a unit reference failed, by status only (its messages and output come from running hidden code). When the
 * runner reported no test (one `report` result), the statuses alone don't say why, so it adds what Codemm itself knows:
 * a time, memory or output limit stopped the runner, or else the tests or the reference didn't load. Never its output.
 */
export function unitReferenceFailure(tests: TestResult[], visible: UnitRun): string {
  const lines = `the reference must pass every test:\n${statuses(tests)}`;
  const shown = tests.filter((t) => t.set === "visible");
  if (shown.length !== 1 || shown[0]!.name !== "visible/report" || shown[0]!.status !== "error") return lines;
  if (visible.flooded || visible.outOfMemory || visible.memoryKill || visible.report.timedOut) {
    return `${lines}\nThe test runner was stopped at a time, memory or output limit before it reported any test. Make the reference and the tests lighter, and check for a loop.`;
  }
  return (
    `${lines}\nThe test runner stopped before reporting any test, so the tests or the reference didn't load. Check that ` +
    "the tests import the learner files at the track's paths the way the example tests in contract.examples do, that " +
    "the reference has no syntax or import errors, and that it holds every learner file. Codemm doesn't show the " +
    "runner's output, because it can quote the reference."
  );
}

/** A reference must still pass within a third of the time limit (DESIGN §6). */
const fastMs = (limits: { time_ms: number }) => Math.max(100, Math.floor(limits.time_ms / 3));
/**
 * A new track's pass probe must pass within a sixth, so every reference has twice the probe's time: a probe that only
 * fit a third left frameworks that start per io case flaky at every exercise's "reference fast" gate. Where time_ms
 * can't be raised (at its ceiling), and on a rebuild (an installed track's files can't change, nor can its courses'
 * track), it keeps the third it was installed under.
 */
export function probeFastMs(limits: { time_ms: number }, { rebuild = false } = {}): number {
  return rebuild || limits.time_ms >= LIMITS.time_ms.max ? fastMs(limits) : Math.max(100, Math.floor(limits.time_ms / 6));
}

const allPass = (tests: TestResult[]) => tests.length > 0 && tests.every((t) => t.status === "pass");

// ---------- tracks ----------

function probe(files: FileMap, spec: TrackSpec, style: Style) {
  const base = `probe/${style}`;
  const pass = subMap(files, `${base}/pass`);
  const fail = subMap(files, `${base}/fail`);
  const tests = subMap(files, `${base}/tests`);
  for (const [label, src] of [["pass", pass], ["fail", fail]] as const) {
    for (const f of spec.files) if (!(f in src)) throw new GateError("valid", `${base}/${label}/ must contain ${f}.`);
  }
  if (Object.keys(tests).length === 0) throw new GateError("valid", `${base}/tests/ is empty.`);
  const expected: Record<string, string> = {};
  if (style === "io") {
    for (const p of Object.keys(tests).filter((p) => p.endsWith(".in"))) {
      const out = tests[`${p.slice(0, -3)}.out`];
      if (out === undefined) throw new GateError("valid", `${base}/tests/${p} needs a matching .out file.`);
      expected[`visible/${p.slice(0, -3)}`] = out;
    }
    if (Object.keys(expected).length === 0) throw new GateError("valid", `${base}/tests/ needs at least one NN.in with NN.out.`);
  }
  const inputs = style === "io" ? Object.fromEntries(Object.entries(tests).filter(([p]) => p.endsWith(".in"))) : tests;
  return { pass, fail, inputs, expected };
}

/** Base images the Dockerfile names without a digest, skipping `scratch` and earlier stages (DESIGN §4.4). */
export function unpinnedBases(dockerfile: string): string[] {
  const stages = new Set(["scratch"]);
  const args = new Map<string, string>();
  const unpinned: string[] = [];
  let seenFrom = false;
  for (const line of dockerfile.replace(/\\\r?\n/g, " ").split("\n")) {
    // Only ARGs declared before the first FROM can be used in a FROM.
    const arg = /^\s*ARG\s+(\w+)=(\S+)/i.exec(line);
    if (arg && !seenFrom) args.set(arg[1]!, arg[2]!.replace(/^(["'])(.*)\1$/, "$2"));
    const m = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (!m) continue;
    seenFrom = true;
    const base = m[1]!.replace(/\$\{?(\w+)\}?/g, (_, name: string) => args.get(name) ?? "");
    if (!stages.has(base.toLowerCase()) && !base.includes("@sha256:")) unpinned.push(base);
    if (m[2]) stages.add(m[2].toLowerCase());
  }
  return unpinned;
}

/** Builds a track image and runs its probes (DESIGN §6, track gates 2-5). */
const MAX_EXAMPLE_BYTES = 65_536;

/** Track gate 1's file checks: track.yaml, one engine (a Dockerfile or a wasi block) and complete probes, before anything is built. */
export function checkTrackFiles(files: FileMap) {
  validateFileMap(files);
  if (!files["track.yaml"]) throw new GateError("valid", "A track needs track.yaml.");
  const spec = parseTrackYaml(files["track.yaml"]);
  if (spec.wasi && files.Dockerfile) {
    throw new GateError("valid", "A track runs on Docker (a Dockerfile) or on the WASI engine (a wasi block in track.yaml), not both. Remove one.");
  }
  if (!spec.wasi && !files.Dockerfile) throw new GateError("valid", "A track needs a Dockerfile, or a wasi block in track.yaml to run on the WASI engine.");
  for (const style of spec.styles) {
    // Every author receives the pass probe and its tests as the track's worked example (next_step), so keep them small.
    const bytes = Object.entries(files)
      .filter(([p]) => p.startsWith(`probe/${style}/pass/`) || p.startsWith(`probe/${style}/tests/`))
      .reduce((n, [, text]) => n + Buffer.byteLength(text), 0);
    if (bytes > MAX_EXAMPLE_BYTES) {
      throw new GateError("valid", `probe/${style}/pass and probe/${style}/tests total ${bytes} bytes. Keep them under 64 KB: authors read them as the track's example.`);
    }
  }
  return { spec, probes: spec.styles.map((style) => ({ style, ...probe(files, spec, style) })) };
}

/**
 * A track install's progress: each build step as counts, or a WASI toolchain's download, then the probes (DESIGN §4.4,
 * §4.5). Never the build's output.
 */
export type TrackProgress = ({ phase: "building" } & BuildStep) | { phase: "downloading" } | { phase: "checking" };

type Probes = ReturnType<typeof checkTrackFiles>["probes"];

/** Verifies a track (DESIGN §6, track gates 2-5): builds its image, or downloads its WASI toolchain, then runs its probes. */
/**
 * `rebuild`: the track is installed, so its probes keep the speed they were installed under, and a WASI toolchain is
 * downloaded again to `recorded`, the digest its install recorded.
 */
export async function verifyTrack(
  files: FileMap, tag?: string, onProgress?: (p: TrackProgress) => void, { rebuild = false, recorded }: { rebuild?: boolean; recorded?: string } = {},
): Promise<{ spec: TrackSpec; image: string; imageId: string; warning?: string } | { spec: TrackSpec; wasi: WasiRecord; warning?: string }> {
  const { spec, probes } = checkTrackFiles(files);
  if (spec.wasi) return verifyWasiTrack(spec, { ...spec.wasi, sha256: spec.wasi.sha256 ?? recorded }, probes, onProgress, rebuild);

  const image = tag ?? trackImageTag(spec.id, spec.version);
  const context = mkdtempSync(join(tmpdir(), "codemm-build-"));
  let builtId = "";
  try {
    writeFileMap(context, files);
    const built = await buildImage(context, image, undefined, onProgress && ((step) => onProgress({ phase: "building", ...step })));
    builtId = built.imageId ?? "";
    // Offline, out of disk or no runtime isn't the track's fault, so it's no gate failure.
    if (built.problem) throw infraError(built.problem.message, built.problem.code);
    if (!built.ok) {
      const end = buildOutput(built.log).trim();
      throw new GateError("build", "the image didn't build.", end ? `\nIt printed:\n${end}` : "");
    }
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
  // Inspect the image this build produced, not the shared tag, which another build may have moved since.
  const info = await inspectImage(builtId);
  if (!info) throw new GateError("build", "the built image can't be found.");
  if (info.hasVolumes) throw new GateError("build", "the image declares a VOLUME. Remove it; checks may only write to /tmp.");

  // Run by immutable ID so a retagged image can't change what was verified.
  onProgress?.({ phase: "checking" });
  await runProbes({ ...spec, wasi: undefined, image: info.id }, spec, probes, rebuild);
  const unpinned = unpinnedBases(files.Dockerfile!);
  const warning = unpinned.length > 0
    ? `Base image not pinned by digest: ${unpinned.join(", ")}. A later rebuild may pull a different image and fail its gates. Pin it as image@sha256:<digest> in the next version.`
    : undefined;
  return { spec, image, imageId: info.id, ...(warning ? { warning } : {}) };
}

/**
 * A WASI track's gates 2-5: its toolchain downloads, matches its SHA-256 and unpacks, then the same probes (DESIGN
 * §4.5). No Docker. A rebuild downloads it again and replaces the stored folder, so a damaged one is repaired.
 */
async function verifyWasiTrack(
  spec: TrackSpec, block: NonNullable<TrackSpec["wasi"]>, probes: Probes, onProgress: ((p: TrackProgress) => void) | undefined, rebuild: boolean,
): Promise<{ spec: TrackSpec; wasi: WasiRecord; warning?: string }> {
  // Before downloading: without wasmtime 50 (the infrastructure error no-wasmtime), nothing could run the probes.
  wasmtime();
  onProgress?.({ phase: "downloading" });
  const { module, dirs, env } = block;
  let toolchain: WasiToolchain;
  try {
    const { root, sha256 } = await ensureToolchain(block, { replace: rebuild });
    toolchain = { root, sha256, module, dirs, env };
    // Once, at install (and again on a rebuild), so no case pays for compiling.
    await compileModule(toolchain);
  } catch (e) {
    // The track's link, digest, archive or module is wrong (no infrastructure code).
    if (e instanceof CodemmError && !e.code) throw new GateError("toolchain", e.message);
    throw e;
  }
  const { sha256 } = toolchain;
  onProgress?.({ phase: "checking" });
  await runProbes({ ...spec, image: "", wasi: toolchain }, spec, probes, rebuild);
  // As for a base image not pinned by digest (§4.4): rebuilds must match what was recorded.
  const warning = block.sha256
    ? undefined
    : `The toolchain isn't pinned by digest, so Codemm recorded the one it downloaded. Rebuilds must match it. Pin it in the next version: wasi.sha256: ${sha256}`;
  return { spec, wasi: { sha256, module, dirs, env }, ...(warning ? { warning } : {}) };
}

/** Track gates 3-5: each style's pass probe passes, its fail probe fails, and its pass probe is fast and deterministic. */
async function runProbes(track: JudgeTrack, spec: TrackSpec, probes: Probes, rebuild: boolean): Promise<void> {
  for (const p of probes) {
    const exp = { expected: p.expected };
    const passRuns = await runSets(track, p.style, p.pass, { visible: p.inputs });
    const pass1 = gradeRuns(p.style, passRuns, exp);
    if (!allPass(pass1)) {
      const tests = `\n${summarize(pass1)}`;
      throw new GateError("probe pass", `the ${p.style} pass probe should pass every test:`, tests + printed(probeOutput(passRuns), tests));
    }
    const failRuns = await runSets(track, p.style, p.fail, { visible: p.inputs });
    const failed = gradeRuns(p.style, failRuns, exp);
    if (!failed.some((t) => t.status === "fail") || failed.some((t) => t.status === "error")) {
      const tests = `\n${summarize(failed)}`;
      throw new GateError("probe fail", `the ${p.style} fail probe should fail at least one test without errors:`, tests + printed(probeOutput(failRuns), tests));
    }
    const fast = probeFastMs(spec.limits, { rebuild });
    const pass2 = gradeRuns(p.style, await runSets(track, p.style, p.pass, { visible: p.inputs }, { timeMs: fast }), exp);
    if (!allPass(pass2)) {
      // time_ms is clamped to its ceiling, so asking for more there changes nothing: the probe itself must get faster.
      const fix = spec.limits.time_ms >= LIMITS.time_ms.max
        ? `limits.time_ms is already at its ceiling (${LIMITS.time_ms.max} ms), so make the ${p.style === "unit" ? "test command" : "run command"} faster: ` +
          "cache everything at image build time, and call the compiler and test runner directly instead of starting a build tool for every check:"
        : "Raise limits.time_ms or limits.memory_mb in track.yaml:";
      throw new GateError(
        "probe fast",
        `the ${p.style} pass probe must also pass within ${fast} ms, so every exercise's reference has room within its third of the time limit. ${fix}`,
        `\n${summarize(pass2)}`,
      );
    }
    if (JSON.stringify(pass1) !== JSON.stringify(pass2)) throw new GateError("deterministic", `the ${p.style} pass probe gave different results on a second run.`);
  }
}

// ---------- exercises ----------

/** `quiet` counts the other files instead of naming them: a mutant's folder is hidden material. */
function pickFiles(files: FileMap, folder: string, names: string[], label: string, quiet = false): FileMap {
  const src = subMap(files, folder);
  for (const n of names) if (!(n in src)) throw new GateError("valid", `${label} must contain ${n}.`);
  const extra = Object.keys(src).filter((p) => !names.includes(p));
  if (extra.length > 0) {
    const found = quiet ? `${extra.length} other file${extra.length === 1 ? "" : "s"}` : extra.join(", ");
    throw new GateError("valid", `${label} may only contain the track's learner files (${names.join(", ")}); found ${found}.`);
  }
  return src;
}

function validate(track: TrackRecord, course: CourseRecord, files: FileMap, taken: Set<string>) {
  validateFileMap(files);
  if (!files["exercise.yaml"]) throw new GateError("valid", "exercise.yaml is missing.");
  if (!files["README.md"]?.trim()) throw new GateError("valid", "README.md (the statement) is missing or empty.");
  let spec: ExerciseSpec;
  try {
    spec = parseExerciseYaml(files["exercise.yaml"]);
  } catch (e) {
    throw new GateError("valid", (e as Error).message);
  }
  if (taken.has(spec.slug)) throw new GateError("valid", `the slug "${spec.slug}" is already used in this course. Pick a new one.`);
  // Never reached from the app: saveExercise refuses first, and a rebuild re-checks each exercise in its own style.
  if (course.style === "none") throw new GateError("valid", "This course has lessons only. Turn activities on to practise.");
  const style = spec.style ?? course.style;
  if (!track.styles.includes(style)) throw new GateError("valid", `the track offers ${track.styles.join(", ")}, not style "${style}".`);
  const known = new Set(course.concepts.map((c) => c.id));
  for (const c of spec.concepts) if (!known.has(c)) throw new GateError("valid", `concept "${c}" isn't in the roadmap.`);

  const starter = pickFiles(files, "starter", track.files, "starter/");
  const solution = pickFiles(files, "solution", track.files, "solution/");
  const mutantNames = [...new Set(Object.keys(subMap(files, "mutants")).map((p) => p.split("/")[0]!))].sort();
  if (mutantNames.length < 2 || mutantNames.length > 4) throw new GateError("valid", `write 2 to 4 mutants under mutants/<name>/ (found ${mutantNames.length}).`);
  // A mutant's folder name can say what bug it holds, which hints at the hidden tests, so diagnostics number
  // mutants in name order instead (they reach the learner through tools, the CLI and the app).
  const mutants = mutantNames.map((name, i) => ({ label: `mutant #${i + 1}`, src: pickFiles(files, `mutants/${name}`, track.files, `mutant #${i + 1}`, true) }));

  const sets = { visible: subMap(files, "tests/visible"), hidden: subMap(files, "tests/hidden") };
  if (style === "io") {
    for (const [set, tests] of Object.entries(sets)) {
      const bad = Object.keys(tests).filter((p) => !/^[A-Za-z0-9_-]+\.(in|gen)$/.test(p));
      const listed = set === "hidden" ? `${bad.length} file(s)` : bad.join(", ");
      if (bad.length > 0) {
        throw new GateError("valid", `tests/${set}/ may only hold NN.in inputs and NN.gen input generators; Codemm writes expected outputs (.out) itself. Remove: ${listed}.`);
      }
      const both = Object.keys(tests).filter((p) => p.endsWith(".gen") && `${p.slice(0, -4)}.in` in tests);
      if (both.length > 0) throw new GateError("valid", `tests/${set}/ has both NN.in and NN.gen for ${set === "hidden" ? `${both.length} test(s)` : both.map((p) => p.slice(0, -4)).join(", ")}. Keep one of each pair.`);
      // A generator is a POSIX sh script, and the WASI engine has no sh (DESIGN §4.5).
      if (track.wasi && Object.keys(tests).some((p) => p.endsWith(".gen"))) {
        throw new GateError("valid", `this track runs on the WASI engine, which has no input generators (NN.gen needs sh). Write each input in tests/${set}/ as an NN.in file.`);
      }
    }
  }
  const counts = { visible: Object.keys(sets.visible).length, hidden: Object.keys(sets.hidden).length };
  if (counts.visible < 1 || counts.hidden < (style === "io" ? 2 : 1)) {
    throw new GateError("valid", `add at least 1 visible and ${style === "io" ? "2 hidden inputs" : "1 hidden test file"} (found ${counts.visible} and ${counts.hidden}).`);
  }
  return { spec, style, starter, solution, mutants, sets };
}

/** The exercise gate running, by name only: the reference passes, the starter fails, the tests catch each mutant. */
export type ExerciseGate = "reference" | "starter" | "mutants";

/** An exercise the course already has: its solution, to check that a new exercise is a new task. */
export type EarlierSolution = { slug: string; style: Style; concepts: string[]; createdAt: string; solution: FileMap };

/**
 * Which earlier exercises gate 7 runs, to bound the wait: at most 3 on a concept the new one shares, then the 3 most
 * recent others, newest first. Each costs one run of the visible tests.
 */
export function comparedEarlier(earlier: EarlierSolution[], style: Style, concepts: string[]): EarlierSolution[] {
  const pool = earlier.filter((e) => e.style === style).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const shared = pool.filter((e) => e.concepts.some((c) => concepts.includes(c))).slice(0, 3);
  return [...shared, ...pool.filter((e) => !shared.includes(e)).slice(0, 3)];
}

/** Runs exercise gates 1-7 (DESIGN §6). Returns the record to store, with io expected outputs or the unit inventory. */
export async function verifyExercise(
  trackRecord: TrackRecord, course: CourseRecord, files: FileMap, taken: Set<string>, onGate?: (gate: ExerciseGate) => void,
  earlier: EarlierSolution[] = [],
): Promise<ExerciseRecord> {
  const { spec, style, starter, solution, mutants, sets } = validate(trackRecord, course, files, taken);
  onGate?.("reference");
  const track = judgeTrack(trackRecord);
  const fast = fastMs(track.limits);

  // Gate 2 + 3: the reference passes, twice, the second time with a third of the time limit.
  const first = await runSets(track, style, solution, sets);
  // Generators get a third of their time too, so a later run under load still has room.
  const second = await runSets(track, style, solution, sets, { timeMs: fast, generatorMs: (GENERATOR_SECONDS * 1000) / 3 });
  const exp: { expected?: Record<string, Expected>; inventory?: { visible: string[]; hidden: string[] } } = {};
  if (style === "io") {
    const runs = [first, second].map((r) => [...(r.visible as IoRun).cases, ...(r.hidden as IoRun).cases]);
    const [a, b] = runs as [IoRun["cases"], IoRun["cases"]];
    // The reference's own output is never shown: building or running it is running hidden code, and a compiler
    // error or a traceback can quote it. Only the phase, exit codes and the visible test names are.
    const visibleBuild = (first.visible as IoRun).build;
    if (visibleBuild && visibleBuild.exit !== 0) {
      throw new GateError(
        "reference passes",
        `the reference doesn't build (exit ${visibleBuild.exit})${track.build ? ` with the track's build command (\`${track.build}\`)` : ""}. ` +
          `Check that solution/ holds exactly the track's learner files (${track.files.join(", ")}) and builds with the track's toolchain. ` +
          "Codemm doesn't show the build output, because it can quote the reference.",
      );
    }
    const hiddenBuild = (first.hidden as IoRun).build;
    if (hiddenBuild && hiddenBuild.exit !== 0) throw new GateError("reference passes", "the reference didn't build for the hidden tests.");
    const failed = (c: RawCase) => c.exit !== 0 || c.big || c.generator;
    const bad = a.filter(failed);
    if (bad.length > 0 || a.length !== counts(sets)) {
      // A visible case is named only when it matches an input the author gave; any other name came from the run.
      const inputs = new Set(Object.keys(sets.visible).filter((p) => /\.(in|gen)$/.test(p)).map((p) => `visible/${p.replace(/\.(in|gen)$/, "")}`));
      let hidden = 0;
      let other = 0;
      // A failed generator is the test's own fault, not the reference's, so it says so (by number, for hidden ones).
      const why = (c: RawCase) => (c.generator ? `its input generator failed (exit ${c.exit})` : `exit ${c.exit}${c.big ? `, printed over ${CASE_OUTPUT_MB} MB` : ""}`);
      const lines = a.map((c) =>
        c.name.startsWith("hidden/")
          ? `  hidden #${(hidden += 1)}: ${!failed(c) ? "ok" : c.generator ? "input generator failed" : "error"}`
          : `  ${inputs.has(c.name) ? c.name : `unexpected case #${(other += 1)}`}: ${why(c)}`,
      );
      throw new GateError("reference passes", `the reference must run every input without errors:\n${lines.join("\n")}`);
    }
    const slow = b.filter(failed);
    if (slow.length > 0) {
      const generators = slow.some((c) => c.generator) ? `, and every input generator within a third of its ${GENERATOR_SECONDS} s` : "";
      throw new GateError("reference fast", `the reference must still pass with a third of the time limit (${fast} ms)${generators}; ${slow.length} case(s) didn't.`);
    }
    if (JSON.stringify(a.map(caseDigest)) !== JSON.stringify(b.map(caseDigest))) {
      throw new GateError("reference passes", "the reference printed different output on two identical runs. Make it and any input generator deterministic (no randomness without a fixed seed, time or ordering of sets).");
    }
    exp.expected = Object.fromEntries(a.map((c) => [c.name, recordOutput(c)]));
  } else {
    const r1 = gradeRuns(style, first, {});
    if (!allPass(r1)) throw new GateError("reference passes", unitReferenceFailure(r1, first.visible as UnitRun));
    exp.inventory = {
      visible: r1.filter((t) => t.set === "visible").map((t) => t.name.slice("visible/".length)).sort(),
      hidden: r1.filter((t) => t.set === "hidden").map((t) => t.name.slice("hidden/".length)).sort(),
    };
    if (exp.inventory.visible.length < 1 || exp.inventory.hidden.length < 2) {
      throw new GateError("valid", `the tests must define at least 1 visible and 2 hidden test cases (found ${exp.inventory.visible.length} and ${exp.inventory.hidden.length}).`);
    }
    // Compare the full second report (no inventory filter), so added or changed tests can't slip through.
    const r2 = gradeRuns(style, second, {});
    if (!allPass(r2)) throw new GateError("reference fast", `the reference must still pass with a third of the time limit (${fast} ms):\n${statuses(r2)}`);
    const shape = (tests: TestResult[]) => JSON.stringify(tests.map((t) => [t.name, t.status]).sort());
    if (shape(r1) !== shape(r2)) throw new GateError("reference passes", "the test report differed between two identical runs. Make test names and results deterministic.");
  }

  // Gates 4 to 7 ask only whether everything passes, so an io set stops at its first error: a slow wrong solution
  // costs one time limit per set, not one per case. A generator failing there would make a mutant look caught, so it
  // fails the save instead.
  const quick = { stopAtError: true };
  const graded = (runs: Runs) => {
    if (generatorFailed(runs)) throw new GateError("reference fast", `an input generator failed on a later run. Make every generator finish well within ${GENERATOR_SECONDS / 3} s, the same way every time.`);
    return gradeRuns(style, runs, exp);
  };

  // Gate 4: the starter isn't already a solution.
  onGate?.("starter");
  const starterTests = graded(await runSets(track, style, starter, sets, quick));
  if (allPass(starterTests)) throw new GateError("starter unsolved", "the unedited starter passes every test. Leave the work to the learner.");

  // Gates 5 + 6: every mutant is caught by a hidden test, and some mutant gets past the visible ones.
  onGate?.("mutants");
  let anyPassesVisible = false;
  for (const m of mutants) {
    const tests = graded(await runSets(track, style, m.src, sets, quick));
    if (allPass(tests.filter((t) => t.set === "hidden"))) {
      throw new GateError("mutants caught", `${m.label} (in name order under mutants/) passes every hidden test. Strengthen the hidden tests or replace the mutant.`);
    }
    if (allPass(tests.filter((t) => t.set === "visible"))) anyPassesVisible = true;
  }
  if (!anyPassesVisible) {
    throw new GateError("hidden tests matter", "every mutant already fails a visible test, so the hidden tests add nothing. Include a mutant that passes the visible tests but fails a hidden one.");
  }

  // Gate 7: it's a new task. An earlier exercise's solution that passes every visible test here means the same task
  // again, whatever its title.
  for (const e of comparedEarlier(earlier, style, spec.concepts)) {
    if (allPass(graded(await runSets(track, style, e.solution, { visible: sets.visible }, quick)))) {
      throw new GateError("new task", `the solution to "${e.slug}" already passes every visible test of this exercise, so it's the same task again. Write a different problem, not a renamed one.`);
    }
  }

  return {
    format_version: 1,
    slug: spec.slug,
    style,
    concepts: spec.concepts,
    difficulty: spec.difficulty,
    ...(spec.hint ? { hint: spec.hint } : {}),
    track: `${track.id}@${track.version}`,
    createdAt: new Date().toISOString(),
    ...exp,
  };
}

const counts = (sets: Sets) => Object.keys(sets.visible).length + Object.keys(sets.hidden).length;
