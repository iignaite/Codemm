import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readWorkspace } from "./store.js";

const WARN = "Codemm hook: couldn't read the file path from the hook input; allowing the edit.";

/**
 * Resolves symlinks and aliases (e.g. /tmp vs /private/tmp) through the deepest existing ancestor.
 * The OS's own realpath also returns the on-disk spelling, so case on macOS and Windows
 * and Windows short names (RUNNER~1) can't hide a path from the check.
 */
function canonical(path: string): string {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync.native(existing), ...rest);
}

/**
 * True when the workspace's disk ignores case: a name in it, in another case, is the same file.
 * codemm.json always has letters to swap; the workspace's own name is the fallback.
 */
function caseInsensitive(ws: string): boolean {
  for (const path of [join(ws, "codemm.json"), ws]) {
    const name = basename(path);
    const swapped = name.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
    if (swapped === name) continue;
    try {
      const [a, b] = [statSync(path, { bigint: true }), statSync(join(dirname(path), swapped), { bigint: true })];
      return a.dev === b.dev && a.ino === b.ino;
    } catch {
      // That name doesn't exist (or its swap doesn't): try the next.
    }
  }
  return false;
}

/**
 * Claude Code PreToolUse hook. Exit 2 blocks the edit and shows the message to the agent.
 * A practice aid, not a security boundary: bad input is let through, with a warning, rather than breaking the agent.
 */
export function claudeHook(ws: string, stdin: string): { exit: 0 | 2; message?: string } {
  let path: unknown;
  try {
    const input = JSON.parse(stdin);
    path = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
  } catch {
    return { exit: 0, message: WARN };
  }
  if (typeof path !== "string" || path === "") return { exit: 0, message: WARN };

  // Where the disk ignores case, EXERCISES/ is exercises/ even before either exists.
  const fold = caseInsensitive(canonical(resolve(ws))) ? (p: string) => p.toLowerCase() : (p: string) => p;
  const rel = relative(fold(canonical(resolve(ws, "exercises"))), fold(canonical(resolve(ws, path))));
  // Compare whole path components: "..notes" is a name, ".." is a step out.
  const inside = rel !== "" && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
  if (!inside) return { exit: 0 };

  let assist = false;
  try {
    assist = readWorkspace(ws).assist;
  } catch {
    // An unreadable codemm.json means practice mode.
  }
  if (assist) return { exit: 0 };
  return {
    exit: 2,
    message:
      "Codemm practice mode: the learner writes the code in exercises/. Give a hint, explain the concept or point at the failing test instead. " +
      "(The learner can run `codemm assist on` to allow your edits; assisted attempts count for less.)",
  };
}
