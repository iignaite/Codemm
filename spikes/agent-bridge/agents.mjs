/**
 * What differs between agent CLIs: how to launch a headless turn with Codemm's MCP server,
 * how to read its JSON stream as common events, and how to ask whether the learner is signed in.
 *
 * Events: { type: "session", id } | { type: "text", text } | { type: "tool_call", id, name }
 *       | { type: "tool_result", id, error } | { type: "done", ok, error? }
 * MCP tool names are normalized to "<server>.<tool>". Lines of any other shape produce no events.
 */

function json(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const toml = (value) =>
  Array.isArray(value)
    ? `[${value.map(toml).join(",")}]`
    : typeof value === "object"
      ? `{${Object.entries(value).map(([k, v]) => `${k}=${toml(v)}`).join(",")}}`
      : JSON.stringify(value);

const str = (v) => typeof v === "string";

const plain = (text) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

const claude = {
  launch({ prompt, server, tools = [], model, resume }) {
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
    // --tools "" removes every built-in tool (shell, file reads, web), leaving only the codemm server.
    args.push("--tools", "", "--mcp-config", JSON.stringify({ mcpServers: { codemm: server } }), "--strict-mcp-config");
    if (tools.length) args.push("--allowedTools", tools.map((t) => `mcp__codemm__${t}`).join(","));
    if (model) args.push("--model", model);
    if (resume) args.push("--resume", resume);
    return { command: "claude", args };
  },
  parse(line) {
    const e = json(line);
    if (!e) return [];
    if (e.type === "system" && e.subtype === "init") return str(e.session_id) ? [{ type: "session", id: e.session_id }] : [];
    if (e.type === "result") return [e.is_error || e.subtype !== "success" ? { type: "done", ok: false, error: String(e.result ?? e.subtype) } : { type: "done", ok: true }];
    if (e.type !== "assistant" && e.type !== "user") return [];
    const content = e.message?.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((c) => {
      if (c?.type === "text" && str(c.text)) return [{ type: "text", text: c.text }];
      if (c?.type === "tool_use" && str(c.id) && str(c.name)) return [{ type: "tool_call", id: c.id, name: c.name.replace(/^mcp__(.+?)__/, "$1.") }];
      if (c?.type === "tool_result" && str(c.tool_use_id)) return [{ type: "tool_result", id: c.tool_use_id, error: c.is_error === true }];
      return [];
    });
  },
  signIn: {
    command: "claude",
    args: ["auth", "status", "--json"],
    read: ({ output }) => json(output)?.loggedIn === true,
  },
};

const codex = {
  launch({ prompt, server, tools = [], model, resume }) {
    const args = ["exec", "--json", "--skip-git-repo-check"];
    // Turn off command execution and host automation. Codex still keeps some host tools (DESIGN §3.1).
    for (const feature of ["shell_tool", "unified_exec", "browser_use", "computer_use", "apps"]) args.push("--disable", feature);
    for (const c of [
      'sandbox_mode="read-only"',
      `mcp_servers.codemm.command=${toml(server.command)}`,
      `mcp_servers.codemm.args=${toml(server.args)}`,
      `mcp_servers.codemm.env=${toml(server.env ?? {})}`,
      `mcp_servers.codemm.enabled_tools=${toml(tools)}`,
      // Safe only because enabled_tools limits approval to the job's tools.
      'mcp_servers.codemm.default_tools_approval_mode="approve"',
    ]) {
      args.push("-c", c);
    }
    if (model) args.push("-m", model);
    return { command: "codex", args: resume ? ["exec", "resume", ...args.slice(1), resume, prompt] : [...args, prompt] };
  },
  parse(line) {
    const e = json(line);
    if (!e) return [];
    if (e.type === "thread.started") return str(e.thread_id) ? [{ type: "session", id: e.thread_id }] : [];
    if (e.type === "turn.completed") return [{ type: "done", ok: true }];
    if (e.type === "turn.failed") return [{ type: "done", ok: false, error: String(e.error?.message ?? "turn failed") }];
    const item = e.item;
    if (item?.type === "agent_message" && e.type === "item.completed" && str(item.text)) return [{ type: "text", text: item.text }];
    if (item?.type === "mcp_tool_call" && str(item.id) && str(item.server) && str(item.tool)) {
      if (e.type === "item.started") return [{ type: "tool_call", id: item.id, name: `${item.server}.${item.tool}` }];
      if (e.type === "item.completed") return [{ type: "tool_result", id: item.id, error: item.status !== "completed" || item.error != null }];
    }
    return [];
  },
  signIn: {
    command: "codex",
    args: ["login", "status"],
    read: ({ code, output }) => code === 0 && /^logged in/im.test(plain(output).trim()),
  },
};

/** Cursor is unverified here (not signed in), so only sign-in detection is implemented. */
const cursor = {
  signIn: {
    command: "cursor-agent",
    args: ["status"],
    read: ({ code, output }) => code === 0 && !/not logged in/i.test(plain(output)) && /logged in/i.test(plain(output)),
  },
};

export const agents = { claude, codex, cursor };
