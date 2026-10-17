import { describe, expect, it } from "vitest";
import { parseClaude } from "../lib/claude.ts";
import { parseCodex } from "../lib/codex.ts";

const lines = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n");

describe("parseClaude", () => {
  const stream = lines(
    { type: "system", subtype: "init" },
    { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Setting up." }, { type: "tool_use", id: "t1", name: "mcp__codemm__progress", input: {} }] } },
    { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "No course" }], is_error: true }] } },
    { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t2", name: "Task", input: { prompt: "author c.loops" } }] } },
    { type: "assistant", parent_tool_use_id: "t2", message: { content: [{ type: "text", text: "secret thinking" }, { type: "tool_use", id: "t3", name: "mcp__codemm__save_exercise", input: { files: { a: "b" } } }] } },
    { type: "user", parent_tool_use_id: "t2", message: { content: [{ type: "tool_result", tool_use_id: "t3", content: "{\"exercise\":\"sum\"}" }] } },
    { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "sum" }] }] } },
    { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t4", name: "Edit", input: { file_path: "/ws/exercises/c/sum/main.c" } }, { type: "tool_use", id: "t5", name: "Bash", input: { command: "docker ps" } }] } },
    { type: "result", subtype: "success", is_error: false, result: "Here is your exercise.", num_turns: 7, total_cost_usd: 0.42, permission_denials: [{ tool_name: "Bash" }], modelUsage: { "claude-haiku-4-5": {} }, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } },
  );

  it("reads tools (with subagent calls marked), results, cost, turns and denials", () => {
    const run = parseClaude(`warning: banner\n${stream}`);
    expect(run.ok).toBe(true);
    expect(run.turns).toBe(7);
    expect(run.costUsd).toBe(0.42);
    expect(run.denials).toBe(1);
    expect(run.models).toEqual(["claude-haiku-4-5"]);
    expect(run.tokens).toEqual({ input: 100, output: 5 });
    expect(run.finalText).toBe("Here is your exercise.");
    expect(run.tools.map((t) => [t.kind, t.name, t.input, t.sub, t.isError])).toEqual([
      ["codemm", "codemm.progress", "{}", false, true],
      ["agent", "Task", "author c.loops", false, false],
      ["codemm", "codemm.save_exercise", '{"files":{"a":"b"}}', true, false],
      ["edit", "Edit", "/ws/exercises/c/sum/main.c", false, undefined],
      ["shell", "Bash", "docker ps", false, undefined],
    ]);
  });

  it("exposes what the tutor said and what subagents returned, not the subagent's own text", () => {
    const run = parseClaude(stream);
    expect(run.exposedText).toContain("Setting up.");
    expect(run.exposedText).toContain("sum");
    expect(run.exposedText).toContain("Here is your exercise.");
    expect(run.exposedText).not.toContain("secret thinking");
  });

  it("doesn't repeat the final text when the result event echoes the last message", () => {
    const run = parseClaude(lines({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Bye." }] } }, { type: "result", subtype: "success", result: "Bye." }));
    expect(run.exposedText).toBe("Bye.");
  });

  it("counts permission refusals the result event leaves out", () => {
    const run = parseClaude(
      lines(
        { type: "assistant", parent_tool_use_id: "t9", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "node -e x" } }, { type: "tool_use", id: "b2", name: "Bash", input: { command: "ls" } }] } },
        { type: "user", parent_tool_use_id: "t9", message: { content: [{ type: "tool_result", tool_use_id: "b1", is_error: true, content: "This command requires approval" }, { type: "tool_result", tool_use_id: "b2", is_error: true, content: "ls: no such file" }] } },
        { type: "result", subtype: "success", result: "ok", permission_denials: [] },
      ),
    );
    expect(run.denials).toBe(1);
  });

  it("flags a Codemm server that failed to start", () => {
    const failed = lines({ type: "system", subtype: "init", mcp_servers: [{ name: "codemm", status: "failed" }] }, { type: "result", subtype: "success", result: "ok" });
    expect(parseClaude(failed).serverFailed).toBe(true);
    expect(parseClaude(lines({ type: "system", subtype: "init", mcp_servers: [{ name: "codemm", status: "connected" }] })).serverFailed).toBe(false);
  });

  it("reports a run without a result event as failed", () => {
    expect(parseClaude(lines({ type: "system", subtype: "init" }))).toMatchObject({ ok: false, error: "no result event" });
    expect(parseClaude(lines({ type: "result", subtype: "error_max_turns", is_error: true }))).toMatchObject({ ok: false, error: "error_max_turns" });
  });
});

describe("parseCodex", () => {
  it("reads MCP calls, commands, file changes, messages and usage", () => {
    const run = parseCodex(
      `Reading additional input from stdin...\n${lines(
        { type: "thread.started", thread_id: "x" },
        { type: "turn.started" },
        { type: "item.completed", item: { type: "agent_message", text: "Looking." } },
        { type: "item.started", item: { type: "mcp_tool_call", server: "codemm", tool: "progress", arguments: {}, status: "in_progress" } },
        { type: "item.completed", item: { type: "mcp_tool_call", server: "codemm", tool: "progress", arguments: {}, result: { content: [{ type: "text", text: "No course" }] }, error: null, status: "failed" } },
        { type: "item.completed", item: { type: "command_execution", command: "cat ~/.codemm/x", aggregated_output: "nope", exit_code: 1, status: "failed" } },
        { type: "item.completed", item: { type: "file_change", changes: [{ path: "/ws/exercises/c/sum/main.c", kind: "update" }], status: "completed" } },
        { type: "item.completed", item: { type: "agent_message", text: "Done: sum" } },
        { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 7, reasoning_output_tokens: 3 } },
      )}`,
    );
    expect(run).toMatchObject({ ok: true, turns: 1, finalText: "Done: sum", tokens: { input: 100, output: 10 } });
    expect(run.exposedText).toBe("Looking.\nDone: sum");
    expect(run.tools.map((t) => [t.kind, t.name, t.input, t.isError])).toEqual([
      ["codemm", "codemm.progress", "{}", true],
      ["shell", "shell", "cat ~/.codemm/x", true],
      ["edit", "file_change:update", "/ws/exercises/c/sum/main.c", false],
    ]);
  });

  it("reports a failed turn", () => {
    expect(parseCodex(lines({ type: "turn.started" }, { type: "turn.failed", error: { message: "usage limit" } }))).toMatchObject({ ok: false, error: "usage limit" });
  });
});
