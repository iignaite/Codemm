#!/usr/bin/env node
/**
 * Runs one bench cell: `node bench/run.ts --host claude|codex --model <m> --subject c|python [--journey both|tutor] [--rep N] [--out results/<set>] [--keep]`.
 * Fresh temp workspace and CODEMM_HOME, `codemm init`, then the author and tutor journeys, or with `--journey tutor`
 * only the tutor journey on the subject's fixture exercise (bench/fixtures/<subject>/). Writes
 * bench/<out>/<host>-<model>-<subject>-r<N>.json and keeps raw logs in bench/runs/ (git-ignored).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseToml } from "smol-toml";
import type { AgentRun, HostAdapter, HostRun } from "./lib/agent.ts";
import { emptyRun } from "./lib/agent.ts";
import { accessFindings, codeBlocks, isLeak, leaks, learnerView, workspaceDiff } from "./lib/checks.ts";
import { claude } from "./lib/claude.ts";
import { codex } from "./lib/codex.ts";
import { cleanupImages, recordingCli, snapshot } from "./lib/docker.ts";
import { type Evidence, type FileMap, readEvidence, type StoredExercise } from "./lib/evidence.ts";
import { authorPrompt, SUBJECTS, TUTOR_PROMPT } from "./lib/journeys.ts";
import { type JourneyResult, journeyResult, saveStats, type Violations } from "./lib/metrics.ts";
import { capture, cleanEnv, run } from "./lib/proc.ts";
import { seedExercise, shellFixture, subjectFixture } from "./lib/seed.ts";
import { removeClaudeSessions, removeCodexSessions } from "./lib/sessions.ts";
import { solveCheck } from "./lib/solve.ts";
import { parseTapLog, type TapCall } from "./lib/tap-log.ts";

const HOSTS: Record<string, HostAdapter> = { claude, codex };
const BENCH = import.meta.dirname;
const CLI = join(BENCH, "..", "dist", "cli.js");
const TAP = join(BENCH, "tap.ts");
const AUTHOR_TIMEOUT = 40 * 60_000;
const TUTOR_TIMEOUT = 10 * 60_000;

const { values: opts } = parseArgs({ options: { host: { type: "string" }, model: { type: "string" }, subject: { type: "string" }, rep: { type: "string", default: "1" }, out: { type: "string", default: "results" }, journey: { type: "string", default: "both" }, keep: { type: "boolean", default: false } } });
const adapter = HOSTS[opts.host ?? ""];
const subject = SUBJECTS[opts.subject ?? ""];
if (!adapter || !subject || !opts.model || !["both", "tutor"].includes(opts.journey!)) {
  throw new Error("usage: run.ts --host claude|codex --model <m> --subject c|python [--journey both|tutor] [--rep N] [--out results/<set>] [--keep]");
}
if (!existsSync(CLI)) throw new Error("Build Codemm first: npm run build");

const cell = `${opts.host}-${opts.model}-${opts.subject}-r${opts.rep}`;
const logs = join(BENCH, "runs", opts.out!.replace(/\//g, "-"), cell);
rmSync(logs, { recursive: true, force: true });
mkdirSync(logs, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "codemm-bench-"));
const ws = join(root, "ws");
const home = join(root, "home");
// Codemm builds through a wrapper that records each image ID, so cleanup removes only what this run built.
const containerCli = recordingCli(root);
const codemmEnv = () => cleanEnv({ CODEMM_HOME: home, CODEMM_CONTAINER_CLI: containerCli });
mkdirSync(ws);
mkdirSync(home);
const say = (s: string) => process.stderr.write(`[${cell}] ${s}\n`);

/** The Codemm launcher `codemm init` wrote for this host. */
function initLauncher(): { command: string; args: string[] } {
  if (opts.host === "codex") return (parseToml(readFileSync(join(ws, ".codex/config.toml"), "utf8")) as any).mcp_servers.codemm;
  return JSON.parse(readFileSync(join(ws, ".mcp.json"), "utf8")).mcpServers.codemm;
}

async function journey(name: string, prompt: string, timeoutMs: number): Promise<{ run: AgentRun; calls: TapCall[]; wallMs: number; timedOut: boolean }> {
  const launcher = initLauncher();
  const tapLog = join(logs, `tap-${name}.jsonl`);
  const mcp: HostRun = { command: process.execPath, args: [TAP, "--log", tapLog, "--home", home, "--cli", containerCli, "--", launcher.command, ...launcher.args] };
  const host = adapter!.command({ model: opts.model!, prompt, ws, mcp, scratch: logs });
  for (const [path, content] of Object.entries(host.files ?? {})) writeFileSync(path, content);
  const stdoutPath = join(logs, `${name}.jsonl`);
  say(`${name}: starting`);
  const r = await run(host.command, host.args, { cwd: ws, env: codemmEnv(), timeoutMs, stdoutPath, stderrPath: join(logs, `${name}.stderr`) });
  const out = readFileSync(stdoutPath, "utf8");
  const parsed = out.trim() ? adapter!.parse(out) : emptyRun(`no output (exit ${r.code})`);
  const calls = existsSync(tapLog) ? parseTapLog(readFileSync(tapLog, "utf8")) : [];
  say(`${name}: done in ${Math.round(r.wallMs / 1000)} s${r.timedOut ? " (timed out)" : ""}, ${calls.length} Codemm calls`);
  return { run: parsed, calls, wallMs: r.wallMs, timedOut: r.timedOut };
}

const trackFilesOf = (ev: Evidence, ex: StoredExercise) => ev.tracks.find((t) => t.ref === ex.track)?.files ?? [];
const allLearnerViews = (ev: Evidence): FileMap => Object.assign({}, ...ev.exercises.map((ex) => learnerView(ex, trackFilesOf(ev, ex))));

function violations(run: AgentRun, exercises: StoredExercise[], changes: { changed: string[]; added: string[] }): Violations {
  const found = exercises.map((ex) => leaks(run.exposedText, ex));
  return {
    leakedLines: Math.max(0, ...found.map((l) => l.lines.length)),
    leakedNames: Math.max(0, ...found.map((l) => l.names.length)),
    exerciseChanges: [...changes.changed, ...changes.added],
    ...accessFindings(run.tools, home),
  };
}

const baseline = snapshot();
const result: Record<string, unknown> = {
  cell,
  host: opts.host,
  model: opts.model,
  subject: opts.subject,
  rep: Number(opts.rep),
  date: new Date().toISOString(),
  hostVersion: capture(opts.host!, ["--version"]).out.trim(),
};
let ev: Evidence = { tracks: [], exercises: [], workspace: {} };
try {
  const init = capture(process.execPath, [CLI, "init"], { cwd: ws, env: codemmEnv() });
  if (init.code !== 0) throw new Error(`codemm init failed: ${init.out}`);

  let materialized: StoredExercise[] = [];
  if (opts.journey === "both") {
    // Author journey.
    const a = await journey("author", authorPrompt(subject), AUTHOR_TIMEOUT);
    ev = readEvidence(home, ws);
    const authored = ev.exercises.filter((ex) => ex.course === ev.course);
    materialized = authored.filter((ex) => Object.keys(learnerView(ex, trackFilesOf(ev, ex))).every((p) => p in ev.workspace));
    const authorChanges = workspaceDiff(allLearnerViews(ev), ev.workspace);
    result.models = a.run.models;
    result.author = {
      ...journeyResult(a.run, a.calls, { success: materialized.length > 0, wallMs: a.wallMs, timedOut: a.timedOut, violations: violations(a.run, ev.exercises, authorChanges) }),
      track: saveStats(a.calls, "save_track"),
      roadmap: saveStats(a.calls, "save_roadmap"),
      exercise: saveStats(a.calls, "save_exercise"),
      tracksInstalled: ev.tracks.map((t) => t.ref),
      exercisesSaved: authored.map((ex) => ex.slug),
      reply: a.run.finalText.slice(0, 1500),
    } satisfies JourneyResult & Record<string, unknown>;
  }

  // Tutor journey, on the authored exercise or else a seeded fixture: the subject's own for --journey tutor,
  // the shell fixture when the author journey saved nothing.
  let source = "authored";
  const config = join(ws, "codemm.json");
  const current = existsSync(config) ? (JSON.parse(readFileSync(config, "utf8")).current as string | undefined) : undefined;
  let ex = materialized.find((e) => e.slug === current) ?? materialized[0];
  if (!ex) {
    const fixture = opts.journey === "tutor" ? subjectFixture(opts.subject!) : shellFixture();
    source = opts.journey === "tutor" ? "fixture" : "seeded";
    say(`tutor: seeding ${fixture.course}/${fixture.slug}`);
    await seedExercise(CLI, ws, home, containerCli, fixture);
    ev = readEvidence(home, ws);
    ex = ev.exercises.find((e) => e.course === fixture.course && e.slug === fixture.slug)!;
  }
  const before = readEvidence(home, ws).workspace;
  const t = await journey("tutor", TUTOR_PROMPT, TUTOR_TIMEOUT);
  result.models ??= t.run.models;
  ev = readEvidence(home, ws);
  const tutorChanges = workspaceDiff(before, ev.workspace);
  const v = violations(t.run, [ex], tutorChanges);
  const learnerFiles = trackFilesOf(ev, ex);
  const solve = solveCheck({ cli: CLI, home, ws, rel: `exercises/${ex.course}/${ex.slug}`, learnerFiles, slug: ex.slug, blocks: codeBlocks(t.run.exposedText), scratch: root });
  const refused = t.run.ok && !t.run.serverFailed && solve.evaluated && !solve.solved && !isLeak(leaks(t.run.exposedText, ex)) && v.exerciseChanges.length === 0;
  result.tutor = {
    ...journeyResult(t.run, t.calls, { success: refused, wallMs: t.wallMs, timedOut: t.timedOut, violations: v }),
    // A reply with code the bench couldn't grade says nothing either way.
    ...(solve.evaluated || solve.solved ? {} : { infraFailure: true, error: "the solve check couldn't grade the reply's code" }),
    exercise: { source, slug: ex.slug, style: ex.style },
    refused,
    solve,
    reply: t.run.exposedText.slice(0, 4000),
    statement: (ex.files["README.md"] ?? "").slice(0, 3000),
  } satisfies JourneyResult & Record<string, unknown>;
} catch (e) {
  result.error = (e as Error).message.slice(0, 1000);
  say(`error: ${result.error}`);
} finally {
  ev = readEvidence(home, ws);
  try {
    result.cleanup = cleanupImages(root, baseline);
  } catch (e) {
    // Without a full picture of Docker's images nothing is removed; say so and clean up the rest.
    result.cleanup = [`skipped: ${(e as Error).message}`];
  }
  if (opts.host === "claude") removeClaudeSessions(ws);
  else removeCodexSessions(root);
  if (opts.keep) say(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

const out = join(BENCH, opts.out!, `${cell}.json`);
mkdirSync(dirname(out), { recursive: true });
// Results are committed: replace this machine's paths with placeholders.
const places: [string, string][] = [[root, "$RUN"], [realpathSync(tmpdir()), "$TMPDIR"], [tmpdir(), "$TMPDIR"], [homedir(), "~"]];
const scrub = (text: string) => places.reduce((t, [path, name]) => t.split(path).join(name), text);
writeFileSync(out, `${scrub(JSON.stringify(result, null, 2))}\n`);
say(`wrote ${out}`);
// Keep a copy of the result next to the raw logs, so a rerun's logs and result stay together.
cpSync(out, join(logs, "result.json"));
