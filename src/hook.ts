import { isAbsolute, relative, resolve } from "node:path";
import { readWorkspace } from "./store.js";

/**
 * Claude Code PreToolUse hook. Exit 2 blocks the edit and shows the message to the agent.
 * A practice aid, not a security boundary: bad input is let through rather than breaking the agent.
 */
export function claudeHook(ws: string, stdin: string): { exit: 0 | 2; message?: string } {
  let path: unknown;
  try {
    const input = JSON.parse(stdin);
    path = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
  } catch {
    return { exit: 0, message: "Codemm hook: couldn't read the hook input; allowing the edit." };
  }
  if (typeof path !== "string" || path === "") return { exit: 0 };

  const rel = relative(resolve(ws, "exercises"), resolve(ws, path));
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
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
