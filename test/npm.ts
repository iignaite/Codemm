import { execFileSync } from "node:child_process";

/**
 * Runs npm without a shell on every OS. On Windows npm is a .cmd shim, which Node won't spawn
 * directly, so when npm started the tests, its own script runs with this Node instead.
 */
export function npm(args: string[], cwd?: string): string {
  const script = process.env.npm_execpath;
  const [command, prefix] = script ? [process.execPath, [script]] : ["npm", []];
  return execFileSync(command, [...prefix, ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
