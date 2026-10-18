import { CodemmError } from "./errors.js";

type Kind = "value" | "multi" | "flag";
type Spec = { args: [min: number, max: number]; options: Record<string, Kind>; usage: string };

const ws: Record<string, Kind> = { workspace: "value" };
export const COMMANDS: Record<string, Spec> = {
  init: { args: [0, 0], options: { ...ws, host: "multi" }, usage: "init [--host claude|codex|cursor]..." },
  doctor: { args: [0, 0], options: { fix: "flag" }, usage: "doctor [--fix]" },
  status: { args: [0, 0], options: ws, usage: "status" },
  test: { args: [0, 1], options: ws, usage: "test [exercise]" },
  check: { args: [0, 1], options: ws, usage: "check [exercise]" },
  skip: { args: [1, 1], options: ws, usage: "skip <concept>" },
  assist: { args: [1, 1], options: ws, usage: "assist on|off" },
  tracks: { args: [0, 0], options: {}, usage: "tracks" },
  track: { args: [2, 2], options: {}, usage: "track add <folder> | track rebuild <id@version>" },
  mcp: {
    args: [0, 0], options: { ...ws, course: "value", tools: "value", desktop: "flag", progress: "value" },
    usage: "mcp [--workspace <dir>] [--course <course>] [--tools <a,b>] [--desktop] [--progress <file>]",
  },
  hook: { args: [1, 1], options: ws, usage: "hook claude [--workspace <dir>]" },
  help: { args: [0, 0], options: {}, usage: "help" },
  version: { args: [0, 0], options: {}, usage: "--version" },
};

export type Parsed = { command: string; args: string[]; options: Record<string, string[]> };

/** Strict per-command parsing: unknown options, missing values and wrong argument counts are errors. */
export function parseCli(argv: string[]): Parsed {
  if (argv.length === 0) return { command: "help", args: [], options: {} };
  // Aliases become ordinary commands, so the rest of the line is still validated.
  const aliases: Record<string, string> = { "--version": "version", "-v": "version", "--help": "help", "-h": "help" };
  const [first, ...rest] = argv as [string, ...string[]];
  const command = aliases[first] ?? first;
  const spec = COMMANDS[command];
  if (!spec) throw new CodemmError(`Unknown command "${command}". Run codemm help.`);

  const args: string[] = [];
  const options: Record<string, string[]> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith("--")) {
      args.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = token.slice(2, eq < 0 ? undefined : eq);
    const kind = spec.options[name];
    if (!kind) throw new CodemmError(`Unknown option --${name} for codemm ${command}. Usage: codemm ${spec.usage}`);
    let value: string | undefined;
    if (kind === "flag") {
      if (eq >= 0) throw new CodemmError(`--${name} doesn't take a value.`);
      value = "true";
    } else {
      value = eq >= 0 ? token.slice(eq + 1) : rest[++i];
      if (value === undefined || value === "" || (eq < 0 && value.startsWith("--"))) throw new CodemmError(`--${name} needs a value.`);
    }
    if (kind !== "multi" && options[name]) throw new CodemmError(`--${name} was given twice.`);
    options[name] = [...(options[name] ?? []), value];
  }
  const [min, max] = spec.args;
  if (args.length < min || args.length > max) {
    const expected = max === 0 ? `${command} takes no arguments` : `${command} needs ${min === max ? min : `${min} to ${max}`} argument${max === 1 ? "" : "s"}`;
    throw new CodemmError(`${expected}. Usage: codemm ${spec.usage}`);
  }
  return { command, args, options };
}
