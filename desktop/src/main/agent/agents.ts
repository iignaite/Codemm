// What differs between agent CLIs (docs/desktop/DESIGN.md §3.1, proved in the
// agent-bridge spike): how to launch a headless turn with Codemm's MCP server,
// how to read its JSON stream as common events, and how to ask its version and
// whether the learner is signed in.
import type { AgentId } from '../../shared/api';

export type AgentEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string }
  /** A failed result keeps a little of its text, only to tell infrastructure failures apart (§6.1). */
  | { type: 'tool_result'; id: string; error: boolean; text?: string }
  /** The Codemm server failed to start. */
  | { type: 'server'; ok: false }
  | { type: 'done'; ok: boolean; error?: string }
  /**
   * What the agent is looking at: a web search, an https page, or one of Codemm's steps (research progress). `id` is
   * the tool call of a page fetch still under way: it counts as a source only if that call succeeds.
   */
  | { type: 'progress'; step: ResearchStep; id?: string };

/**
 * One step a job shows while it runs. `read` keeps the full https `href` for the roadmap's sources and shows only
 * host and path. Nothing here ever comes from a file path, a file's contents or Codemm's records.
 */
export type ResearchStep = { kind: 'search'; query: string } | { kind: 'read'; url: string; href?: string } | { kind: 'step'; label: string };

/** Codemm's own tools, as the step each job shows (§4.11). Fixed text: nothing from a tool's arguments or result. */
export const STEP_LABELS: Record<string, string> = {
  list_tracks: 'Checking the installed tracks',
  save_roadmap: 'Saving the roadmap',
  get_roadmap: 'Reading the roadmap',
  save_track: 'Proposing the setup',
  save_lesson: 'Saving the lesson',
  save_exercise: 'Codemm is checking the exercise',
  next_step: 'Checking the next step',
  progress: 'Checking your progress',
  get_exercise: 'Reading the activity',
  get_lesson: 'Reading the lesson',
  mark_lesson_read: 'Noting the lesson as read',
};

const searchOf = (query: unknown): ResearchStep[] =>
  typeof query === 'string' && query.trim() ? [{ kind: 'search', query: query.trim().slice(0, 120) }] : [];

/**
 * An https page: shown as host and path, kept whole (query included, fragment dropped) for the roadmap's sources.
 * Anything else (http, files) or a link over core's 2,000 characters shows nothing.
 */
export function readOf(url: unknown): ResearchStep | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return undefined;
    const href = `https://${u.host}${u.pathname}${u.search}`;
    if (href.length > 2000) return undefined;
    const path = u.pathname === '/' ? '' : u.pathname;
    return { kind: 'read', url: `${u.host}${path}`.slice(0, 200), href };
  } catch {
    return undefined;
  }
}

const stepOf = (tool: string): ResearchStep[] => (STEP_LABELS[tool] ? [{ kind: 'step', label: STEP_LABELS[tool] }] : []);
const progress = (steps: (ResearchStep | undefined)[]): AgentEvent[] => steps.flatMap((step) => (step ? [{ type: 'progress' as const, step }] : []));

/** How an agent starts Codemm's MCP server for one job. */
export interface McpServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface Turn {
  prompt: string;
  server: McpServer;
  /** The job's Codemm tools: the only ones the agent may call. */
  tools: string[];
  model?: string;
  /** A session or thread id to continue (tutor turns). */
  resume?: string;
  /** Built-in tools the job may use; only the research job gets web search and fetch (§3.2). */
  web?: boolean;
  /** How long one Codemm tool call may run: the job's deadline. */
  toolTimeoutSec?: number;
}

/** A command the agent CLI runs; `command` is resolved to an executable later. */
export interface Invocation {
  args: string[];
  /** Config the agent reads from its working directory, by relative path: the job runs in a folder holding only these. */
  files?: Record<string, string>;
}

export interface StatusCommand<T> {
  args: string[];
  read: (r: { code: number | null; output: string }) => T;
}

export interface AgentCli {
  /** The executable name looked up on PATH. */
  bin: string;
  launch?: (turn: Turn) => Invocation;
  parse?: (line: string) => AgentEvent[];
  /** Reads a stderr line for a known failure, keeping only a fixed message: stderr can carry account details. */
  errors?: (line: string) => AgentEvent[];
  version: StatusCommand<string | null>;
  signIn: StatusCommand<boolean>;
}

/** The CLI versions the recorded fixtures come from (§3.3). */
export const TESTED: Record<AgentId, string[]> = { claude: ['2.1.283'], codex: ['0.156.1'], cursor: ['2026.10.16-e3cb207'] };
export const isTested = (agent: AgentId, version: string) => TESTED[agent].includes(version);

function json(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): v is string => typeof v === 'string';
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** Known plan-limit markers in an agent's error (§6.1). Unverified until each is recorded as a fixture. */
export const PLAN_LIMIT = /usage limit|rate limit|\b429\b/i;
const TEXT_MAX = 2000;
/** The text of a tool result's content: a string, or text parts. */
const textOf = (content: unknown): string =>
  (str(content) ? content : Array.isArray(content) ? content.map((c) => (str(c?.text) ? c.text : '')).join('\n') : '').slice(0, TEXT_MAX);
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
const toml = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(toml).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.entries(value).map(([k, v]) => `${k}=${toml(v)}`).join(',')}}`
      : JSON.stringify(value);
const versionRead = (pattern: RegExp) => ({ code, output }: { code: number | null; output: string }) =>
  code === 0 ? (plain(output).match(pattern)?.[1] ?? null) : null;

const claude: AgentCli = {
  bin: 'claude',
  launch({ prompt, server, tools, model, resume, web }) {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    // No built-in tools (no shell, no file reads), so only the codemm server's tools exist. Research may search the web.
    args.push('--tools', web ? 'WebSearch,WebFetch' : '', '--mcp-config', JSON.stringify({ mcpServers: { codemm: server } }), '--strict-mcp-config');
    if (tools.length) args.push('--allowedTools', tools.map((t) => `mcp__codemm__${t}`).join(','));
    if (model) args.push('--model', model);
    if (resume) args.push('--resume', resume);
    return { args };
  },
  parse(line) {
    const e = json(line);
    if (!e) return [];
    if (e.type === 'system' && e.subtype === 'init') {
      const failed = Array.isArray(e.mcp_servers) && e.mcp_servers.some((s: { name?: unknown; status?: unknown }) => s?.name === 'codemm' && s.status === 'failed');
      return [...(str(e.session_id) ? [{ type: 'session' as const, id: e.session_id }] : []), ...(failed ? [{ type: 'server' as const, ok: false as const }] : [])];
    }
    if (e.type === 'result') {
      const ok = !e.is_error && e.subtype === 'success';
      return [ok ? { type: 'done', ok } : { type: 'done', ok, error: String(e.result ?? e.subtype) }];
    }
    if (e.type !== 'assistant' && e.type !== 'user') return [];
    const content = (e.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((c): AgentEvent[] => {
      if (c?.type === 'text' && str(c.text)) return [{ type: 'text', text: c.text }];
      if (c?.type === 'tool_use' && str(c.id) && str(c.name)) {
        const input = (c.input ?? {}) as Record<string, unknown>;
        const call: AgentEvent = { type: 'tool_call', id: c.id, name: c.name.replace(/^mcp__(.+?)__/, '$1.') };
        if (c.name === 'WebFetch') {
          const read = readOf(input.url);
          return read ? [call, { type: 'progress', step: read, id: c.id }] : [call];
        }
        const steps = c.name === 'WebSearch' ? searchOf(input.query) : c.name.startsWith('mcp__codemm__') ? stepOf(c.name.slice(13)) : [];
        return [call, ...progress(steps)];
      }
      if (c?.type === 'tool_result' && str(c.tool_use_id)) {
        return [c.is_error === true ? { type: 'tool_result', id: c.tool_use_id, error: true, text: textOf(c.content) } : { type: 'tool_result', id: c.tool_use_id, error: false }];
      }
      return [];
    });
  },
  version: { args: ['--version'], read: versionRead(/^(\d+\.\d+\.\d+\S*)/m) },
  signIn: { args: ['auth', 'status', '--json'], read: ({ output }) => json(output)?.loggedIn === true },
};

const codex: AgentCli = {
  bin: 'codex',
  launch({ prompt, server, tools, model, resume, toolTimeoutSec }) {
    // --ignore-user-config drops the learner's own MCP servers and plugins; sign-in still comes from CODEX_HOME.
    const args = ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config'];
    // No command execution, host automation or subagents. Code mode stays: Codex calls MCP tools through it (§3.1).
    for (const feature of ['shell_tool', 'unified_exec', 'browser_use', 'computer_use', 'apps', 'multi_agent']) args.push('--disable', feature);
    for (const c of [
      'sandbox_mode="read-only"',
      `mcp_servers.codemm.command=${toml(server.command)}`,
      `mcp_servers.codemm.args=${toml(server.args)}`,
      `mcp_servers.codemm.env=${toml(server.env ?? {})}`,
      `mcp_servers.codemm.enabled_tools=${toml(tools)}`,
      // Safe only because enabled_tools limits approval to the job's tools.
      'mcp_servers.codemm.default_tools_approval_mode="approve"',
      // Without it, Codex runs on without tools when the server can't start.
      'mcp_servers.codemm.required=true',
      // Codex's default is 60 s, shorter than a build or the gates.
      ...(toolTimeoutSec ? [`mcp_servers.codemm.tool_timeout_sec=${toolTimeoutSec}`] : []),
    ]) {
      args.push('-c', c);
    }
    if (model) args.push('-m', model);
    return { args: resume ? ['exec', 'resume', ...args.slice(1), resume, prompt] : [...args, prompt] };
  },
  parse(line) {
    const e = json(line);
    if (!e) return [];
    if (e.type === 'thread.started') return str(e.thread_id) ? [{ type: 'session', id: e.thread_id }] : [];
    if (e.type === 'turn.completed') return [{ type: 'done', ok: true }];
    if (e.type === 'turn.failed') return [{ type: 'done', ok: false, error: String((e.error as { message?: unknown } | undefined)?.message ?? 'turn failed') }];
    const item = e.item as Record<string, unknown> | undefined;
    if (item?.type === 'agent_message' && e.type === 'item.completed' && str(item.text)) return [{ type: 'text', text: item.text }];
    if (item?.type === 'web_search' && e.type === 'item.completed') {
      const action = (item.action ?? {}) as { type?: unknown; queries?: unknown; query?: unknown; url?: unknown };
      if (action.type === 'open_page') return progress([readOf(action.url)]);
      const queries = Array.isArray(action.queries) ? action.queries : [action.query ?? item.query];
      return progress(queries.flatMap(searchOf));
    }
    if (item?.type === 'mcp_tool_call' && str(item.id) && str(item.server) && str(item.tool)) {
      if (e.type === 'item.started') return [{ type: 'tool_call', id: item.id, name: `${item.server}.${item.tool}` }, ...(item.server === 'codemm' ? progress(stepOf(item.tool)) : [])];
      if (e.type === 'item.completed') {
        const error = item.status !== 'completed' || item.error != null;
        const failure = (item.error as { message?: unknown } | null)?.message ?? (item.result as { content?: unknown } | null)?.content;
        return [error ? { type: 'tool_result', id: item.id, error, text: textOf(failure) } : { type: 'tool_result', id: item.id, error }];
      }
    }
    return [];
  },
  version: { args: ['--version'], read: versionRead(/^codex-cli (\d+\.\d+\.\d+\S*)/m) },
  signIn: { args: ['login', 'status'], read: ({ code, output }) => code === 0 && /^logged in/im.test(plain(output).trim()) },
};

/** Why a Cursor MCP result failed: an error, a rejection, a denial or an unknown tool, or a success the tool marked as an error. */
function cursorFailure(result: Record<string, unknown>): string | null {
  const success = obj(result.success);
  if (success) return success.isError === true ? textOf((success.content as { text?: { text?: unknown } }[] | undefined)?.map((c) => c?.text)) : null;
  const failed = obj(result.error) ?? obj(result.rejected) ?? obj(result.permissionDenied) ?? obj(result.toolNotFound) ?? {};
  const why = failed.error ?? failed.reason;
  return str(why) ? why.slice(0, TEXT_MAX) : '';
}

const cursor: AgentCli = {
  bin: 'cursor-agent',
  launch({ prompt, server, tools, model, resume, web }) {
    // Cursor reads MCP servers and permissions from the working directory (and the learner's ~/.cursor, which stays
    // untouched): the job folder holds only the codemm server, and allows only the job's tools. Print mode approves
    // web search and fetch only with --force, so research alone gets it; the deny rules still hold under it (§3.1).
    const permissions = {
      allow: [...tools.map((t) => `Mcp(codemm:${t})`), ...(web ? ['WebFetch(*)'] : [])],
      deny: ['Shell(*)', 'Read(**)', 'Read(/**)', 'Write(**)', 'Write(/**)', ...(web ? [] : ['WebFetch(*)'])],
    };
    // --trust: the job folder is Codemm's own, and an untrusted folder stops print mode to ask.
    const args = ['-p', '--output-format', 'stream-json', '--approve-mcps', '--trust'];
    if (web) args.push('--force');
    if (model) args.push('--model', model);
    if (resume) args.push('--resume', resume);
    args.push(prompt);
    return { args, files: { '.cursor/mcp.json': JSON.stringify({ mcpServers: { codemm: server } }), '.cursor/cli.json': JSON.stringify({ permissions }) } };
  },
  parse(line) {
    const e = json(line);
    if (!e) return [];
    if (e.type === 'system' && e.subtype === 'init') return str(e.session_id) ? [{ type: 'session', id: e.session_id }] : [];
    if (e.type === 'result') {
      const ok = !e.is_error && e.subtype === 'success';
      return [ok ? { type: 'done', ok } : { type: 'done', ok, error: String(e.result ?? e.subtype) }];
    }
    if (e.type === 'assistant') {
      const content = obj(e.message)?.content;
      return Array.isArray(content) ? content.flatMap((c): AgentEvent[] => (c?.type === 'text' && str(c.text) ? [{ type: 'text', text: c.text }] : [])) : [];
    }
    const call = obj(e.tool_call);
    if (e.type !== 'tool_call' || !str(e.call_id) || !call) return [];
    const kind = Object.keys(call).find((k) => k.endsWith('ToolCall'));
    if (!kind) return [];
    const mcp = obj(call.mcpToolCall);
    if (e.subtype === 'started') {
      const args = obj(mcp?.args);
      if (mcp) {
        if (!args || !str(args.providerIdentifier) || !str(args.toolName)) return [];
        return [{ type: 'tool_call', id: e.call_id, name: `${args.providerIdentifier}.${args.toolName}` }, ...(args.providerIdentifier === 'codemm' ? progress(stepOf(args.toolName)) : [])];
      }
      const started: AgentEvent = { type: 'tool_call', id: e.call_id, name: kind.replace(/ToolCall$/, '') };
      const input = obj(obj(call[kind])?.args) ?? {};
      if (kind === 'webFetchToolCall') {
        const read = readOf(input.url);
        return read ? [started, { type: 'progress', step: read, id: e.call_id }] : [started];
      }
      return [started, ...progress(kind === 'webSearchToolCall' ? searchOf(input.searchTerm) : [])];
    }
    if (e.subtype !== 'completed') return [];
    const result = obj(obj(call[kind])?.result);
    if (!result) return [];
    const failure = mcp ? cursorFailure(result) : 'success' in result ? null : (str(obj(result.error)?.error) ? (obj(result.error)!.error as string) : '');
    const events: AgentEvent[] = [failure === null ? { type: 'tool_result', id: e.call_id, error: false } : { type: 'tool_result', id: e.call_id, error: true, ...(mcp ? { text: failure } : {}) }];
    // Cursor never says a server failed to start: the tool lookup can't find its namespace, or a call its server (recorded).
    if (failure && /namespace "codemm" not found|MCP server does not exist: codemm\b/i.test(failure)) events.push({ type: 'server', ok: false });
    return events;
  },
  errors: (line) =>
    PLAN_LIMIT.test(line)
      ? [{ type: 'done', ok: false, error: 'usage limit' }]
      : /connection lost|ENOTFOUND|EAI_AGAIN|network is unreachable/i.test(line)
        ? [{ type: 'done', ok: false, error: 'connection error' }]
        : [],
  version: { args: ['--version'], read: versionRead(/^(\d{4}\.\d{2}\.\d{2}-\S+)/m) },
  signIn: {
    args: ['status'],
    read: ({ code, output }) => code === 0 && !/not logged in/i.test(plain(output)) && /logged in/i.test(plain(output)),
  },
};

export const AGENT_CLIS: Record<AgentId, AgentCli> = { claude, codex, cursor };
