// Cursor Agent: launching a headless turn with Codemm's MCP server, and reading its JSON stream (DESIGN §3.1).
import type { AgentCli, AgentEvent } from './agents';
import { json, obj, plain, PLAN_LIMIT, progress, readOf, searchOf, stepOf, str, TEXT_MAX, textOf, usageOf, versionRead } from './stream';

/** Why a Cursor MCP result failed: an error, a rejection, a denial or an unknown tool, or a success the tool marked as an error. */
function cursorFailure(result: Record<string, unknown>): string | null {
  const success = obj(result.success);
  if (success) return success.isError === true ? textOf((success.content as { text?: { text?: unknown } }[] | undefined)?.map((c) => c?.text)) : null;
  const failed = obj(result.error) ?? obj(result.rejected) ?? obj(result.permissionDenied) ?? obj(result.toolNotFound) ?? {};
  const why = failed.error ?? failed.reason;
  return str(why) ? why.slice(0, TEXT_MAX) : '';
}

export const cursor: AgentCli = {
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
      const usage = usageOf(obj(e.usage), { input: 'inputTokens', read: 'cacheReadTokens', write: 'cacheWriteTokens', output: 'outputTokens' });
      return [...usage, ok ? { type: 'done', ok } : { type: 'done', ok, error: String(e.result ?? e.subtype) }];
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
    read: ({ code, output }) => (/not logged in/i.test(plain(output)) ? false : code === 0 && /logged in/i.test(plain(output)) ? true : null),
  },
};
