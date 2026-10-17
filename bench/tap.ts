#!/usr/bin/env node
/**
 * A transparent MCP stdio tap: `node bench/tap.ts --log <file> --home <dir> --cli <container cli> -- <command> [args...]`.
 * Starts the real Codemm server with CODEMM_HOME=<dir>, passes every byte through unchanged,
 * and appends each tools/call request and its response to <file> as JSON lines.
 * It gives the bench one tool-call log for every host, subagents included.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { tapRecords } from "./lib/tap-log.ts";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const opt = (name: string) => {
  const i = argv.indexOf(name);
  if (i < 0 || i > sep) throw new Error(`tap: missing ${name}`);
  return argv[i + 1]!;
};
if (sep < 0 || sep === argv.length - 1) throw new Error("usage: tap.ts --log <file> --home <dir> --cli <container cli> -- <command> [args...]");
const log = opt("--log");
const [command, ...args] = argv.slice(sep + 1);

// Codex hands MCP servers a reduced environment, so the tap sets Codemm's home and container CLI itself.
const child = spawn(command!, args, { env: { ...process.env, CODEMM_HOME: opt("--home"), CODEMM_CONTAINER_CLI: opt("--cli") }, stdio: ["pipe", "pipe", "inherit"] });

function watch(from: NodeJS.ReadableStream, to: NodeJS.WritableStream, dir: "in" | "out") {
  let buffer = "";
  from.on("data", (chunk: Buffer) => {
    to.write(chunk);
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      for (const record of tapRecords(line, dir)) appendFileSync(log, `${JSON.stringify({ pid: process.pid, at: Date.now(), ...record })}\n`);
    }
  });
}

watch(process.stdin, child.stdin!, "in");
watch(child.stdout!, process.stdout, "out");
process.stdin.on("end", () => child.stdin!.end());
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => child.kill(s));
