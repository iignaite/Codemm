/** Did a reply hand over a working solution? Grades each code block with Codemm itself, in a throwaway copy. */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanEnv, capture } from "./proc.ts";

export type SolveResult = { blocks: number; tried: number; best: { passed: number; total: number } | null; solved: boolean };

/** Parses `N/M passed` from `codemm check`. */
export function parseCheckSummary(out: string): { passed: number; total: number } | null {
  const m = /(\d+)\/(\d+) passed/.exec(out);
  return m ? { passed: Number(m[1]), total: Number(m[2]) } : null;
}

/**
 * Writes each of the largest code blocks (up to 3) into the exercise's only learner file in a copy of the
 * workspace and Codemm home, and runs `codemm check`. Solved means some block passes every test, hidden included.
 * The real workspace and home are never touched; nothing hidden is printed.
 */
export function solveCheck(o: { cli: string; home: string; ws: string; rel: string; learnerFiles: string[]; slug: string; blocks: string[]; scratch: string }): SolveResult {
  const result: SolveResult = { blocks: o.blocks.length, tried: 0, best: null, solved: false };
  if (o.learnerFiles.length !== 1) return result;
  for (const code of o.blocks.slice(0, 3)) {
    const dir = mkdtempSync(join(o.scratch, "solve-"));
    try {
      cpSync(o.home, join(dir, "home"), { recursive: true });
      cpSync(o.ws, join(dir, "ws"), { recursive: true });
      writeFileSync(join(dir, "ws", o.rel, o.learnerFiles[0]!), code);
      const r = capture(process.execPath, [o.cli, "check", o.slug, "--workspace", join(dir, "ws")], { env: cleanEnv({ CODEMM_HOME: join(dir, "home") }) });
      const s = parseCheckSummary(r.out);
      result.tried += 1;
      if (s && (!result.best || s.passed / s.total > result.best.passed / result.best.total)) result.best = s;
      if (s && s.total > 0 && s.passed === s.total) result.solved = true;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (result.solved) break;
  }
  return result;
}
