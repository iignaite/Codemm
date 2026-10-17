#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as app from "./app.js";
import { doctor } from "./doctor.js";
import { CodemmError } from "./errors.js";
import { readFileMap } from "./files.js";
import { claudeHook } from "./hook.js";
import { parseCli } from "./args.js";
import { type Host, HOSTS, init } from "./init.js";
import { serveMcp } from "./mcp.js";

const here = dirname(fileURLToPath(import.meta.url));
const VERSION = (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string }).version;

const USAGE = `codemm ${VERSION}: your coding agent writes the exercises, Codemm verifies, grades and tracks mastery.

Usage:
  codemm init [--host claude|codex|cursor]...   set up this project for your agent(s)
  codemm doctor [--fix]                          check Docker and sandbox isolation
  codemm status                                  your progress and the next step
  codemm test [exercise]                         run the visible tests (not recorded)
  codemm check [exercise]                        run every test and record the attempt
  codemm skip <concept>                          come back to a concept later
  codemm assist on|off                           let your agent edit exercise files (counts for less)
  codemm tracks                                  list installed tracks
  codemm track add <folder>                      install a track from a folder
  codemm track rebuild <id@version>              rebuild a track image and re-verify its exercises
  codemm mcp [--workspace <dir>]                 run the MCP server (your agent starts this)
  codemm hook claude [--workspace <dir>]         Claude Code practice hook (init sets this up)

Options: --workspace <dir>. Learner commands (status, test, check, skip, assist) default to the nearest folder
with codemm.json; every other command uses the current folder. Set CODEMM_HOME to move Codemm's data.`;

/** Learner commands find the nearest folder with codemm.json; everything else uses the current folder. */
const LEARNER_COMMANDS = new Set(["status", "test", "check", "skip", "assist"]);

function workspaceFor(command: string, explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (!LEARNER_COMMANDS.has(command)) return process.cwd();
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, "codemm.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

const print = (s: string) => process.stdout.write(`${s}\n`);

function printCheck(r: app.CheckView): void {
  for (const t of r.tests) {
    print(`  ${t.status === "pass" ? "✓" : t.status === "fail" ? "✗" : "!"} ${t.name}: ${t.status}`);
    if (t.message) print(`      ${t.message.split("\n").join("\n      ")}`);
    if (t.actual !== undefined) print(`      printed: ${JSON.stringify(t.actual.slice(0, 500))}`);
  }
  print(`${r.passed}/${r.total} passed (${r.recorded ? "recorded" : (r.note ?? "visible tests only, not recorded")})`);
}

function describeStep(step: app.NextStep): string {
  if ((step.kind === "practice" || step.kind === "author") && step.lesson !== undefined) {
    return step.lesson === null ? `Ask your agent for a lesson on ${step.concept}.` : `Read lesson "${step.lesson}" with your agent.`;
  }
  switch (step.kind) {
    case "setup": return `Ask your agent to set up ${step.track}.`;
    case "practice": return `Practice "${step.exercise}" (${step.concept}, difficulty ${step.difficulty}).`;
    case "author": return `Ask your agent for a new ${step.concept} exercise (difficulty ${step.difficulty}).`;
    case "stuck": return `You're stuck on ${step.concept}. Ask your agent to re-teach it.`;
    case "done": return "Every concept is mastered.";
  }
}

async function main(argv: string[]): Promise<number> {
  const { command, args: rest, options } = parseCli(argv);
  const ws = workspaceFor(command, options.workspace?.[0]);

  switch (command) {
    case "init": {
      const hosts = (options.host ?? []) as Host[];
      for (const h of hosts) if (!HOSTS.includes(h)) throw new CodemmError(`Unknown host "${h}". Use ${HOSTS.join(", ")}.`);
      const written = await init(ws, hosts, { command: process.execPath, args: [fileURLToPath(import.meta.url)] });
      print(`Set up ${ws}:\n${written.map((f) => `  ${f}`).join("\n")}`);
      print("Next: open this folder in your agent and ask it to teach you something. Codex needs this project marked as trusted to load .codex/config.toml.");
      return 0;
    }
    case "doctor": {
      const checks = await doctor(options.fix !== undefined);
      for (const c of checks) print(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
      return checks.every((c) => c.ok) ? 0 : 1;
    }
    case "status": {
      const p = app.progress(ws);
      print(`${p.course}: ${p.goal} (${p.track})`);
      for (const c of p.concepts) print(`  ${c.mastered ? "✓" : c.stuck ? "!" : "·"} ${c.title} [${c.id}] mastery ${c.mastery.toFixed(2)}, difficulty ${c.difficulty}`);
      print(describeStep(p.next));
      return 0;
    }
    case "test":
      printCheck(await app.testExercise(ws, rest[0]));
      return 0;
    case "check": {
      const r = await app.checkExercise(ws, rest[0]);
      printCheck(r);
      print(describeStep(app.nextStep(ws)));
      return 0;
    }
    case "skip":
      await app.skip(ws, rest[0]!);
      print(`Codemm will come back to ${rest[0]} later.`);
      return 0;
    case "assist":
      if (rest[0] !== "on" && rest[0] !== "off") throw new CodemmError("Use codemm assist on or codemm assist off.");
      await app.setAssist(ws, rest[0] === "on");
      print(rest[0] === "on" ? "Assist mode on: your agent may edit exercise files, and these exercises count for less." : "Assist mode off.");
      return 0;
    case "tracks": {
      const tracks = app.listTracks();
      if (tracks.length === 0) print("No tracks installed yet. Ask your agent to set one up, or run codemm track add <folder>.");
      for (const t of tracks) print(`${t.track}  styles: ${t.styles.join(", ")}  files: ${t.files.join(", ")}`);
      return 0;
    }
    case "track": {
      if (rest[0] === "add") {
        const r = await app.saveTrack(readFileMap(resolve(rest[1]!)));
        print(r.unchanged ? `${r.installed} is already installed.` : `Installed ${r.installed}.`);
        if (r.warning) print(`Warning: ${r.warning}`);
        return 0;
      }
      if (rest[0] === "rebuild") {
        const r = await app.rebuildTrack(rest[1]!);
        print(`Rebuilt ${r.rebuilt}; ${r.exercises} exercise(s) re-verified.`);
        return 0;
      }
      throw new CodemmError("Use codemm track add <folder> or codemm track rebuild <id@version>.");
    }
    case "mcp":
      await serveMcp(ws, VERSION);
      return -1; // keep running
    case "hook": {
      if (rest[0] !== "claude") throw new CodemmError("Only `codemm hook claude` is supported.");
      const stdin = readFileSync(0, "utf8");
      const r = claudeHook(ws, stdin);
      if (r.message) process.stderr.write(`${r.message}\n`);
      return r.exit;
    }
    case "version":
      print(VERSION);
      return 0;
    case "help":
      print(USAGE);
      return 0;
    default:
      throw new CodemmError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (e: unknown) => {
    if (e instanceof CodemmError) {
      process.stderr.write(`${e.message}\n`);
      process.exitCode = 1;
    } else {
      // Unexpected errors may carry internal data; show details only on request.
      const detail = process.env.CODEMM_DEBUG === "1" ? `\n${(e as Error).stack ?? String(e)}` : " Set CODEMM_DEBUG=1 for details.";
      process.stderr.write(`Codemm hit an unexpected error.${detail}\n`);
      process.exitCode = 2;
    }
  },
);
