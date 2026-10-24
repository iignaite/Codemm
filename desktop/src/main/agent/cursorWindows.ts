// Cursor's CLI on Windows (DESIGN §3.1). Its cursor-agent.cmd runs Windows PowerShell 5.1 on cursor-agent.ps1, which
// runs versions\<v>\node.exe on versions\<v>\index.js. Codemm never runs a shell, and a brief through cmd and PowerShell
// would arrive cut or mangled, so Codemm starts that node.exe on that index.js itself, as Cursor's staff advise.
// The version is chosen as cursor-agent.ps1 (2026.10.22-27dcf5f, read on a GitHub Windows runner) chooses it.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Executable } from './bridge';

/** cursor-agent.ps1's version pattern: `2026.10.22-27dcf5f`, or with a build time, `2026.06.12-19-59-36-f6aba9a`. Staged `.new` and `.previous` folders never match. */
const VERSION = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-[a-f0-9]+$/;

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Newest first by date, as cursor-agent.ps1 sorts; its order within a day is unspecified, so the build time, then the name, decide. */
function newest(a: string, b: string): number {
  const [x, y] = [VERSION.exec(a)!, VERSION.exec(b)!];
  for (let i = 1; i <= 6; i++) if (Number(x[i] ?? 0) !== Number(y[i] ?? 0)) return Number(y[i] ?? 0) - Number(x[i] ?? 0);
  return b.localeCompare(a);
}

/** The node.exe and index.js `cursor-agent.cmd` would run from this install root, or null (not installed). */
export function cursorEntry(root: string): { node: string; script: string } | null {
  const versions = join(root, 'versions');
  let names: string[];
  try {
    names = readdirSync(versions);
  } catch {
    return null;
  }
  // Unlike the launcher, a folder without both files is passed over rather than started half-working.
  const v = names.filter((n) => VERSION.test(n) && isFile(join(versions, n, 'node.exe')) && isFile(join(versions, n, 'index.js'))).sort(newest)[0];
  return v ? { node: join(versions, v, 'node.exe'), script: join(versions, v, 'index.js') } : null;
}

/** Cursor's own Node running its script, as its launcher runs it, or null when this root holds no usable version. */
export function cursorExecutable(root: string): Executable | null {
  const entry = cursorEntry(root);
  return entry && { path: entry.node, js: false, args: [entry.script], env: { CURSOR_INVOKED_AS: 'cursor-agent.cmd' } };
}
