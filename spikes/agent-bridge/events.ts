/**
 * Turns an agent CLI's JSON-lines stream into the few events the Codemm panel needs.
 * Allowlist only: top-level assistant text, Codemm tool names with a status, the session id, and the end.
 * Tool inputs and results, thinking, subagent messages and other tools are dropped, so nothing an author wrote
 * (solutions, mutants, hidden tests) can reach the learner through this stream.
 */

export type BridgeEvent =
  | { kind: "session"; id: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string; state: "started" | "ok" | "failed" }
  | { kind: "done"; ok: boolean; error?: string };

type Json = Record<string, any>;

const CLAUDE_PREFIX = "mcp__codemm__";

function json(line: string): Json | undefined {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

function claudeParser(): (e: Json) => BridgeEvent[] {
  const names = new Map<string, string>();
  return (e) => {
    if (e.type === "system" && e.subtype === "init") return [{ kind: "session", id: String(e.session_id) }];
    if (e.type === "result") return [e.is_error || e.subtype !== "success" ? { kind: "done", ok: false, error: String(e.result ?? e.subtype) } : { kind: "done", ok: true }];
    if ((e.type !== "assistant" && e.type !== "user") || e.parent_tool_use_id) return [];
    const out: BridgeEvent[] = [];
    for (const block of e.message?.content ?? []) {
      if (e.type === "assistant" && block.type === "text" && block.text) out.push({ kind: "text", text: block.text });
      if (e.type === "assistant" && block.type === "tool_use" && String(block.name).startsWith(CLAUDE_PREFIX)) {
        const tool = block.name.slice(CLAUDE_PREFIX.length);
        names.set(block.id, tool);
        out.push({ kind: "tool", tool, state: "started" });
      }
      if (e.type === "user" && block.type === "tool_result" && names.has(block.tool_use_id)) {
        out.push({ kind: "tool", tool: names.get(block.tool_use_id)!, state: block.is_error ? "failed" : "ok" });
      }
    }
    return out;
  };
}

function codexParser(): (e: Json) => BridgeEvent[] {
  let error: string | undefined;
  return (e) => {
    if (e.type === "thread.started") return [{ kind: "session", id: String(e.thread_id) }];
    if (e.type === "error") error = String(e.message);
    if (e.type === "turn.completed") return [{ kind: "done", ok: true }];
    if (e.type === "turn.failed") return [{ kind: "done", ok: false, error: String(e.error?.message ?? error ?? "turn failed") }];
    const item = e.item;
    if (!item || (e.type !== "item.started" && e.type !== "item.completed")) return [];
    if (item.type === "agent_message" && e.type === "item.completed" && item.text) return [{ kind: "text", text: item.text }];
    if (item.type === "mcp_tool_call" && item.server === "codemm") {
      const state = e.type === "item.started" ? "started" : item.status === "completed" && !item.error ? "ok" : "failed";
      return [{ kind: "tool", tool: String(item.tool), state }];
    }
    return [];
  };
}

/** One parser per turn: Claude pairs tool results with earlier tool calls. */
export function createParser(agent: "claude" | "codex"): (line: string) => BridgeEvent[] {
  const parse = agent === "claude" ? claudeParser() : codexParser();
  return (line) => {
    const e = json(line);
    return e ? parse(e) : [];
  };
}
