import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type BridgeEvent, createParser } from "./events.ts";

type Agent = "claude" | "codex";

const lines = (fixture: string) => readFileSync(new URL(`fixtures/${fixture}`, import.meta.url), "utf8").split("\n").filter(Boolean);
const replay = (agent: Agent, fixture: string, text = true): BridgeEvent[] => lines(fixture).flatMap(createParser(agent, { text }));
const feed = (agent: Agent, events: object[], text = true) => events.map((e) => JSON.stringify(e)).flatMap(createParser(agent, { text }));

test("claude: a recorded Codemm tool call becomes session, tool, text and done events", () => {
  assert.deepEqual(replay("claude", "claude-tool-call.jsonl"), [
    { kind: "session", id: "3ad82449-90d9-489c-bd55-a2301df878db" },
    { kind: "tool", tool: "list_tracks", state: "started" },
    { kind: "tool", tool: "list_tracks", state: "ok" },
    { kind: "text", text: "0" },
    { kind: "done", ok: true },
  ]);
});

test("claude: a failed Codemm tool result is reported as failed", () => {
  const events = feed("claude", [
    { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "mcp__codemm__check", input: {} }] } },
    { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "No course" }] } },
  ]);
  assert.deepEqual(events, [{ kind: "tool", tool: "check", state: "started" }, { kind: "tool", tool: "check", state: "failed" }]);
});

test("claude: subagent messages never reach the learner", () => {
  const line = { type: "assistant", parent_tool_use_id: "toolu_task", message: { content: [{ type: "text", text: "the solution is CANARY" }] } };
  assert.deepEqual(feed("claude", [line]), []);
});

test("claude: tool inputs and results never reach the learner", () => {
  const events = feed("claude", [
    { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t2", name: "mcp__codemm__save_exercise", input: { files: { "solution/main.py": "CANARY" } } }] } },
    { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "CANARY" }] }] } },
  ]);
  assert.equal(events.length, 2);
  assert.ok(!JSON.stringify(events).includes("CANARY"));
});

test("claude: other tools are not reported", () => {
  const use = { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "ls" } }] } };
  assert.deepEqual(feed("claude", [use]), []);
});

test("claude: a failed turn reports no error text, which could carry anything", () => {
  assert.deepEqual(feed("claude", [{ type: "result", subtype: "error_during_execution", is_error: true, result: "CANARY" }]), [{ kind: "done", ok: false }]);
});

test("claude: recorded web search results become web evidence", () => {
  const web = replay("claude", "claude-web-search.jsonl").filter((e) => e.kind === "web");
  assert.deepEqual(web, [{ kind: "web", urls: ["https://lynxjs.org/next/api/react/Function.useState", "https://react.dev/reference/react/useState.md"] }]);
});

test("claude: a web fetch is evidence of its URL", () => {
  const use = { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t4", name: "WebFetch", input: { url: "https://react.dev/learn", prompt: "p" } }] } };
  assert.deepEqual(feed("claude", [use]), [{ kind: "web", urls: ["https://react.dev/learn"] }]);
});

test("codex: a blocked MCP call is failed even when the model still answers", () => {
  assert.deepEqual(replay("codex", "codex-approval-blocked.jsonl"), [
    { kind: "session", id: "01a14a22-3f70-75e1-b5b4-805b61957090" },
    { kind: "tool", tool: "list_tracks", state: "started" },
    { kind: "tool", tool: "list_tracks", state: "failed" },
    { kind: "text", text: "0" },
    { kind: "done", ok: true },
  ]);
});

test("codex: a rejected model fails the turn without passing on its message", () => {
  assert.deepEqual(replay("codex", "codex-model-rejected.jsonl"), [
    { kind: "session", id: "01a14a21-f6a2-74c1-8a31-c2fd5d30482e" },
    { kind: "done", ok: false },
  ]);
});

test("codex: recorded web search results become web evidence", () => {
  const web = replay("codex", "codex-web-search.jsonl").filter((e) => e.kind === "web");
  assert.deepEqual(web, [{ kind: "web", urls: ["https://uk.react.dev/reference/react/useState", "https://react.dev/reference/rules/components-and-hooks-must-be-pure"] }]);
});

test("codex: tool arguments and results never reach the learner", () => {
  const item = { id: "i", type: "mcp_tool_call", server: "codemm", tool: "save_exercise", arguments: { files: { "solution/a": "CANARY" } }, result: { content: [{ type: "text", text: "CANARY" }] }, status: "completed" };
  assert.deepEqual(feed("codex", [{ type: "item.completed", item }]), [{ kind: "tool", tool: "save_exercise", state: "ok" }]);
});

test("codex: other servers' tools are not reported", () => {
  const item = { id: "i", type: "mcp_tool_call", server: "other", tool: "x", arguments: {}, status: "completed" };
  assert.deepEqual(feed("codex", [{ type: "item.completed", item }]), []);
});

test("author turns: no agent text is passed on, only tools and the end", () => {
  for (const [agent, fixture] of [["claude", "claude-tool-call.jsonl"], ["codex", "codex-approval-blocked.jsonl"]] as const) {
    const events = replay(agent, fixture, false);
    assert.ok(events.length > 0);
    assert.ok(events.every((e) => e.kind !== "text"));
  }
});

test("malformed lines are ignored, never thrown and never passed on", () => {
  const bad = [
    "Reading additional input from stdin...",
    "",
    "null",
    "[1,2]",
    '{"type":"assistant","parent_tool_use_id":null,"message":{"content":[null]}}',
    '{"type":"assistant","parent_tool_use_id":null,"message":{"content":{}}}',
    '{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":5}]}}',
    '{"type":"user","parent_tool_use_id":null,"tool_use_result":{"results":[null,{"content":[{"url":"javascript:alert(1)"}]}]}}',
    '{"type":"system","subtype":"init","session_id":7}',
  ];
  assert.deepEqual(bad.flatMap(createParser("claude", { text: true })), []);
  const codex = ['{"type":"item.completed","item":null}', '{"type":"item.completed","item":{"type":"agent_message","text":["x"]}}', '{"type":"item.completed","item":{"type":"web_search","results":"x"}}'];
  assert.deepEqual(codex.flatMap(createParser("codex", { text: true })), []);
});
