import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { agents } from "./agents.mjs";

const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8").split("\n");
const parseAll = (agent, lines) => lines.flatMap((line) => agents[agent].parse(line));

const server = { command: "/abs/node", args: ["/abs/cli.js", "mcp", "--workspace", "/ws"], env: { CODEMM_HOME: "/home" } };

test("claude: a recorded run becomes session, tool, text and done events", () => {
  assert.deepEqual(parseAll("claude", fixture("claude-list-tracks.jsonl")), [
    { type: "session", id: "f242da1d-dc70-4d6f-96da-1f92ecc2d720" },
    { type: "tool_call", id: "toolu_01MvSVPGD77trQgd9hUqhwG3", name: "ToolSearch" },
    { type: "tool_result", id: "toolu_01MvSVPGD77trQgd9hUqhwG3", error: false },
    { type: "tool_call", id: "toolu_01NfoeX7ahYrG2GZ1kmsnnnP", name: "codemm.list_tracks" },
    { type: "tool_result", id: "toolu_01NfoeX7ahYrG2GZ1kmsnnnP", error: false },
    { type: "text", text: "0" },
    { type: "done", ok: true },
  ]);
});

test("claude: a failed result is done with ok false", () => {
  const line = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" });
  assert.deepEqual(agents.claude.parse(line), [{ type: "done", ok: false, error: "boom" }]);
});

test("codex: a recorded run becomes session, tool, text and done events", () => {
  assert.deepEqual(parseAll("codex", fixture("codex-list-tracks.jsonl")), [
    { type: "session", id: "01a14a25-cfba-7b41-a5d4-d7f42843ba87" },
    { type: "text", text: "I’ll locate the available Codemm tool and call `list_tracks` exactly once." },
    { type: "tool_call", id: "item_1", name: "codemm.list_tracks" },
    { type: "tool_result", id: "item_1", error: false },
    { type: "text", text: "0" },
    { type: "done", ok: true },
  ]);
});

test("codex: a rejected model ends with ok false and the agent's message; warnings are ignored", () => {
  const events = parseAll("codex", fixture("codex-model-rejected.jsonl"));
  assert.equal(events.length, 2);
  assert.equal(events[1].type, "done");
  assert.equal(events[1].ok, false);
  assert.match(events[1].error, /not supported when using Codex with a ChatGPT account/);
});

test("parsers ignore blank, non-JSON and unknown lines", () => {
  for (const agent of ["claude", "codex"]) {
    for (const line of ["", "Reading additional input from stdin...", "{\"type\":\"rate_limit_event\"}", "[1,2]", "null"]) {
      assert.deepEqual(agents[agent].parse(line), [], `${agent}: ${line}`);
    }
  }
});

test("claude: launch passes the prompt, stream-json, the codemm server only and the allowed tools", () => {
  const { command, args } = agents.claude.launch({ prompt: "hi", server, tools: ["list_tracks", "progress"], model: "haiku" });
  assert.equal(command, "claude");
  assert.deepEqual(args.slice(0, 5), ["-p", "hi", "--output-format", "stream-json", "--verbose"]);
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  assert.deepEqual(config, { mcpServers: { codemm: server } });
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--allowedTools") + 1], "mcp__codemm__list_tracks,mcp__codemm__progress");
  assert.equal(args[args.indexOf("--model") + 1], "haiku");
  assert.ok(!args.includes("--resume"));
});

test("claude: resume adds the session id", () => {
  const { args } = agents.claude.launch({ prompt: "again", server, tools: [], resume: "abc" });
  assert.equal(args[args.indexOf("--resume") + 1], "abc");
  assert.ok(!args.includes("--allowedTools"));
});

test("codex: launch runs exec --json read-only with the codemm server as TOML overrides", () => {
  const { command, args } = agents.codex.launch({ prompt: "hi", server, model: "gpt-6-luna" });
  assert.equal(command, "codex");
  assert.deepEqual(args.slice(0, 3), ["exec", "--json", "--skip-git-repo-check"]);
  const overrides = args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));
  assert.deepEqual(overrides, [
    'sandbox_mode="read-only"',
    'mcp_servers.codemm.command="/abs/node"',
    'mcp_servers.codemm.args=["/abs/cli.js","mcp","--workspace","/ws"]',
    'mcp_servers.codemm.env={CODEMM_HOME="/home"}',
    'mcp_servers.codemm.default_tools_approval_mode="approve"',
  ]);
  assert.equal(args[args.indexOf("-m") + 1], "gpt-6-luna");
  assert.equal(args.at(-1), "hi");
});

test("codex: resume uses exec resume with the thread id before the prompt", () => {
  const { args } = agents.codex.launch({ prompt: "again", server, resume: "t1" });
  assert.deepEqual(args.slice(0, 2), ["exec", "resume"]);
  assert.deepEqual(args.slice(-2), ["t1", "again"]);
});

test("sign-in: each agent's own status command is read for a yes or no only", () => {
  assert.deepEqual(agents.claude.signIn.args, ["auth", "status", "--json"]);
  assert.equal(agents.claude.signIn.read({ code: 0, output: '{"loggedIn":true,"email":"x@y"}' }), true);
  assert.equal(agents.claude.signIn.read({ code: 1, output: '{"loggedIn":false}' }), false);
  assert.equal(agents.claude.signIn.read({ code: 0, output: "not json" }), false);

  assert.deepEqual(agents.codex.signIn.args, ["login", "status"]);
  assert.equal(agents.codex.signIn.read({ code: 0, output: "Logged in using ChatGPT\n" }), true);
  assert.equal(agents.codex.signIn.read({ code: 1, output: "Not logged in\n" }), false);

  assert.deepEqual(agents.cursor.signIn.args, ["status"]);
  assert.equal(agents.cursor.signIn.read({ code: 0, output: "\u001b[2K Not logged in\n" }), false);
  assert.equal(agents.cursor.signIn.read({ code: 0, output: "Logged in as someone\n" }), true);
});
