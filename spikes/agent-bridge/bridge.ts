/**
 * Spike entry point: runs one agent turn with Codemm's MCP server and prints the parsed events as JSON lines.
 *
 *   node spikes/agent-bridge/bridge.ts status <claude|codex|cursor>
 *   node spikes/agent-bridge/bridge.ts turn <claude|codex> [--tools a,b] [--web] [--author] [--model m]
 *        [--resume id] [--workspace dir] [--cancel-after ms] <prompt>
 *
 * `--author` hides the agent's text, as for author turns. Needs `npm run build` first: the MCP server is this
 * checkout's dist/cli.js.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createParser } from "./events.ts";
import { type Agent, BINARY, cleanEnv, signedIn, STATUS_ARGS, turnArgs } from "./launch.ts";
import { startTurn } from "./run.ts";

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

type TurnFlags = { tools?: string; web?: boolean; author?: boolean; model?: string; resume?: string; workspace?: string; "cancel-after"?: string };

async function turn(agent: "claude" | "codex", prompt: string, o: TurnFlags): Promise<void> {
  const ws = o.workspace ?? mkdtempSync(join(tmpdir(), "codemm-spike-"));
  const home = join(ws, ".home");
  mkdirSync(home, { recursive: true });
  const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
  const mcp = { command: process.execPath, args: [cli, "mcp", "--workspace", ws], env: { CODEMM_HOME: home } };
  const tools = (o.tools ?? "list_tracks").split(",").filter(Boolean);
  const args = turnArgs(agent, { mcp, tools, web: o.web === true, ...(o.model ? { model: o.model } : {}), ...(o.resume ? { resume: o.resume } : {}) });

  const parse = createParser(agent, { text: o.author !== true, web: o.web === true });
  const run = startTurn({ command: BINARY[agent], args, cwd: ws, env, input: prompt, onLine: (line) => parse(line).forEach(print) });
  const cancelAfter = Number(o["cancel-after"] ?? 0);
  if (cancelAfter > 0) setTimeout(() => (print({ kind: "cancel" }), run.cancel()), cancelAfter).unref();
  print({ kind: "exit", ...(await run.done) });
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    tools: { type: "string" }, web: { type: "boolean" }, author: { type: "boolean" }, model: { type: "string" },
    resume: { type: "string" }, workspace: { type: "string" }, "cancel-after": { type: "string" },
  },
});
const [command, agent, ...rest] = positionals;
if (command === "status" && (agent === "claude" || agent === "codex" || agent === "cursor")) status(agent);
else if (command === "turn" && (agent === "claude" || agent === "codex") && rest.length > 0) await turn(agent, rest.join(" "), values);
else {
  process.stderr.write("usage: bridge.ts status <claude|codex|cursor> | turn <claude|codex> [options] <prompt>\n");
  process.exitCode = 2;
}
