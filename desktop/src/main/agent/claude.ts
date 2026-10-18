// Claude Code: launching a headless turn with Codemm's MCP server, and reading its JSON stream (DESIGN §3.1).
import type { AgentCli, AgentEvent } from './agents';
import { json, obj, progress, readOf, searchOf, stepOf, str, textOf, usageOf, versionRead } from './stream';

export const claude: AgentCli = {
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
      const usage = usageOf(obj(e.usage), { input: 'input_tokens', read: 'cache_read_input_tokens', write: 'cache_creation_input_tokens', output: 'output_tokens' }, e.total_cost_usd);
      return [...usage, ok ? { type: 'done', ok } : { type: 'done', ok, error: String(e.result ?? e.subtype) }];
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
