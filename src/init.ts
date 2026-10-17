import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { CodemmError } from "./errors.js";
import { withWorkspaceLock } from "./store.js";
import { AGENTS_END, AGENTS_SECTION, AGENTS_START, AUTHOR_AGENT } from "./templates.js";

export const HOSTS = ["claude", "codex", "cursor"] as const;
export type Host = (typeof HOSTS)[number];
/** How a host should start Codemm: an absolute command plus leading args (e.g. node + cli.js). */
export type Launcher = { command: string; args: string[] };

const HOOK_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Refuses any path whose existing components (inside the workspace) include a symlink. */
function assertNoSymlink(ws: string, rel: string): void {
  let current = ws;
  for (const part of rel.split("/")) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new CodemmError(`Refusing to write through the symlink at ${current}. Replace it with a real folder or file, then rerun codemm init.`);
    }
  }
}

const readText = (ws: string, rel: string) => (existsSync(join(ws, rel)) ? readFileSync(join(ws, rel), "utf8") : "");

function readJson(ws: string, rel: string): Record<string, any> {
  const text = readText(ws, rel);
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (isObject(value)) return value;
  } catch {
    // fall through
  }
  throw new CodemmError(`Can't update ${rel}: it isn't a valid JSON object. Fix it, then run codemm init again.`);
}

function withSection(existing: string): string {
  const start = existing.indexOf(AGENTS_START);
  const end = existing.indexOf(AGENTS_END);
  if (start >= 0 && end > start) return existing.slice(0, start) + AGENTS_SECTION.trimEnd() + existing.slice(end + AGENTS_END.length);
  return existing ? `${existing.replace(/\n*$/, "\n\n")}${AGENTS_SECTION}` : AGENTS_SECTION;
}

// A table header for the codemm server: [mcp_servers.codemm], with optional spaces, quotes and a trailing comment.
const CODEMM_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*(?:codemm|"codemm"|'codemm')\s*\]\s*(?:#.*)?$/;
const ANY_TABLE = /^\s*\[/;

function withCodexServer(existing: string, launcher: Launcher, ws: string): string {
  let before: Record<string, any>;
  try {
    before = parseToml(existing) as Record<string, any>;
  } catch (e) {
    throw new CodemmError(`Can't update .codex/config.toml: it isn't valid TOML (${(e as Error).message.split("\n")[0]}). Fix it, then run codemm init again.`);
  }
  const block = `[mcp_servers.codemm]\ncommand = ${JSON.stringify(launcher.command)}\nargs = [${[...launcher.args, "mcp", "--workspace", ws].map((a) => JSON.stringify(a)).join(", ")}]\n`;
  const lines = existing.split("\n");
  const start = lines.findIndex((l) => CODEMM_TABLE.test(l));
  let next: string;
  if (start < 0) {
    if (before.mcp_servers?.codemm !== undefined) {
      throw new CodemmError("Can't update .codex/config.toml: mcp_servers.codemm is defined in a form codemm init can't edit. Remove it, then run codemm init again.");
    }
    next = existing ? `${existing.replace(/\n*$/, "\n\n")}${block}` : block;
  } else {
    let end = lines.findIndex((l, i) => i > start && ANY_TABLE.test(l));
    if (end < 0) end = lines.length;
    const head = lines.slice(0, start).join("\n");
    const tail = lines.slice(end).join("\n");
    next = `${head}${head ? "\n" : ""}${block}${tail ? `\n${tail}` : ""}`;
  }
  // Never write TOML we can't read back.
  const after = parseToml(next) as Record<string, any>;
  if (after.mcp_servers?.codemm?.command !== launcher.command) throw new CodemmError("Couldn't update .codex/config.toml safely. Add the codemm server by hand.");
  return next;
}

/**
 * Claude Code's hook entry. Windows runs a shell-form hook in Git Bash or PowerShell, and neither can run a
 * quoted C:\\ path, so there the hook uses exec form: the executable and its arguments, with no shell.
 */
function hookEntry(launcher: Launcher, ws: string, platform: NodeJS.Platform): Record<string, unknown> {
  if (platform === "win32") return { type: "command", command: launcher.command, args: [...launcher.args, ...hookArgs(ws)] };
  return { type: "command", command: `${[launcher.command, ...launcher.args].map(shellQuote).join(" ")} hook claude --workspace ${shellQuote(ws)}` };
}
const hookArgs = (ws: string) => ["hook", "claude", "--workspace", ws];

function withHook(settings: Record<string, any>, entry: Record<string, unknown>, ws: string): Record<string, any> {
  const hooks = settings.hooks ?? {};
  if (!isObject(hooks)) throw new CodemmError("Can't update .claude/settings.json: hooks must be an object.");
  const groups = hooks.PreToolUse ?? [];
  if (!Array.isArray(groups) || !groups.every((g) => isObject(g) && Array.isArray(g.hooks ?? []))) {
    throw new CodemmError("Can't update .claude/settings.json: hooks.PreToolUse must be a list of hook groups.");
  }
  // Remove only Codemm's own entries for this workspace; keep every other hook and the group around it.
  const ours = (h: any) =>
    (typeof h?.command === "string" && h.command.endsWith(` hook claude --workspace ${shellQuote(ws)}`)) ||
    (Array.isArray(h?.args) && JSON.stringify(h.args.slice(-4)) === JSON.stringify(hookArgs(ws)));
  const kept = groups
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !ours(h)) }))
    .filter((g, i) => g.hooks.length > 0 || (groups[i].hooks ?? []).length === 0);
  return { ...settings, hooks: { ...hooks, PreToolUse: [...kept, { matcher: HOOK_MATCHER, hooks: [entry] }] } };
}

function withServer(config: Record<string, any>, rel: string, server: Record<string, unknown>): Record<string, any> {
  const servers = config.mcpServers ?? {};
  if (!isObject(servers)) throw new CodemmError(`Can't update ${rel}: mcpServers must be an object.`);
  return { ...config, mcpServers: { ...servers, codemm: server } };
}

/**
 * Sets up the chosen hosts (all three when `hosts` is empty) in workspace `ws`.
 * Every file is prepared and validated first; nothing is written unless all of it is valid.
 * Each write replaces the file atomically. Returns the files written.
 */
export async function init(ws: string, hosts: Host[], launcher: Launcher, platform = process.platform): Promise<string[]> {
  return withWorkspaceLock(ws, async () => prepareAndWrite(ws, hosts, launcher, platform));
}

function prepareAndWrite(ws: string, hosts: Host[], launcher: Launcher, platform: NodeJS.Platform): string[] {
  const chosen = new Set(hosts.length > 0 ? hosts : HOSTS);
  const mcpArgs = [...launcher.args, "mcp", "--workspace", ws];
  const files: [string, string][] = [
    ["AGENTS.md", withSection(readText(ws, "AGENTS.md"))],
    [".claude/agents/codemm-author.md", AUTHOR_AGENT],
  ];

  if (chosen.has("claude")) {
    const claudeMd = readText(ws, "CLAUDE.md");
    const hasImport = claudeMd.split("\n").some((l) => l.trim() === "@AGENTS.md");
    files.push(["CLAUDE.md", hasImport ? claudeMd : `${claudeMd ? claudeMd.replace(/\n*$/, "\n\n") : ""}@AGENTS.md\n`]);
    files.push([".mcp.json", json(withServer(readJson(ws, ".mcp.json"), ".mcp.json", { type: "stdio", command: launcher.command, args: mcpArgs }))]);
    files.push([".claude/settings.json", json(withHook(readJson(ws, ".claude/settings.json"), hookEntry(launcher, ws, platform), ws))]);
  }
  if (chosen.has("codex")) files.push([".codex/config.toml", withCodexServer(readText(ws, ".codex/config.toml"), launcher, ws)]);
  if (chosen.has("cursor")) files.push([".cursor/mcp.json", json(withServer(readJson(ws, ".cursor/mcp.json"), ".cursor/mcp.json", { command: launcher.command, args: mcpArgs }))]);

  for (const [rel] of files) assertNoSymlink(ws, rel);
  for (const [rel, content] of files) {
    const path = join(ws, rel);
    if (existsSync(path) && readFileSync(path, "utf8") === content) continue;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.codemm-${process.pid}.tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  }
  return files.map(([rel]) => rel);
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
