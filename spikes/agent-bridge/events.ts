/**
 * Turns an agent CLI's JSON-lines stream into the few events the app needs. Allowlist only:
 * - `session`: the id used to resume;
 * - `text`: top-level assistant text, only when `text` is on (tutor turns; author turns turn it off);
 * - `tool`: a Codemm tool's name and status, never its input or result;
 * - `web`: https URLs a successful web search or fetch returned, only when `web` is on (research turns);
 * - `done`: whether the turn succeeded. Error text is never passed on, because it can quote anything.
 * Thinking, subagent messages, other tools and malformed lines are dropped; the parser never throws.
 */

export type BridgeEvent =
  | { kind: "session"; id: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string; state: "started" | "ok" | "failed" }
  | { kind: "web"; urls: string[] }
  | { kind: "done"; ok: boolean };

export type ParserOptions = { text: boolean; web: boolean };

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
  // Calls by id: Codemm tools by name, and web calls with the URL a fetch asked for.
  const codemm = new Map<string, string>();
  const searches = new Set<string>();
  const fetches = new Map<string, string>();
  return (e) => {
    const id = str(e.session_id);
    if (e.type === "system" && e.subtype === "init") return id ? [{ kind: "session", id }] : [];
    if (e.type === "result") return [{ kind: "done", ok: e.subtype === "success" && e.is_error !== true }];
    if ((e.type !== "assistant" && e.type !== "user") || e.parent_tool_use_id) return [];
    const out: BridgeEvent[] = [];
    for (const block of arr(obj(e.message)?.content).map(obj)) {
      if (!block) continue;
      const name = str(block.name);
      const callId = str(block.id);
      if (e.type === "assistant" && block.type === "text" && str(block.text)) out.push({ kind: "text", text: block.text as string });
      if (e.type === "assistant" && block.type === "tool_use" && callId) {
        if (name?.startsWith(CLAUDE_PREFIX)) {
          codemm.set(callId, name.slice(CLAUDE_PREFIX.length));
          out.push({ kind: "tool", tool: name.slice(CLAUDE_PREFIX.length), state: "started" });
        }
        if (name === "WebSearch") searches.add(callId);
        const url = https([obj(block.input)?.url])[0];
        if (name === "WebFetch" && url) fetches.set(callId, url);
      }
      if (e.type !== "user" || block.type !== "tool_result") continue;
      const resultId = str(block.tool_use_id) ?? "";
      const failed = block.is_error === true;
      const tool = codemm.get(resultId);
      if (tool) out.push({ kind: "tool", tool, state: failed ? "failed" : "ok" });
      if (failed) continue;
      // A search's links arrive as structured data beside its tool result.
      if (searches.has(resultId)) out.push(...web(https(arr(obj(e.tool_use_result)?.results).flatMap((r) => arr(obj(r)?.content).map((c) => obj(c)?.url)))));
      if (fetches.has(resultId)) out.push(...web([fetches.get(resultId)!]));
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
export function createParser(agent: "claude" | "codex", options: ParserOptions): (line: string) => BridgeEvent[] {
  const parse = agent === "claude" ? claudeParser() : codexParser();
  return (line) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return [];
    }
    const e = obj(value);
    return (e ? parse(e) : []).filter((ev) => (ev.kind !== "text" || options.text) && (ev.kind !== "web" || options.web));
  };
}
