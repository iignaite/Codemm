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
  | { type: 'done'; ok: boolean; error?: string };

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
export const TESTED: Record<AgentId, string[]> = { claude: ['2.1.283'], codex: ['0.156.1'], cursor: ['2026.01.23-916f423'] };
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
      if (c?.type === 'tool_use' && str(c.id) && str(c.name)) return [{ type: 'tool_call', id: c.id, name: c.name.replace(/^mcp__(.+?)__/, '$1.') }];
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
    if (item?.type === 'mcp_tool_call' && str(item.id) && str(item.server) && str(item.tool)) {
      if (e.type === 'item.started') return [{ type: 'tool_call', id: item.id, name: `${item.server}.${item.tool}` }];
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
    // untouched): the job folder holds only the codemm server, and allows only the job's tools. No --force (§3.1).
    const permissions = {
      allow: [...tools.map((t) => `Mcp(codemm:${t})`), ...(web ? ['WebFetch(*)'] : [])],
      deny: ['Shell(*)', 'Read(**)', 'Read(/**)', 'Write(**)', 'Write(/**)', ...(web ? [] : ['WebFetch(*)'])],
    };
    const args = ['-p', '--output-format', 'stream-json', '--approve-mcps'];
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
    const [kind] = Object.keys(call);
    if (!kind) return [];
    const mcp = obj(call.mcpToolCall);
    if (e.subtype === 'started') {
      const args = obj(mcp?.args);
      if (mcp) return args && str(args.providerIdentifier) && str(args.toolName) ? [{ type: 'tool_call', id: e.call_id, name: `${args.providerIdentifier}.${args.toolName}` }] : [];
      return [{ type: 'tool_call', id: e.call_id, name: kind.replace(/ToolCall$/, '') }];
    }
    if (e.subtype !== 'completed') return [];
    const result = obj(obj(call[kind])?.result);
    if (!result) return [];
    if (!mcp) return [{ type: 'tool_result', id: e.call_id, error: !('success' in result) }];
    const failure = cursorFailure(result);
    return [failure === null ? { type: 'tool_result', id: e.call_id, error: false } : { type: 'tool_result', id: e.call_id, error: true, text: failure }];
  },
  errors: (line) => (PLAN_LIMIT.test(line) ? [{ type: 'done', ok: false, error: 'usage limit' }] : []),
  version: { args: ['--version'], read: versionRead(/^(\d{4}\.\d{2}\.\d{2}-\S+)/m) },
  signIn: {
    args: ['status'],
    read: ({ code, output }) => code === 0 && !/not logged in/i.test(plain(output)) && /logged in/i.test(plain(output)),
  },
};

export const AGENT_CLIS: Record<AgentId, AgentCli> = { claude, codex, cursor };
