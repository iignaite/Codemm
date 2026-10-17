import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  it("sets up all three hosts by default, pointing every launch at this workspace", () => {
    const written = init(ws, [], launcher);
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

  it("only touches the hosts you name", () => {
    expect(init(ws, ["cursor"], launcher).sort()).toEqual([".claude/agents/codemm-author.md", ".cursor/mcp.json", "AGENTS.md"].sort());
  });

  it("is idempotent", () => {
    init(ws, [], launcher);
    const before = ["AGENTS.md", "CLAUDE.md", ".mcp.json", ".claude/settings.json", ".codex/config.toml", ".cursor/mcp.json"].map(read);
    init(ws, [], launcher);
    expect(["AGENTS.md", "CLAUDE.md", ".mcp.json", ".claude/settings.json", ".codex/config.toml", ".cursor/mcp.json"].map(read)).toEqual(before);
  });

  it("keeps unrelated config and replaces only Codemm's own entries", () => {
    writeFileSync(join(ws, "AGENTS.md"), "# My rules\n\nBe kind.\n");
    writeFileSync(join(ws, "CLAUDE.md"), "# Team notes\n");
    writeFileSync(join(ws, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" }, codemm: { command: "old" } } }));
    mkdirSync(join(ws, ".claude"));
    writeFileSync(join(ws, ".claude", "settings.json"), JSON.stringify({ model: "x", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit" }] }] } }));
    mkdirSync(join(ws, ".codex"));
    writeFileSync(join(ws, ".codex", "config.toml"), 'model = "m"\n\n[mcp_servers.codemm]\ncommand = "old"\n\n[mcp_servers.other]\ncommand = "y"\n');

    init(ws, [], launcher);
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

  it("refuses to rewrite a config file it can't parse", () => {
    writeFileSync(join(ws, ".mcp.json"), "{ not json");
    expect(() => init(ws, ["claude"], launcher)).toThrow(/\.mcp\.json/);
    expect(read(".mcp.json")).toBe("{ not json");
  });
});
