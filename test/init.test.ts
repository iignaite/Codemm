import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { init } from "../src/init.js";

const launcher = { command: "/opt/node/bin/node", args: ["/opt/codemm/dist/cli.js"] };
let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "codemm init-"));
});
const read = (p: string) => readFileSync(join(ws, p), "utf8");
const json = (p: string) => JSON.parse(read(p));

describe("init", () => {
  it("sets up all three hosts by default, pointing every launch at this workspace", async () => {
    const written = await init(ws, [], launcher, "linux");
    expect(written.sort()).toEqual(
      [".claude/agents/codemm-author.md", ".claude/settings.json", ".codex/config.toml", ".cursor/mcp.json", ".mcp.json", "AGENTS.md", "CLAUDE.md"].sort(),
    );
    expect(json(".mcp.json").mcpServers.codemm).toEqual({ type: "stdio", command: launcher.command, args: [...launcher.args, "mcp", "--workspace", ws] });
    expect(json(".cursor/mcp.json").mcpServers.codemm.args).toEqual([...launcher.args, "mcp", "--workspace", ws]);
    expect(read(".codex/config.toml")).toContain(`[mcp_servers.codemm]\ncommand = "/opt/node/bin/node"\nargs = ["/opt/codemm/dist/cli.js", "mcp", "--workspace", ${JSON.stringify(ws)}]`);
    const hook = json(".claude/settings.json").hooks.PreToolUse[0];
    expect(hook.matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
    expect(hook.hooks[0].command).toBe(`'/opt/node/bin/node' '/opt/codemm/dist/cli.js' hook claude --workspace '${ws}'`);
    expect(read("CLAUDE.md")).toContain("@AGENTS.md");
    expect(read("AGENTS.md")).toContain("<!-- codemm:start -->");
  });

  it("only touches the hosts you name", async () => {
    expect((await init(ws, ["cursor"], launcher)).sort()).toEqual([".claude/agents/codemm-author.md", ".cursor/mcp.json", "AGENTS.md"].sort());
  });

  it("is idempotent", async () => {
    await init(ws, [], launcher);
    const before = ["AGENTS.md", "CLAUDE.md", ".mcp.json", ".claude/settings.json", ".codex/config.toml", ".cursor/mcp.json"].map(read);
    await init(ws, [], launcher);
    expect(["AGENTS.md", "CLAUDE.md", ".mcp.json", ".claude/settings.json", ".codex/config.toml", ".cursor/mcp.json"].map(read)).toEqual(before);
  });

  it("keeps unrelated config and replaces only Codemm's own entries", async () => {
    writeFileSync(join(ws, "AGENTS.md"), "# My rules\n\nBe kind.\n");
    writeFileSync(join(ws, "CLAUDE.md"), "# Team notes\n");
    writeFileSync(join(ws, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" }, codemm: { command: "old" } } }));
    mkdirSync(join(ws, ".claude"));
    writeFileSync(join(ws, ".claude", "settings.json"), JSON.stringify({ model: "x", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit" }] }] } }));
    mkdirSync(join(ws, ".codex"));
    writeFileSync(join(ws, ".codex", "config.toml"), 'model = "m"\n\n[mcp_servers.codemm]\ncommand = "old"\n\n[mcp_servers.other]\ncommand = "y"\n');

    await init(ws, [], launcher);
    expect(read("AGENTS.md")).toMatch(/^# My rules\n\nBe kind\.\n/);
    expect(read("CLAUDE.md")).toMatch(/^# Team notes\n/);
    expect(read("CLAUDE.md")).toContain("@AGENTS.md");
    expect(json(".mcp.json").mcpServers.other).toEqual({ command: "x" });
    expect(json(".mcp.json").mcpServers.codemm.command).toBe(launcher.command);
    const settings = json(".claude/settings.json");
    expect(settings.model).toBe("x");
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    const toml = read(".codex/config.toml");
    expect(toml).toContain('model = "m"');
    expect(toml).toContain('[mcp_servers.other]\ncommand = "y"');
    expect(toml.match(/\[mcp_servers\.codemm\]/g)).toHaveLength(1);
    expect(toml).not.toContain('command = "old"');
  });

  it("finds an existing Codemm table even with a comment or quotes, and keeps the TOML valid", async () => {
    const { parse } = await import("smol-toml");
    mkdirSync(join(ws, ".codex"));
    writeFileSync(join(ws, ".codex", "config.toml"), '[mcp_servers."codemm"] # mine\ncommand = "old"\n\n[other]\nx = 1\n');
    await init(ws, ["codex"], launcher);
    const toml = read(".codex/config.toml");
    const parsed = parse(toml) as { mcp_servers: { codemm: { command: string } }; other: { x: number } };
    expect(parsed.mcp_servers.codemm.command).toBe(launcher.command);
    expect(parsed.other.x).toBe(1);
  });

  it.each(["linux", "win32"] as const)("removes only its own hook entry from a shared hook group (%s)", async (platform) => {
    await init(ws, ["claude"], launcher, platform);
    const settings = json(".claude/settings.json");
    settings.hooks.PreToolUse[0].hooks.push({ type: "command", command: "audit-edits" });
    writeFileSync(join(ws, ".claude", "settings.json"), JSON.stringify(settings));
    await init(ws, ["claude"], launcher, platform);
    const hooks = json(".claude/settings.json").hooks.PreToolUse.flatMap((g: any) => g.hooks);
    expect(hooks.filter((h: any) => h.command === "audit-edits")).toHaveLength(1);
    expect(hooks.filter((h: any) => h.command !== "audit-edits")).toHaveLength(1);
  });

  it("on Windows, runs the hook without a shell, since Git Bash and PowerShell can't run a quoted C:\\ path", async () => {
    const win = { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\Users\\me\\codemm\\dist\\cli.js"] };
    await init(ws, ["claude"], win, "win32");
    await init(ws, ["claude"], win, "win32");
    const hooks = json(".claude/settings.json").hooks.PreToolUse.flatMap((g: any) => g.hooks);
    expect(hooks).toEqual([{ type: "command", command: win.command, args: [...win.args, "hook", "claude", "--workspace", ws] }]);
  });

  it("writes nothing when a nested setting has the wrong shape", async () => {
    mkdirSync(join(ws, ".claude"));
    writeFileSync(join(ws, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: { not: "a list" } } }));
    await expect(init(ws, [], launcher)).rejects.toThrow(/settings\.json/);
    expect(() => read("AGENTS.md")).toThrow();
    expect(() => read(".mcp.json")).toThrow();
  });

  it("refuses to write through a symlinked config folder", async () => {
    const outside = mkdtempSync(join(tmpdir(), "codemm-outside-"));
    symlinkSync(outside, join(ws, ".claude"));
    await expect(init(ws, ["claude"], launcher)).rejects.toThrow(/symlink/i);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses to rewrite a config file it can't parse", async () => {
    writeFileSync(join(ws, ".mcp.json"), "{ not json");
    await expect(init(ws, ["claude"], launcher)).rejects.toThrow(/\.mcp\.json/);
    expect(read(".mcp.json")).toBe("{ not json");
  });
});
