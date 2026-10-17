import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CodemmError } from "./errors.js";
import { AGENTS_END, AGENTS_SECTION, AGENTS_START, AUTHOR_AGENT } from "./templates.js";

export const HOSTS = ["claude", "codex", "cursor"] as const;
export type Host = (typeof HOSTS)[number];
/** How a host should start Codemm: an absolute command plus leading args (e.g. node + cli.js). */
export type Launcher = { command: string; args: string[] };

const HOOK_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function readJson(ws: string, rel: string): Record<string, any> {
  const path = join(ws, rel);
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // fall through
  }
  throw new CodemmError(`Can't update ${rel}: it isn't a valid JSON object. Fix it, then run codemm init again.`);
}

/** Writes a file only if its content would change. Returns whether it is now Codemm-configured. */
function write(ws: string, rel: string, content: string, written: string[]): void {
  const path = join(ws, rel);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path) || readFileSync(path, "utf8") !== content) writeFileSync(path, content);
  written.push(rel);
}

function withSection(existing: string): string {
  const start = existing.indexOf(AGENTS_START);
  const end = existing.indexOf(AGENTS_END);
  if (start >= 0 && end > start) return existing.slice(0, start) + AGENTS_SECTION.trimEnd() + existing.slice(end + AGENTS_END.length);
  return existing ? `${existing.replace(/\n*$/, "\n\n")}${AGENTS_SECTION}` : AGENTS_SECTION;
}

function withCodexServer(existing: string, launcher: Launcher, ws: string): string {
  const block = `[mcp_servers.codemm]\ncommand = ${JSON.stringify(launcher.command)}\nargs = [${[...launcher.args, "mcp", "--workspace", ws].map((a) => JSON.stringify(a)).join(", ")}]\n`;
  const lines = existing.split("\n");
  const start = lines.findIndex((l) => l.trim() === "[mcp_servers.codemm]");
  if (start < 0) return existing ? `${existing.replace(/\n*$/, "\n\n")}${block}` : block;
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  const before = lines.slice(0, start).join("\n");
  const after = lines.slice(end).join("\n");
  return `${before}${before ? "\n" : ""}${block}${after ? `\n${after}` : ""}`;
}

/** Sets up the chosen hosts (all three when `hosts` is empty) in workspace `ws`. Returns the files written. */
export function init(ws: string, hosts: Host[], launcher: Launcher): string[] {
  const chosen = new Set(hosts.length > 0 ? hosts : HOSTS);
  const written: string[] = [];
  const mcpArgs = [...launcher.args, "mcp", "--workspace", ws];

  // Validate every config before writing any, so a bad file leaves the project untouched.
  const claudeMcp = chosen.has("claude") ? readJson(ws, ".mcp.json") : undefined;
  const claudeSettings = chosen.has("claude") ? readJson(ws, ".claude/settings.json") : undefined;
  const cursorMcp = chosen.has("cursor") ? readJson(ws, ".cursor/mcp.json") : undefined;

  write(ws, "AGENTS.md", withSection(existsSync(join(ws, "AGENTS.md")) ? readFileSync(join(ws, "AGENTS.md"), "utf8") : ""), written);
  write(ws, ".claude/agents/codemm-author.md", AUTHOR_AGENT, written);

  if (claudeMcp && claudeSettings) {
    const claudeMd = existsSync(join(ws, "CLAUDE.md")) ? readFileSync(join(ws, "CLAUDE.md"), "utf8") : "";
    const hasImport = claudeMd.split("\n").some((l) => l.trim() === "@AGENTS.md");
    write(ws, "CLAUDE.md", hasImport ? claudeMd : `${claudeMd ? claudeMd.replace(/\n*$/, "\n\n") : ""}@AGENTS.md\n`, written);

    claudeMcp.mcpServers = { ...claudeMcp.mcpServers, codemm: { type: "stdio", command: launcher.command, args: mcpArgs } };
    write(ws, ".mcp.json", `${JSON.stringify(claudeMcp, null, 2)}\n`, written);

    const command = [launcher.command, ...launcher.args].map(shellQuote).join(" ") + ` hook claude --workspace ${shellQuote(ws)}`;
    const hooks = claudeSettings.hooks ?? {};
    const others = (hooks.PreToolUse ?? []).filter((h: any) => !(h.hooks ?? []).some((x: any) => String(x.command ?? "").includes(" hook claude ")));
    claudeSettings.hooks = { ...hooks, PreToolUse: [...others, { matcher: HOOK_MATCHER, hooks: [{ type: "command", command }] }] };
    write(ws, ".claude/settings.json", `${JSON.stringify(claudeSettings, null, 2)}\n`, written);
  }

  if (chosen.has("codex")) {
    const path = join(ws, ".codex/config.toml");
    write(ws, ".codex/config.toml", withCodexServer(existsSync(path) ? readFileSync(path, "utf8") : "", launcher, ws), written);
  }

  if (cursorMcp) {
    cursorMcp.mcpServers = { ...cursorMcp.mcpServers, codemm: { command: launcher.command, args: mcpArgs } };
    write(ws, ".cursor/mcp.json", `${JSON.stringify(cursorMcp, null, 2)}\n`, written);
  }
  return written;
}
