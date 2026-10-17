#!/usr/bin/env node
/**
 * Proof runs against real agent CLIs. Needs `npm run build` first (it serves dist/cli.js).
 *
 *   node spikes/agent-bridge/spike.mjs status
 *   node spikes/agent-bridge/spike.mjs run <claude|codex> [--model M] [--root DIR --resume ID] [--cancel-on TYPE] "prompt"
 *
 * Each run gets a fresh temp workspace and CODEMM_HOME, printed as "root"; pass it back with --root to resume,
 * because both CLIs keep sessions per working directory. Events print as JSON lines.
 * --cancel-on cancels at the first event of that type, then reports leftover processes.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { agents } from "./agents.mjs";
import { run, signedIn } from "./bridge.mjs";

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const READ_ONLY_TOOLS = ["list_tracks", "next_step", "get_exercise", "progress"];

async function status() {
  for (const [name, agent] of Object.entries(agents)) console.log(`${name}: ${(await signedIn(agent.signIn)) ? "signed in" : "not signed in"}`);
}

async function runOnce(name, prompt, { model, resume, root = mkdtempSync(join(tmpdir(), "codemm-bridge-")), "cancel-on": cancelOn }) {
  const agent = agents[name];
  if (!agent?.launch) throw new Error(`run supports: ${Object.keys(agents).filter((a) => agents[a].launch).join(", ")}`);
  const ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  console.log(JSON.stringify({ root }));
  const server = { command: process.execPath, args: [cli, "mcp", "--workspace", ws], env: { CODEMM_HOME: join(root, "home") } };
  const controller = new AbortController();
  const started = Date.now();
  const out = await run(agent.launch({ prompt, server, tools: READ_ONLY_TOOLS, model, resume }), agent.parse, {
    cwd: ws,
    signal: controller.signal,
    onEvent: (event) => {
      console.log(JSON.stringify({ ms: Date.now() - started, ...event }));
      if (event.type === cancelOn) controller.abort();
    },
  });
  console.log(JSON.stringify({ ms: Date.now() - started, exit: out.code, cancelled: out.cancelled }));
  if (out.cancelled) {
    await new Promise((r) => setTimeout(r, 1000));
    const left = spawnSync("pgrep", ["-f", ws], { encoding: "utf8" }).stdout.trim();
    console.log(JSON.stringify({ leftoverProcesses: left ? left.split("\n").length : 0 }));
  }
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: { model: { type: "string" }, resume: { type: "string" }, root: { type: "string" }, "cancel-on": { type: "string" } } });
const [command, name, prompt] = positionals;
if (command === "status") await status();
else if (command === "run" && name && prompt) await runOnce(name, prompt, values);
else {
  console.error('usage: spike.mjs status | spike.mjs run <claude|codex> [--model M] [--root DIR --resume ID] [--cancel-on TYPE] "prompt"');
  process.exit(2);
}
