/**
 * How to start each agent CLI headless with Codemm's MCP server, and how to read its sign-in status.
 * Pure: builds argument arrays only. The prompt always goes on stdin, which avoids option parsing
 * surprises and the Windows command-line length limit.
 */

export type Agent = "claude" | "codex" | "cursor";
export type McpServer = { command: string; args: string[]; env: Record<string, string> };
export type Turn = { mcp: McpServer; tools: string[]; resume?: string; model?: string };

export const BINARY: Record<Agent, string> = { claude: "claude", codex: "codex", cursor: "cursor-agent" };

/** Asks the agent itself; Codemm never opens its credential files or keychain entries. */
export const STATUS_ARGS: Record<Agent, string[]> = { claude: ["auth", "status"], codex: ["login", "status"], cursor: ["status"] };

/** Keys that would make an agent bill an API account instead of the learner's plan. Removed for the spike runs. */
const CREDENTIAL_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"];

export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !CREDENTIAL_ENV.includes(k)));
}

export function signedIn(agent: Agent, status: { exit: number; output: string }): boolean {
  if (agent === "claude") {
    try {
      return JSON.parse(status.output).loggedIn === true;
    } catch {
      return false;
    }
  }
  if (/not logged in/i.test(status.output)) return false;
  return status.exit === 0 && /logged in/i.test(status.output);
}

// A JSON string literal is also a valid TOML basic string.
const toml = (s: string) => JSON.stringify(s);

export function turnArgs(agent: "claude" | "codex", turn: Turn): string[] {
  if (agent === "claude") {
    return [
      "-p", "--output-format", "stream-json", "--verbose",
      "--mcp-config", JSON.stringify({ mcpServers: { codemm: turn.mcp } }), "--strict-mcp-config",
      "--allowedTools", turn.tools.map((t) => `mcp__codemm__${t}`).join(","),
      ...(turn.model ? ["--model", turn.model] : []),
      ...(turn.resume ? ["--resume", turn.resume] : []),
    ];
  }
  const config = [
    'sandbox_mode="read-only"',
    `mcp_servers.codemm.command=${toml(turn.mcp.command)}`,
    `mcp_servers.codemm.args=[${turn.mcp.args.map(toml).join(",")}]`,
    `mcp_servers.codemm.env={${Object.entries(turn.mcp.env).map(([k, v]) => `${k}=${toml(v)}`).join(",")}}`,
    `mcp_servers.codemm.enabled_tools=[${turn.tools.map(toml).join(",")}]`,
    'mcp_servers.codemm.default_tools_approval_mode="approve"',
  ];
  return [
    "exec", ...(turn.resume ? ["resume", turn.resume] : []), "--json", "--skip-git-repo-check",
    ...config.flatMap((c) => ["-c", c]),
    ...(turn.model ? ["-m", turn.model] : []),
    "-",
  ];
}
