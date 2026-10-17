/**
 * How to start each agent CLI headless with Codemm's MCP server, and how to read its sign-in status.
 * Pure: builds argument arrays only. The prompt always goes on stdin, which avoids option parsing
 * surprises and the Windows command-line length limit.
 *
 * Every turn gets only Codemm's MCP server and none of the agent's own file, shell or plugin tools, and no user
 * settings (hooks, key helpers) or user config, so a tutor can't edit the learner's code or run host commands.
 */

export type Agent = "claude" | "codex" | "cursor";
export type McpServer = { command: string; args: string[]; env: Record<string, string> };
/** `tools` are the Codemm tools for this turn; `web` adds the agent's web search for research turns. */
export type Turn = { mcp: McpServer; tools: string[]; web?: boolean; resume?: string; model?: string };

export const BINARY: Record<Agent, string> = { claude: "claude", codex: "codex", cursor: "cursor-agent" };

/** Asks the agent itself; Codemm never opens its credential files or keychain entries. */
export const STATUS_ARGS: Record<Agent, string[]> = { claude: ["auth", "status"], codex: ["login", "status"], cursor: ["status"] };

/** Keys that would make an agent bill an API account instead of the learner's plan. Removed for the spike runs. */
const CREDENTIAL_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"];

export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !CREDENTIAL_ENV.includes(k)));
}

/** Signed in with a subscription, so turns use the learner's plan. An API-key sign-in counts as not signed in. */
export function signedIn(agent: Agent, status: { exit: number; output: string }): boolean {
  if (agent === "claude") {
    try {
      const s = JSON.parse(status.output);
      return s.loggedIn === true && s.authMethod === "claude.ai";
    } catch {
      return false;
    }
  }
  if (agent === "codex") return status.exit === 0 && /logged in using chatgpt/i.test(status.output);
  // Cursor's status doesn't say how it signed in; unverified while it is signed out here.
  return status.exit === 0 && !/not logged in/i.test(status.output) && /logged in/i.test(status.output);
}

// A JSON string literal is also a valid TOML basic string.
const toml = (s: string) => JSON.stringify(s);

const CLAUDE_WEB = ["WebSearch", "WebFetch"];

// Codex features that would give the agent a host shell or other integrations.
const CODEX_OFF = ["shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use", "multi_agent", "image_generation"];

export function turnArgs(agent: "claude" | "codex", turn: Turn): string[] {
  if (agent === "claude") {
    return [
      "-p", "--output-format", "stream-json", "--verbose",
      "--mcp-config", JSON.stringify({ mcpServers: { codemm: turn.mcp } }), "--strict-mcp-config", "--setting-sources", "",
      "--tools", turn.web ? CLAUDE_WEB.join(",") : "",
      "--allowedTools", [...turn.tools.map((t) => `mcp__codemm__${t}`), ...(turn.web ? CLAUDE_WEB : [])].join(","),
      ...(turn.model ? ["--model", turn.model] : []),
      ...(turn.resume ? ["--resume", turn.resume] : []),
    ];
  }
  const config = [
    'sandbox_mode="read-only"',
    `web_search="${turn.web ? "live" : "disabled"}"`,
    `mcp_servers.codemm.command=${toml(turn.mcp.command)}`,
    `mcp_servers.codemm.args=[${turn.mcp.args.map(toml).join(",")}]`,
    `mcp_servers.codemm.env={${Object.entries(turn.mcp.env).map(([k, v]) => `${k}=${toml(v)}`).join(",")}}`,
    `mcp_servers.codemm.enabled_tools=[${turn.tools.map(toml).join(",")}]`,
    'mcp_servers.codemm.default_tools_approval_mode="approve"',
  ];
  return [
    "exec", ...(turn.resume ? ["resume", turn.resume] : []), "--json", "--skip-git-repo-check", "--ignore-user-config",
    ...CODEX_OFF.flatMap((f) => ["--disable", f]),
    ...config.flatMap((c) => ["-c", c]),
    ...(turn.model ? ["-m", turn.model] : []),
    "-",
  ];
}
