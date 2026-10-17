import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanEnv, signedIn, turnArgs } from "./launch.ts";

const mcp = { command: "/Apps/Code mm/node", args: ["C:\\Program Files\\codemm\\cli.js", "mcp", "--workspace", "/w s"], env: { CODEMM_HOME: "/h" } };

test("cleanEnv drops credential variables and keeps the rest", () => {
  const env = cleanEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "a", ANTHROPIC_AUTH_TOKEN: "b", CLAUDE_CODE_OAUTH_TOKEN: "c", OPENAI_API_KEY: "d", CODEX_API_KEY: "e", CURSOR_API_KEY: "f" });
  assert.deepEqual(env, { PATH: "/bin" });
});

test("claude: headless stream-json turn with only Codemm's MCP server and allowed tools", () => {
  const args = turnArgs("claude", { mcp, tools: ["list_tracks", "progress"] });
  assert.deepEqual(args.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]!);
  assert.deepEqual(config, { mcpServers: { codemm: mcp } });
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--allowedTools") + 1], "mcp__codemm__list_tracks,mcp__codemm__progress");
  assert.ok(!args.includes("--resume"));
});

test("claude: resume and model are passed through", () => {
  const args = turnArgs("claude", { mcp, tools: [], resume: "abc", model: "haiku" });
  assert.equal(args[args.indexOf("--resume") + 1], "abc");
  assert.equal(args[args.indexOf("--model") + 1], "haiku");
});

test("codex: exec --json, read-only, Codemm's MCP server as TOML overrides, prompt from stdin", () => {
  const args = turnArgs("codex", { mcp, tools: ["list_tracks"] });
  assert.deepEqual(args.slice(0, 3), ["exec", "--json", "--skip-git-repo-check"]);
  const overrides = args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));
  assert.deepEqual(overrides, [
    'sandbox_mode="read-only"',
    'mcp_servers.codemm.command="/Apps/Code mm/node"',
    'mcp_servers.codemm.args=["C:\\\\Program Files\\\\codemm\\\\cli.js","mcp","--workspace","/w s"]',
    'mcp_servers.codemm.env={CODEMM_HOME="/h"}',
    'mcp_servers.codemm.enabled_tools=["list_tracks"]',
    'mcp_servers.codemm.default_tools_approval_mode="approve"',
  ]);
  assert.equal(args.at(-1), "-");
});

test("codex: resume puts the thread id right after exec resume", () => {
  const args = turnArgs("codex", { mcp, tools: [], resume: "t-1", model: "m" });
  assert.deepEqual(args.slice(0, 3), ["exec", "resume", "t-1"]);
  assert.equal(args[args.indexOf("-m") + 1], "m");
  assert.equal(args.at(-1), "-");
});

test("signedIn reads only the status the agent reports", () => {
  assert.equal(signedIn("claude", { exit: 0, output: JSON.stringify({ loggedIn: true, email: "x" }) }), true);
  assert.equal(signedIn("claude", { exit: 1, output: JSON.stringify({ loggedIn: false }) }), false);
  assert.equal(signedIn("claude", { exit: 0, output: "not json" }), false);
  assert.equal(signedIn("codex", { exit: 0, output: "Logged in using ChatGPT\n" }), true);
  assert.equal(signedIn("codex", { exit: 1, output: "Not logged in\n" }), false);
  assert.equal(signedIn("cursor", { exit: 0, output: "Checking authentication status...\n Not logged in\n" }), false);
  assert.equal(signedIn("cursor", { exit: 0, output: "Logged in as someone\n" }), true);
});
