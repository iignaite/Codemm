/**
 * Spike entry point: runs one agent turn with Codemm's MCP server and prints the parsed events as JSON lines.
 *
 *   node spikes/agent-bridge/bridge.ts status <claude|codex|cursor>
 *   node spikes/agent-bridge/bridge.ts turn <claude|codex> [--tools a,b] [--model m] [--resume id]
 *        [--workspace dir] [--cancel-after ms] <prompt>
 *
 * Needs `npm run build` first: the MCP server is this checkout's dist/cli.js.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createParser } from "./events.ts";
import { type Agent, BINARY, cleanEnv, signedIn, STATUS_ARGS, turnArgs } from "./launch.ts";

const started = Date.now();
// Each line carries the milliseconds since start, to show that events stream rather than arrive at the end.
const print = (value: object) => process.stdout.write(`${JSON.stringify({ ...value, ms: Date.now() - started })}\n`);
const env = { ...cleanEnv(process.env), NO_OPEN_BROWSER: "1" };

function status(agent: Agent): void {
  const r = spawnSync(BINARY[agent], STATUS_ARGS[agent], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  const installed = (r.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT";
  // Only the yes/no leaves this function; account details in the output are discarded. A timeout counts as signed out.
  print({ agent, installed, signedIn: installed && !r.error && signedIn(agent, { exit: r.status ?? 1, output: `${r.stdout}${r.stderr}` }) });
}

function turn(agent: "claude" | "codex", prompt: string, o: { tools?: string; model?: string; resume?: string; workspace?: string; "cancel-after"?: string }): void {
  const ws = o.workspace ?? mkdtempSync(join(tmpdir(), "codemm-spike-"));
  const home = join(ws, ".home");
  mkdirSync(home, { recursive: true });
  const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
  const mcp = { command: process.execPath, args: [cli, "mcp", "--workspace", ws], env: { CODEMM_HOME: home } };
  const args = turnArgs(agent, { mcp, tools: (o.tools ?? "list_tracks").split(",").filter(Boolean), ...(o.model ? { model: o.model } : {}), ...(o.resume ? { resume: o.resume } : {}) });

  // Its own process group on POSIX, so cancelling also stops the MCP server the agent started.
  const child = spawn(BINARY[agent], args, { cwd: ws, env, stdio: ["pipe", "pipe", "inherit"], detached: process.platform !== "win32" });
  child.stdin.end(prompt);
  const parse = createParser(agent);
  createInterface({ input: child.stdout }).on("line", (line) => parse(line).forEach(print));

  const killGroup = (signal: NodeJS.Signals) => {
    try {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      else process.kill(-child.pid!, signal);
    } catch {
      // Already gone.
    }
  };
  // Processes still holding this workspace path: the MCP server the agent started, and any of its children.
  const holding = () => spawnSync("pgrep", ["-f", ws], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).length;
  const cancelAfter = Number(o["cancel-after"] ?? 0);
  if (cancelAfter > 0) {
    setTimeout(() => {
      print({ kind: "cancel", holding: holding() });
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 5000).unref();
    }, cancelAfter).unref();
  }

  child.on("exit", (code, signal) => {
    // Give children a moment to exit before counting what is left.
    setTimeout(() => print({ kind: "exit", code, signal, workspace: ws, leftover: holding() }), 1000);
  });
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { tools: { type: "string" }, model: { type: "string" }, resume: { type: "string" }, workspace: { type: "string" }, "cancel-after": { type: "string" } },
});
const [command, agent, ...rest] = positionals;
if (command === "status" && (agent === "claude" || agent === "codex" || agent === "cursor")) status(agent);
else if (command === "turn" && (agent === "claude" || agent === "codex") && rest.length > 0) turn(agent, rest.join(" "), values);
else {
  process.stderr.write("usage: bridge.ts status <claude|codex|cursor> | turn <claude|codex> [options] <prompt>\n");
  process.exitCode = 2;
}
