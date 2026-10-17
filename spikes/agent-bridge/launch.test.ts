import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanEnv, signedIn, turnArgs } from "./launch.ts";

const mcp = { command: "/Apps/Code mm/node", args: ["C:\\Program Files\\codemm\\cli.js", "mcp", "--workspace", "/w s"], env: { CODEMM_HOME: "/h" } };
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const overrides = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));
const disabled = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === "--disable" ? [a] : []));

test("cleanEnv drops credential variables and keeps the rest", () => {
  const env = cleanEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "a", ANTHROPIC_AUTH_TOKEN: "b", CLAUDE_CODE_OAUTH_TOKEN: "c", OPENAI_API_KEY: "d", CODEX_API_KEY: "e", CURSOR_API_KEY: "f" });
  assert.deepEqual(env, { PATH: "/bin" });
});

test("claude: headless stream-json, only Codemm's MCP server, no built-in tools, Codemm tools allowed", () => {
  const args = turnArgs("claude", { mcp, tools: ["list_tracks", "progress"] });
  assert.deepEqual(args.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
  assert.deepEqual(JSON.parse(after(args, "--mcp-config")!), { mcpServers: { codemm: mcp } });
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(after(args, "--tools"), "");
  assert.equal(after(args, "--setting-sources"), "");
  assert.equal(after(args, "--allowedTools"), "mcp__codemm__list_tracks,mcp__codemm__progress");
  assert.ok(!args.includes("--resume"));
});

test("claude: a research turn also gets web search and fetch", () => {
  const args = turnArgs("claude", { mcp, tools: ["draft_roadmap"], web: true });
  assert.equal(after(args, "--tools"), "WebSearch,WebFetch");
  assert.equal(after(args, "--allowedTools"), "mcp__codemm__draft_roadmap,WebSearch,WebFetch");
});

test("claude: resume and model are passed through", () => {
  const args = turnArgs("claude", { mcp, tools: [], resume: "abc", model: "haiku" });
  assert.equal(after(args, "--resume"), "abc");
  assert.equal(after(args, "--model"), "haiku");
});

test("codex: exec --json without user config, shell or extras; Codemm's MCP server as TOML overrides; prompt from stdin", () => {
  const args = turnArgs("codex", { mcp, tools: ["list_tracks"] });
  assert.deepEqual(args.slice(0, 4), ["exec", "--json", "--skip-git-repo-check", "--ignore-user-config"]);
  assert.deepEqual(disabled(args), ["shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use", "multi_agent", "image_generation"]);
  assert.deepEqual(overrides(args), [
    'sandbox_mode="read-only"',
    'web_search="disabled"',
    'mcp_servers.codemm.command="/Apps/Code mm/node"',
    'mcp_servers.codemm.args=["C:\\\\Program Files\\\\codemm\\\\cli.js","mcp","--workspace","/w s"]',
    'mcp_servers.codemm.env={CODEMM_HOME="/h"}',
    'mcp_servers.codemm.enabled_tools=["list_tracks"]',
    'mcp_servers.codemm.default_tools_approval_mode="approve"',
  ]);
  assert.equal(args.at(-1), "-");
});

test("codex: a research turn turns on live web search", () => {
  assert.ok(overrides(turnArgs("codex", { mcp, tools: [], web: true })).includes('web_search="live"'));
});

test("codex: resume puts the thread id right after exec resume", () => {
  const args = turnArgs("codex", { mcp, tools: [], resume: "t-1", model: "m" });
  assert.deepEqual(args.slice(0, 3), ["exec", "resume", "t-1"]);
  assert.equal(after(args, "-m"), "m");
  assert.equal(args.at(-1), "-");
});

test("signedIn means signed in with a subscription, read only from the agent's own status", () => {
  assert.equal(signedIn("claude", { exit: 0, output: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "x" }) }), true);
  assert.equal(signedIn("claude", { exit: 0, output: JSON.stringify({ loggedIn: true, authMethod: "api_key" }) }), false);
  assert.equal(signedIn("claude", { exit: 1, output: JSON.stringify({ loggedIn: false }) }), false);
  assert.equal(signedIn("claude", { exit: 0, output: "not json" }), false);
  assert.equal(signedIn("codex", { exit: 0, output: "Logged in using ChatGPT\n" }), true);
  assert.equal(signedIn("codex", { exit: 0, output: "Logged in using an API key - sk-***\n" }), false);
  assert.equal(signedIn("codex", { exit: 1, output: "Not logged in\n" }), false);
  assert.equal(signedIn("cursor", { exit: 0, output: "Checking authentication status...\n Not logged in\n" }), false);
  assert.equal(signedIn("cursor", { exit: 0, output: "Logged in as someone\n" }), true);
});
