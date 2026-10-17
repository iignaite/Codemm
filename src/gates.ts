import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodemmError } from "./errors.js";
import { type FileMap, subMap, validateFileMap, writeFileMap } from "./files.js";
import type { TestResult, TestSet } from "./grading.js";
import { gradeIoRun, gradeUnitRun, type IoRun, type JudgeTrack, runIo, runUnit, type UnitRun } from "./judge.js";
import { buildImage, inspectImage } from "./sandbox.js";
import {
  type CourseRecord, type ExerciseRecord, type ExerciseSpec, parseExerciseYaml, parseTrackYaml, type Style, type TrackRecord, type TrackSpec,
} from "./schemas.js";

/** A gate failed. The message names the gate and never contains hidden inputs or outputs. */
export class GateError extends CodemmError {
  constructor(gate: string, details: string) {
    super(`Gate "${gate}" failed: ${details}`);
  }
}

export const imageTag = (spec: { id: string; version: number }) => `codemm-track-${spec.id}:${spec.version}`;

type Sets = { visible: FileMap; hidden: FileMap };
type Runs = { visible: IoRun | UnitRun; hidden?: IoRun | UnitRun };

/** One line per test. Hidden tests show only an index and a status. */
function summarize(tests: TestResult[]): string {
  let hidden = 0;
  return tests
    .map((t) => {
      if (t.set === "hidden") return `  hidden #${(hidden += 1)}: ${t.status}`;
      const detail = [t.message, t.actual !== undefined && t.status !== "pass" ? `printed: ${JSON.stringify(t.actual.slice(0, 300))}` : ""].filter(Boolean).join("; ");
      return `  ${t.name}: ${t.status}${detail ? ` (${detail})` : ""}`;
    })
    .join("\n");
}

const allPass = (tests: TestResult[]) => tests.length > 0 && tests.every((t) => t.status === "pass");

async function runSets(track: JudgeTrack, style: Style, src: FileMap, sets: Partial<Sets>, timeMs?: number): Promise<Runs> {
  const opts = timeMs === undefined ? {} : { timeMs };
  const one = (set: TestSet, tests: FileMap) => (style === "io" ? runIo(track, set, src, tests, opts) : runUnit(track, src, tests, opts));
  const visible = await one("visible", sets.visible ?? {});
  return sets.hidden ? { visible, hidden: await one("hidden", sets.hidden) } : { visible };
}

type Expectation = { expected?: Record<string, string>; inventory?: { visible: string[]; hidden: string[] } };

function grade(style: Style, runs: Runs, exp: Expectation): TestResult[] {
  if (style === "io") {
    const expected = exp.expected ?? {};
    const pick = (set: TestSet) => Object.fromEntries(Object.entries(expected).filter(([k]) => k.startsWith(`${set}/`)));
    return [
      ...gradeIoRun(runs.visible as IoRun, pick("visible")),
      ...(runs.hidden ? gradeIoRun(runs.hidden as IoRun, pick("hidden")) : []),
    ];
  }
  return [
    ...gradeUnitRun("visible", runs.visible as UnitRun, exp.inventory?.visible),
    ...(runs.hidden ? gradeUnitRun("hidden", runs.hidden as UnitRun, exp.inventory?.hidden) : []),
  ];
}

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

/** Builds a track image and runs its probes (DESIGN §6, track gates 2-5). */
export async function verifyTrack(files: FileMap): Promise<{ spec: TrackSpec; image: string; imageId: string }> {
  validateFileMap(files);
  if (!files["track.yaml"] || !files.Dockerfile) throw new GateError("valid", "A track needs track.yaml and a Dockerfile.");
  const spec = parseTrackYaml(files["track.yaml"]);
  const probes = spec.styles.map((style) => ({ style, ...probe(files, spec, style) }));

  const image = imageTag(spec);
  const context = mkdtempSync(join(tmpdir(), "codemm-build-"));
  try {
    writeFileMap(context, files);
    const built = await buildImage(context, image);
    if (!built.ok) throw new GateError("build", `the image didn't build:\n${built.log}`);
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
  const info = await inspectImage(image);
  if (!info) throw new GateError("build", "the built image can't be found.");
  if (info.hasVolumes) throw new GateError("build", "the image declares a VOLUME. Remove it; checks may only write to /tmp.");

  const track: JudgeTrack = { ...spec, image };
  for (const p of probes) {
    const exp = { expected: p.expected };
    const pass1 = grade(p.style, await runSets(track, p.style, p.pass, { visible: p.inputs }), exp);
    if (!allPass(pass1)) throw new GateError("probe pass", `the ${p.style} pass probe should pass every test:\n${summarize(pass1)}`);
    const failed = grade(p.style, await runSets(track, p.style, p.fail, { visible: p.inputs }), exp);
    if (!failed.some((t) => t.status === "fail") || failed.some((t) => t.status === "error")) {
      throw new GateError("probe fail", `the ${p.style} fail probe should fail at least one test without errors:\n${summarize(failed)}`);
    }
    const pass2 = grade(p.style, await runSets(track, p.style, p.pass, { visible: p.inputs }), exp);
    if (JSON.stringify(pass1) !== JSON.stringify(pass2)) throw new GateError("deterministic", `the ${p.style} pass probe gave different results on a second run.`);
  }
  return { spec, image, imageId: info.id };
}

// ---------- exercises ----------

function pickFiles(files: FileMap, folder: string, names: string[], label: string): FileMap {
  const src = subMap(files, folder);
  for (const n of names) if (!(n in src)) throw new GateError("valid", `${label} must contain ${n}.`);
  const extra = Object.keys(src).filter((p) => !names.includes(p));
  if (extra.length > 0) throw new GateError("valid", `${label} may only contain the track's learner files (${names.join(", ")}); found ${extra.join(", ")}.`);
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
  const style = spec.style ?? course.style;
  if (!track.styles.includes(style)) throw new GateError("valid", `the track offers ${track.styles.join(", ")}, not style "${style}".`);
  const known = new Set(course.concepts.map((c) => c.id));
  for (const c of spec.concepts) if (!known.has(c)) throw new GateError("valid", `concept "${c}" isn't in the roadmap.`);

  const starter = pickFiles(files, "starter", track.files, "starter/");
  const solution = pickFiles(files, "solution", track.files, "solution/");
  const mutantNames = [...new Set(Object.keys(subMap(files, "mutants")).map((p) => p.split("/")[0]!))].sort();
  if (mutantNames.length < 2 || mutantNames.length > 4) throw new GateError("valid", `write 2 to 4 mutants under mutants/<name>/ (found ${mutantNames.length}).`);
  const mutants = mutantNames.map((name) => ({ name, src: pickFiles(files, `mutants/${name}`, track.files, `mutants/${name}/`) }));

  const sets = { visible: subMap(files, "tests/visible"), hidden: subMap(files, "tests/hidden") };
  if (style === "io") {
    for (const [set, tests] of Object.entries(sets)) {
      const bad = Object.keys(tests).filter((p) => !/^[A-Za-z0-9_-]+\.in$/.test(p));
      if (bad.length > 0) throw new GateError("valid", `tests/${set}/ may only hold NN.in inputs; Codemm writes expected outputs (.out) itself. Remove: ${bad.join(", ")}.`);
    }
  }
  const counts = { visible: Object.keys(sets.visible).length, hidden: Object.keys(sets.hidden).length };
  if (counts.visible < 1 || counts.hidden < (style === "io" ? 2 : 1)) {
    throw new GateError("valid", `add at least 1 visible and ${style === "io" ? "2 hidden inputs" : "1 hidden test file"} (found ${counts.visible} and ${counts.hidden}).`);
  }
  return { spec, style, starter, solution, mutants, sets };
}

/** Runs exercise gates 1-6 (DESIGN §6). Returns the record to store, with io expected outputs or the unit inventory. */
export async function verifyExercise(track: TrackRecord, course: CourseRecord, files: FileMap, taken: Set<string>): Promise<ExerciseRecord> {
  const { spec, style, starter, solution, mutants, sets } = validate(track, course, files, taken);
  const fast = Math.max(100, Math.floor(track.limits.time_ms / 3));

  // Gate 2 + 3: the reference passes, twice, the second time with a third of the time limit.
  const first = await runSets(track, style, solution, sets);
  const second = await runSets(track, style, solution, sets, fast);
  const exp: Expectation = {};
  if (style === "io") {
    const runs = [first, second].map((r) => [...(r.visible as IoRun).cases, ...(r.hidden as IoRun).cases]);
    const [a, b] = runs as [IoRun["cases"], IoRun["cases"]];
    const build = (first.visible as IoRun).build ?? (first.hidden as IoRun).build;
    if (build && build.exit !== 0) throw new GateError("reference passes", `the reference doesn't build:\n${build.output.slice(0, 2000)}`);
    const bad = a.filter((c) => c.exit !== 0 || c.big);
    if (bad.length > 0 || a.length !== counts(sets)) {
      const lines = a.map((c) => (c.name.startsWith("hidden/") ? `  ${c.name.replace(/\d+$/, "#")}: ${c.exit === 0 && !c.big ? "ok" : "error"}` : `  ${c.name}: exit ${c.exit}${c.big ? ", printed over 64 KB" : ""}${c.stderr ? ` (${c.stderr.slice(0, 300)})` : ""}`));
      throw new GateError("reference passes", `the reference must run every input without errors:\n${lines.join("\n")}`);
    }
    const slow = b.filter((c) => c.exit !== 0 || c.big);
    if (slow.length > 0) throw new GateError("reference fast", `the reference must still pass with a third of the time limit (${fast} ms); ${slow.length} case(s) didn't.`);
    if (JSON.stringify(a.map((c) => c.stdout)) !== JSON.stringify(b.map((c) => c.stdout))) {
      throw new GateError("reference passes", "the reference printed different output on two identical runs. Make it deterministic (no randomness, time or ordering of sets).");
    }
    exp.expected = Object.fromEntries(a.map((c) => [c.name, c.stdout]));
  } else {
    const r1 = grade(style, first, {});
    if (!allPass(r1)) throw new GateError("reference passes", `the reference must pass every test:\n${summarize(r1)}`);
    exp.inventory = {
      visible: r1.filter((t) => t.set === "visible").map((t) => t.name.slice("visible/".length)).sort(),
      hidden: r1.filter((t) => t.set === "hidden").map((t) => t.name.slice("hidden/".length)).sort(),
    };
    if (exp.inventory.visible.length < 1 || exp.inventory.hidden.length < 2) {
      throw new GateError("valid", `the tests must define at least 1 visible and 2 hidden test cases (found ${exp.inventory.visible.length} and ${exp.inventory.hidden.length}).`);
    }
    const r2 = grade(style, second, exp);
    if (!allPass(r2)) throw new GateError("reference fast", `the reference must still pass with a third of the time limit (${fast} ms):\n${summarize(r2)}`);
  }

  // Gate 4: the starter isn't already a solution.
  const starterTests = grade(style, await runSets(track, style, starter, sets), exp);
  if (allPass(starterTests)) throw new GateError("starter unsolved", "the unedited starter passes every test. Leave the work to the learner.");

  // Gates 5 + 6: every mutant is caught by a hidden test, and some mutant gets past the visible ones.
  let anyPassesVisible = false;
  for (const m of mutants) {
    const tests = grade(style, await runSets(track, style, m.src, sets), exp);
    if (allPass(tests.filter((t) => t.set === "hidden"))) {
      throw new GateError("mutants caught", `mutant "${m.name}" passes every hidden test. Strengthen the hidden tests or replace the mutant.`);
    }
    if (allPass(tests.filter((t) => t.set === "visible"))) anyPassesVisible = true;
  }
  if (!anyPassesVisible) {
    throw new GateError("hidden tests matter", "every mutant already fails a visible test, so the hidden tests add nothing. Include a mutant that passes the visible tests but fails a hidden one.");
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
