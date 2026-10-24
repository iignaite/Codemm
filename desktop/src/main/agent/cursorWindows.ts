// Cursor's CLI on Windows (DESIGN §3.1). Its cursor-agent.cmd runs Windows PowerShell 5.1 on cursor-agent.ps1, which
// runs versions\<v>\node.exe on versions\<v>\index.js. Codemm never runs a shell, and a brief through cmd and PowerShell
// would arrive cut or mangled, so Codemm starts that node.exe on that index.js itself, as Cursor's staff advise.
// Version choice to confirm on Windows: the folder cursor-agent.ps1 names, else the newest complete one.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Executable } from './bridge';

/** A version folder: `2026.10.22-27dcf5f`, or with a time, `2026.06.12-19-59-36-f6aba9a`. Staged `.new`, `.previous` and temporary folders never match. */
const VERSION = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{1,2})-(\d{1,2})-(\d{1,2}))?-[0-9a-f]+$/;
const NAMED = /\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{1,2}-\d{1,2}-\d{1,2})?-[0-9a-f]+/g;

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Newest first: date and time compared as numbers. */
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
  const usable = names.filter((v) => VERSION.test(v) && isFile(join(versions, v, 'node.exe')) && isFile(join(versions, v, 'index.js'))).sort(newest);
  let named: string[] = [];
  try {
    named = readFileSync(join(root, 'cursor-agent.ps1'), 'utf8').match(NAMED) ?? [];
  } catch {
    // no launcher script: the newest version
  }
  const v = usable.find((u) => named.includes(u)) ?? usable[0];
  return v ? { node: join(versions, v, 'node.exe'), script: join(versions, v, 'index.js') } : null;
}

const systemCaCache = new Map<string, boolean>();
const runs = (file: string, args: string[]) => spawnSync(file, args, { stdio: 'ignore', timeout: 10_000, windowsHide: true }).status === 0;

/** Whether this Node takes --use-system-ca, asked once per Node, as Cursor's launcher does unless the file credential store is in use. */
export function systemCa(node: string, env: NodeJS.ProcessEnv = process.env, probe = runs): boolean {
  if (env.AGENT_CLI_CREDENTIAL_STORE === 'file') return false;
  let known = systemCaCache.get(node);
  if (known === undefined) systemCaCache.set(node, (known = probe(node, ['--use-system-ca', '--version'])));
  return known;
}

/** Cursor's own Node running its script, as the agent to run, or null when this root holds no usable version. */
export function cursorExecutable(root: string, useSystemCa: (node: string) => boolean = systemCa): Executable | null {
  const entry = cursorEntry(root);
  if (!entry) return null;
  return { path: entry.node, js: false, args: [...(useSystemCa(entry.node) ? ['--use-system-ca'] : []), entry.script], env: { CURSOR_INVOKED_AS: 'cursor-agent' } };
}
