/**
 * Hosts keep session transcripts in the owner's home. Runs need them (subagents resume through them),
 * so the bench lets hosts write them and deletes only the ones whose working folder was this run's temp folder.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code: ~/.claude/projects/<cwd with non-alphanumerics replaced by "-">. */
export function removeClaudeSessions(ws: string): void {
  for (const path of new Set([ws, realpathSync(ws)])) rmSync(join(homedir(), ".claude", "projects", path.replace(/[^a-zA-Z0-9]/g, "-")), { recursive: true, force: true });
}

/** The session's working folder, from the start of its first line (the line itself can be far longer). */
const sessionCwd = (file: string): string => {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(buf.subarray(0, n).toString("utf8").split("\n")[0]!);
    return m ? (JSON.parse(m[1]!) as string) : "";
  } finally {
    closeSync(fd);
  }
};

/** Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl whose session_meta cwd is inside `root` (a unique temp folder). */
export function removeCodexSessions(root: string): number {
  const roots = [...new Set([root, existsSync(root) ? realpathSync(root) : root])];
  const base = join(homedir(), ".codex", "sessions");
  let removed = 0;
  const walk = (dir: string, depth: number) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (depth < 3) {
        if (statSync(path).isDirectory()) walk(path, depth + 1);
      } else if (name.endsWith(".jsonl")) {
        const cwd = sessionCwd(path);
        if (roots.some((r) => cwd === r || cwd.startsWith(`${r}/`))) {
          rmSync(path, { force: true });
          removed += 1;
        }
      }
    }
  };
  walk(base, 0);
  return removed;
}
