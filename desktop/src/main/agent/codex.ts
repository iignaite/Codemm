// Codex: launching a headless turn with Codemm's MCP server, and reading its JSON stream (DESIGN §3.1).
import type { AgentCli, AgentEvent } from './agents';
import { count, json, obj, plain, progress, readOf, searchOf, stepOf, str, textOf, versionRead } from './stream';

const toml = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(toml).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.entries(value).map(([k, v]) => `${k}=${toml(v)}`).join(',')}}`
      : JSON.stringify(value);

export const codex: AgentCli = {
  bin: 'codex',
  launch({ prompt, server, tools, model, resume, web, toolTimeoutSec }) {
    // --ignore-user-config drops the learner's own MCP servers and plugins; sign-in still comes from CODEX_HOME.
    const args = ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config'];
    // No command execution, host automation or subagents. Code mode stays: Codex calls MCP tools through it (§3.1).
    for (const feature of ['shell_tool', 'unified_exec', 'browser_use', 'computer_use', 'apps', 'multi_agent']) args.push('--disable', feature);
    for (const c of [
      'sandbox_mode="read-only"',
      // Only research, review and setup may search the web (§3.2): setup finds a WASI build's release file. Codex 0.156 accepts disabled, cached, indexed or live.
      ...(web ? [] : ['web_search="disabled"']),
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
    if (e.type === 'turn.completed') {
      // Codex's input_tokens already include the cached ones.
      const u = obj(e.usage);
      const usage: AgentEvent[] = u ? [{ type: 'usage', input: count(u.input_tokens), output: count(u.output_tokens), cachedInput: count(u.cached_input_tokens) }] : [];
      return [...usage, { type: 'done', ok: true }];
    }
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
  signIn: {
    args: ['login', 'status'],
    read: ({ code, output }) => (/^not logged in/im.test(plain(output).trim()) ? false : code === 0 && /^logged in/im.test(plain(output).trim()) ? true : null),
  },
};
