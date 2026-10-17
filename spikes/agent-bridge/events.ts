/**
 * Turns an agent CLI's JSON-lines stream into the few events the app needs. Allowlist only:
 * - `session`: the id used to resume;
 * - `text`: top-level assistant text, only in turns that show text (author turns pass `text: false`);
 * - `tool`: a Codemm tool's name and status, never its input or result;
 * - `web`: the https URLs a web search or fetch returned, the evidence behind research sources;
 * - `done`: whether the turn succeeded. Error text is never passed on, because it can quote anything.
 * Thinking, subagent messages, other tools and malformed lines are dropped; the parser never throws.
 */

export type BridgeEvent =
  | { kind: "session"; id: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string; state: "started" | "ok" | "failed" }
  | { kind: "web"; urls: string[] }
  | { kind: "done"; ok: boolean };

type Json = Record<string, unknown>;

const CLAUDE_PREFIX = "mcp__codemm__";

const obj = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

function https(urls: unknown[]): string[] {
  return urls.flatMap((u) => {
    const s = str(u);
    if (!s) return [];
    try {
      return new URL(s).protocol === "https:" ? [s] : [];
    } catch {
      return [];
    }
  });
}

const web = (urls: string[]): BridgeEvent[] => (urls.length > 0 ? [{ kind: "web", urls }] : []);

function claudeParser(): (e: Json) => BridgeEvent[] {
  const names = new Map<string, string>();
  return (e) => {
    const id = str(e.session_id);
    if (e.type === "system" && e.subtype === "init") return id ? [{ kind: "session", id }] : [];
    if (e.type === "result") return [{ kind: "done", ok: e.subtype === "success" && e.is_error !== true }];
    if ((e.type !== "assistant" && e.type !== "user") || e.parent_tool_use_id) return [];
    const out: BridgeEvent[] = [];
    if (e.type === "user") {
      // Web search results arrive as structured data beside the tool result.
      const found = arr(obj(e.tool_use_result)?.results).flatMap((r) => arr(obj(r)?.content).map((c) => obj(c)?.url));
      out.push(...web(https(found)));
    }
    for (const block of arr(obj(e.message)?.content).map(obj)) {
      if (!block) continue;
      const name = str(block.name);
      if (e.type === "assistant" && block.type === "text" && str(block.text)) out.push({ kind: "text", text: block.text as string });
      if (e.type === "assistant" && block.type === "tool_use" && name?.startsWith(CLAUDE_PREFIX) && str(block.id)) {
        const tool = name.slice(CLAUDE_PREFIX.length);
        names.set(block.id as string, tool);
        out.push({ kind: "tool", tool, state: "started" });
      }
      if (e.type === "assistant" && block.type === "tool_use" && name === "WebFetch") out.push(...web(https([obj(block.input)?.url])));
      const tool = names.get(str(block.tool_use_id) ?? "");
      if (e.type === "user" && block.type === "tool_result" && tool) out.push({ kind: "tool", tool, state: block.is_error === true ? "failed" : "ok" });
    }
    return out;
  };
}

function codexParser(): (e: Json) => BridgeEvent[] {
  return (e) => {
    const id = str(e.thread_id);
    if (e.type === "thread.started") return id ? [{ kind: "session", id }] : [];
    if (e.type === "turn.completed") return [{ kind: "done", ok: true }];
    if (e.type === "turn.failed") return [{ kind: "done", ok: false }];
    const item = obj(e.item);
    if (!item || (e.type !== "item.started" && e.type !== "item.completed")) return [];
    const done = e.type === "item.completed";
    if (item.type === "agent_message" && done && str(item.text)) return [{ kind: "text", text: item.text as string }];
    if (item.type === "web_search" && done) return web(https(arr(item.results).map((r) => obj(r)?.url)));
    const tool = str(item.tool);
    if (item.type === "mcp_tool_call" && item.server === "codemm" && tool) {
      return [{ kind: "tool", tool, state: !done ? "started" : item.status === "completed" && !item.error ? "ok" : "failed" }];
    }
    return [];
  };
}

/** One parser per turn: Claude pairs tool results with earlier tool calls. */
export function createParser(agent: "claude" | "codex", options: { text: boolean }): (line: string) => BridgeEvent[] {
  const parse = agent === "claude" ? claudeParser() : codexParser();
  return (line) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return [];
    }
    const e = obj(value);
    const events = e ? parse(e) : [];
    return options.text ? events : events.filter((ev) => ev.kind !== "text");
  };
}
