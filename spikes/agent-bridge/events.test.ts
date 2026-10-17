import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type BridgeEvent, createParser } from "./events.ts";

const replay = (agent: "claude" | "codex", fixture: string): BridgeEvent[] => {
  const parse = createParser(agent);
  return readFileSync(new URL(`fixtures/${fixture}`, import.meta.url), "utf8").split("\n").filter(Boolean).flatMap(parse);
};

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
  const parse = createParser("claude");
  parse(JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "mcp__codemm__check", input: {} }] } }));
  const events = parse(JSON.stringify({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "No course" }] } }));
  assert.deepEqual(events, [{ kind: "tool", tool: "check", state: "failed" }]);
});

test("claude: subagent messages never reach the learner", () => {
  const parse = createParser("claude");
  const line = { type: "assistant", parent_tool_use_id: "toolu_task", message: { content: [{ type: "text", text: "the solution is CANARY" }] } };
  assert.deepEqual(parse(JSON.stringify(line)), []);
});

test("claude: tool inputs and results never reach the learner", () => {
  const parse = createParser("claude");
  const use = { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t2", name: "mcp__codemm__save_exercise", input: { files: { "solution/main.py": "CANARY" } } }] } };
  const result = { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "CANARY" }] }] } };
  const events = [...parse(JSON.stringify(use)), ...parse(JSON.stringify(result))];
  assert.equal(events.length, 2);
  assert.ok(!JSON.stringify(events).includes("CANARY"));
});

test("claude: other tools are not reported", () => {
  const parse = createParser("claude");
  const use = { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t3", name: "WebSearch", input: { query: "q" } }] } };
  assert.deepEqual(parse(JSON.stringify(use)), []);
});

test("claude: an error result ends the turn as failed", () => {
  const parse = createParser("claude");
  const events = parse(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" }));
  assert.deepEqual(events, [{ kind: "done", ok: false, error: "boom" }]);
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

test("codex: a rejected model fails the turn and warnings are ignored", () => {
  const events = replay("codex", "codex-model-rejected.jsonl");
  assert.deepEqual(events[0], { kind: "session", id: "01a14a21-f6a2-74c1-8a31-c2fd5d30482e" });
  assert.equal(events.length, 2);
  const done = events[1]!;
  assert.equal(done.kind, "done");
  assert.ok(done.kind === "done" && !done.ok && done.error?.includes("not supported"));
});

test("codex: tool arguments and results never reach the learner", () => {
  const parse = createParser("codex");
  const item = { id: "i", type: "mcp_tool_call", server: "codemm", tool: "save_exercise", arguments: { files: { "solution/a": "CANARY" } }, result: { content: [{ type: "text", text: "CANARY" }] }, status: "completed" };
  const events = parse(JSON.stringify({ type: "item.completed", item }));
  assert.deepEqual(events, [{ kind: "tool", tool: "save_exercise", state: "ok" }]);
});

test("codex: other servers' tools are not reported", () => {
  const parse = createParser("codex");
  const item = { id: "i", type: "mcp_tool_call", server: "other", tool: "x", arguments: {}, status: "completed" };
  assert.deepEqual(parse(JSON.stringify({ type: "item.completed", item })), []);
});

test("both: lines that are not JSON are ignored", () => {
  assert.deepEqual(createParser("claude")("Reading additional input from stdin..."), []);
  assert.deepEqual(createParser("codex")(""), []);
});
