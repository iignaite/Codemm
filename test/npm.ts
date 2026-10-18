import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Runs npm without a shell on every OS. On Windows npm is a .cmd shim, which Node won't spawn directly, so when
 * npm started the tests, its own script runs with this Node instead. Asynchronous on purpose: a pack or build can
 * take a minute on a slow runner, and a blocked test worker misses vitest's own messages, which time out at 60 s.
 */
export async function npm(args: string[], cwd?: string): Promise<string> {
  const script = process.env.npm_execpath;
  const [command, prefix] = script ? [process.execPath, [script]] : ["npm", []];
  return (await run(command, [...prefix, ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout;
}
