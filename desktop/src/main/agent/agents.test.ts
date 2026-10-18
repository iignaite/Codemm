// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_CLIS, isTested, readOf } from './agents';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8').split('\n');
const parseAll = (agent: 'claude' | 'codex' | 'cursor', lines: string[]) => lines.flatMap((line) => AGENT_CLIS[agent].parse!(line));
const server = { command: '/abs/Codemm', args: ['/abs/core/cli.js', 'mcp', '--workspace', '/ws'], env: { CODEMM_HOME: '/home', ELECTRON_RUN_AS_NODE: '1' } };

describe('research progress from the stream (one parser for both CLIs)', () => {
  const steps = (agent: 'claude' | 'codex', name: string) => parseAll(agent, fixture(name)).flatMap((e) => (e.type === 'progress' ? [e.step] : []));

  it('claude: web searches, https reads as host and path, and Codemm steps; never a file or plain-http link', () => {
    expect(steps('claude', 'claude-research.jsonl')).toEqual([
      { kind: 'step', label: 'Checking the installed tracks' },
      { kind: 'search', query: 'react roadmap 2026' },
      { kind: 'read', url: 'roadmap.sh/react', href: 'https://roadmap.sh/react?ref=x' },
      { kind: 'step', label: 'Saving the roadmap' },
    ]);
  });

  it('codex: its web search items (recorded), page reads, and Codemm steps', () => {
    expect(steps('codex', 'codex-research.jsonl')).toEqual([
      { kind: 'step', label: 'Checking the installed tracks' },
      { kind: 'search', query: 'site:react.dev/learn React Learn official tutorial thinking in React state effects refs context reducers' },
      { kind: 'search', query: 'Full Stack Open React curriculum official parts React state hooks routing testing' },
      { kind: 'step', label: 'Saving the roadmap' },
      { kind: 'read', url: 'roadmap.sh/react', href: 'https://roadmap.sh/react?utm=x' },
    ]);
  });

  it('marks a Claude read with its tool call, so a source counts only after the fetch succeeds', () => {
    const events = parseAll('claude', fixture('claude-research.jsonl'));
    expect(events).toContainEqual({ type: 'progress', id: 't3', step: { kind: 'read', url: 'roadmap.sh/react', href: 'https://roadmap.sh/react?ref=x' } });
  });

  it('caps a search at 120 characters, and keeps the full https url for sources', () => {
    const [step] = AGENT_CLIS.claude.parse!(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'WebSearch', input: { query: 'q'.repeat(300) } }] } })).flatMap((e) => (e.type === 'progress' ? [e.step] : []));
    expect(step).toEqual({ kind: 'search', query: 'q'.repeat(120) });
    // Sources keep the query (it can name the document); only the fragment goes. Overlong links are dropped.
    expect(readOf('https://docs.example.com/view?id=123#top')).toEqual({ kind: 'read', url: 'docs.example.com/view', href: 'https://docs.example.com/view?id=123' });
    expect(readOf(`https://example.com/${'a'.repeat(2100)}`)).toBeUndefined();
    expect(readOf('ftp://x/y')).toBeUndefined();
  });
});

describe('agent stream contracts (recorded fixtures, §3.3)', () => {
  it('claude: a recorded run becomes session, tool, text and done events', () => {
    expect(parseAll('claude', fixture('claude-list-tracks.jsonl'))).toEqual([
      { type: 'session', id: 'f242da1d-dc70-4d6f-96da-1f92ecc2d720' },
      { type: 'tool_call', id: 'toolu_01MvSVPGD77trQgd9hUqhwG3', name: 'ToolSearch' },
      { type: 'tool_result', id: 'toolu_01MvSVPGD77trQgd9hUqhwG3', error: false },
      { type: 'tool_call', id: 'toolu_01NfoeX7ahYrG2GZ1kmsnnnP', name: 'codemm.list_tracks' },
      { type: 'progress', step: { kind: 'step', label: 'Checking the installed tracks' } },
      { type: 'tool_result', id: 'toolu_01NfoeX7ahYrG2GZ1kmsnnnP', error: false },
      { type: 'text', text: '0' },
      { type: 'usage', input: 0, output: 0, costUsd: 0.034289 },
      { type: 'done', ok: true },
    ]);
  });

  it('claude: a Codemm server that failed to start is a server event (recorded)', () => {
    expect(parseAll('claude', fixture('claude-mcp-failed.jsonl'))).toEqual([
      { type: 'session', id: 'ae1c50df-0a98-4d41-bb1b-5e28415bdb54' },
      { type: 'server', ok: false },
      { type: 'done', ok: true },
    ]);
  });

  it('a failed Codemm tool result keeps its text, so an infrastructure failure can be told apart', () => {
    const claudeLine = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: "The container runtime isn't running." }] }] } });
    expect(AGENT_CLIS.claude.parse!(claudeLine)).toEqual([{ type: 'tool_result', id: 't1', error: true, text: "The container runtime isn't running." }]);
    const codexLine = JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'codemm', tool: 'save_exercise', status: 'failed', error: { message: 'Not enough disk space' }, result: null } });
    expect(AGENT_CLIS.codex.parse!(codexLine)).toEqual([{ type: 'tool_result', id: 'i1', error: true, text: 'Not enough disk space' }]);
  });

  it('claude: a failed result is done with ok false', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' });
    expect(AGENT_CLIS.claude.parse!(line)).toEqual([{ type: 'done', ok: false, error: 'boom' }]);
  });

  it('codex: a recorded run becomes session, tool, text and done events', () => {
    expect(parseAll('codex', fixture('codex-list-tracks.jsonl'))).toEqual([
      { type: 'session', id: '01a14a25-cfba-7b41-a5d4-d7f42843ba87' },
      { type: 'text', text: 'I’ll locate the available Codemm tool and call `list_tracks` exactly once.' },
      { type: 'tool_call', id: 'item_1', name: 'codemm.list_tracks' },
      { type: 'progress', step: { kind: 'step', label: 'Checking the installed tracks' } },
      { type: 'tool_result', id: 'item_1', error: false },
      { type: 'text', text: '0' },
      { type: 'usage', input: 65870, output: 100, cachedInput: 43392 },
      { type: 'done', ok: true },
    ]);
  });

  it("codex: a rejected model ends with ok false and the agent's message", () => {
    const events = parseAll('codex', fixture('codex-model-rejected.jsonl'));
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'done', ok: false, error: expect.stringMatching(/not supported when using Codex with a ChatGPT account/) });
  });

  it('cursor: a recorded run becomes session, tool, text and done events; its own tool lookup is skipped', () => {
    const id = 'call-ae295db3-0a12-4df1-8a5e-c6a6ed50d8eb-1\nfc_e6b3e488-3488-9c7d-b2b6-884faeddd958_0';
    expect(parseAll('cursor', fixture('cursor-list-tracks.jsonl'))).toEqual([
      { type: 'session', id: '58a468a6-05de-4564-b518-475343f68a24' },
      { type: 'text', text: "I'll inspect the `codemm` `list_tracks` schema, call it once, then reply with only the track count." },
      { type: 'tool_call', id, name: 'codemm.list_tracks' },
      { type: 'progress', step: { kind: 'step', label: 'Checking the installed tracks' } },
      { type: 'tool_result', id, error: false },
      { type: 'text', text: '0' },
      { type: 'done', ok: true },
    ]);
  });

  it('cursor: a Codemm server that failed to start is a server event (recorded: its namespace and server are missing)', () => {
    const events = parseAll('cursor', fixture('cursor-mcp-failed.jsonl'));
    expect(events.filter((e) => e.type === 'server')).not.toHaveLength(0);
    expect(events[0]).toEqual({ type: 'session', id: 'c84e6140-5911-4338-87a9-873afb53dce8' });
  });

  it('cursor: a failed, rejected or denied Codemm call is a failed result that keeps its text', () => {
    const call = (result: unknown) =>
      JSON.stringify({ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { mcpToolCall: { args: { providerIdentifier: 'codemm', toolName: 'save_exercise' }, result } } });
    expect(AGENT_CLIS.cursor.parse!(call({ success: { content: [{ text: { text: 'Not enough disk space' } }], isError: true } }))).toEqual([
      { type: 'tool_result', id: 'c1', error: true, text: 'Not enough disk space' },
    ]);
    expect(AGENT_CLIS.cursor.parse!(call({ error: { error: "The container runtime isn't running." } }))).toEqual([
      { type: 'tool_result', id: 'c1', error: true, text: "The container runtime isn't running." },
    ]);
    expect(AGENT_CLIS.cursor.parse!(call({ rejected: { reason: 'no' } }))).toEqual([{ type: 'tool_result', id: 'c1', error: true, text: 'no' }]);
    expect(AGENT_CLIS.cursor.parse!(call({ permissionDenied: { error: 'denied' } }))).toEqual([{ type: 'tool_result', id: 'c1', error: true, text: 'denied' }]);
    expect(AGENT_CLIS.cursor.parse!(call({ toolNotFound: {} }))).toEqual([{ type: 'tool_result', id: 'c1', error: true, text: '' }]);
  });

  it('cursor: web searches and https reads are research progress (shapes recorded with --force)', () => {
    const started = (call_id: string, tool_call: object) => JSON.stringify({ type: 'tool_call', subtype: 'started', call_id, tool_call });
    expect(AGENT_CLIS.cursor.parse!(started('s1', { webSearchToolCall: { args: { searchTerm: 'python list comprehension', toolCallId: 's1' } } }))).toEqual([
      { type: 'tool_call', id: 's1', name: 'webSearch' },
      { type: 'progress', step: { kind: 'search', query: 'python list comprehension' } },
    ]);
    expect(AGENT_CLIS.cursor.parse!(started('f1', { webFetchToolCall: { args: { url: 'https://example.com/a?b=1', toolCallId: 'f1' } } }))).toEqual([
      { type: 'tool_call', id: 'f1', name: 'webFetch' },
      { type: 'progress', id: 'f1', step: { kind: 'read', url: 'example.com/a', href: 'https://example.com/a?b=1' } },
    ]);
    expect(AGENT_CLIS.cursor.parse!(started('f2', { webFetchToolCall: { args: { url: 'file:///etc/passwd' } } }))).toEqual([{ type: 'tool_call', id: 'f2', name: 'webFetch' }]);
  });

  it("cursor: a built-in tool is named by its kind, and a result that isn't a success is done with ok false", () => {
    const started = JSON.stringify({ type: 'tool_call', subtype: 'started', call_id: 'w1', tool_call: { webSearchToolCall: { args: { searchTerm: 'react' } } } });
    expect(AGENT_CLIS.cursor.parse!(started)).toEqual([{ type: 'tool_call', id: 'w1', name: 'webSearch' }, { type: 'progress', step: { kind: 'search', query: 'react' } }]);
    expect(AGENT_CLIS.cursor.parse!(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'boom' }))).toEqual([{ type: 'done', ok: false, error: 'boom' }]);
  });

  it('cursor: errors go to stderr; only a plan limit or a lost connection is read from it, as a fixed message', () => {
    // Recorded on the free plan, after research and before setup.
    expect(AGENT_CLIS.cursor.errors!("ActionRequiredError: You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more.")).toEqual([{ type: 'done', ok: false, error: 'usage limit' }]);
    // A lost connection is the computer being offline: the fixed text matches the offline markers (jobs.ts).
    expect(AGENT_CLIS.cursor.errors!('Connection lost, reconnecting...')).toEqual([{ type: 'done', ok: false, error: 'connection error' }]);
    expect(AGENT_CLIS.cursor.errors!("Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.")).toEqual([]);
  });

  it('reads what each CLI reports about usage: all input tokens, cached ones, output, and Claude\'s cost', () => {
    const claude = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.12, usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 40 } });
    expect(AGENT_CLIS.claude.parse!(claude)).toEqual([{ type: 'usage', input: 3210, output: 40, cachedInput: 3000, costUsd: 0.12 }, { type: 'done', ok: true }]);
    const codex = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 500, cached_input_tokens: 300, output_tokens: 20 } });
    expect(AGENT_CLIS.codex.parse!(codex)).toEqual([{ type: 'usage', input: 500, output: 20, cachedInput: 300 }, { type: 'done', ok: true }]);
    const cursor = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { inputTokens: 17153, outputTokens: 1967, cacheReadTokens: 159360, cacheWriteTokens: 0 } });
    expect(AGENT_CLIS.cursor.parse!(cursor)).toEqual([{ type: 'usage', input: 176513, output: 1967, cachedInput: 159360 }, { type: 'done', ok: true }]);
    // Nothing reported, nothing emitted; a number that isn't one counts as 0.
    expect(AGENT_CLIS.codex.parse!(JSON.stringify({ type: 'turn.completed' }))).toEqual([{ type: 'done', ok: true }]);
    const odd = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: -1, usage: { input_tokens: 'many', output_tokens: 7 } });
    expect(AGENT_CLIS.claude.parse!(odd)).toEqual([{ type: 'usage', input: 0, output: 7, cachedInput: 0 }, { type: 'done', ok: true }]);
  });


  it('ignores blank, non-JSON, unknown and malformed lines', () => {
    const malformed = [
      '{"type":"assistant","message":{"content":"a string, not a list"}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1"}]}}',
      '{"type":"assistant","message":{"content":[null,{"type":"text","text":7}]}}',
      '{"type":"item.started","item":{"type":"mcp_tool_call","id":"i1"}}',
      '{"type":"system","subtype":"init"}',
      '{"type":"tool_call","subtype":"started","tool_call":{"mcpToolCall":{}}}',
      '{"type":"tool_call","subtype":"completed","call_id":"c1","tool_call":null}',
    ];
    for (const agent of ['claude', 'codex', 'cursor'] as const) {
      for (const line of ['', 'Reading additional input from stdin...', '{"type":"rate_limit_event"}', '[1,2]', 'null', ...malformed]) {
        expect(AGENT_CLIS[agent].parse!(line)).toEqual([]);
      }
    }
  });
});

describe('launch arguments (§3.1)', () => {
  it('claude: stream-json, no built-in tools, only the codemm server and the job tools', () => {
    const { args } = AGENT_CLIS.claude.launch!({ prompt: 'hi', server, tools: ['list_tracks', 'progress'], model: 'sonnet' });
    expect(args.slice(0, 5)).toEqual(['-p', 'hi', '--output-format', 'stream-json', '--verbose']);
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1])).toEqual({ mcpServers: { codemm: server } });
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__codemm__list_tracks,mcp__codemm__progress');
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args).not.toContain('--resume');
  });

  it('claude: research may search the web; resume adds the session', () => {
    expect(AGENT_CLIS.claude.launch!({ prompt: 'r', server, tools: [], web: true }).args).toContain('WebSearch,WebFetch');
    const { args } = AGENT_CLIS.claude.launch!({ prompt: 'again', server, tools: [], resume: 'abc' });
    expect(args[args.indexOf('--resume') + 1]).toBe('abc');
  });

  it('codex: exec --json read-only, shell and automation off, only the job tools', () => {
    const { args } = AGENT_CLIS.codex.launch!({ prompt: 'hi', server, tools: ['list_tracks'], model: 'gpt-5.6-luna', toolTimeoutSec: 900 });
    expect(args.slice(0, 4)).toEqual(['exec', '--json', '--skip-git-repo-check', '--ignore-user-config']);
    expect(args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []))).toEqual([
      'sandbox_mode="read-only"',
      // Only research may search the web (§3.2).
      'web_search="disabled"',
      'mcp_servers.codemm.command="/abs/Codemm"',
      'mcp_servers.codemm.args=["/abs/core/cli.js","mcp","--workspace","/ws"]',
      'mcp_servers.codemm.env={CODEMM_HOME="/home",ELECTRON_RUN_AS_NODE="1"}',
      'mcp_servers.codemm.enabled_tools=["list_tracks"]',
      'mcp_servers.codemm.default_tools_approval_mode="approve"',
      // A Codemm server that can't start fails the run instead of running without tools.
      'mcp_servers.codemm.required=true',
      // Codex's own 60-second default would end long builds and gates before the job's deadline.
      'mcp_servers.codemm.tool_timeout_sec=900',
    ]);
    expect(args.flatMap((a, i) => (args[i - 1] === '--disable' ? [a] : []))).toEqual(['shell_tool', 'unified_exec', 'browser_use', 'computer_use', 'apps', 'multi_agent']);
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.6-luna');
    expect(args.at(-1)).toBe('hi');
  });

  it('codex: research keeps its web search; every other job has it off', () => {
    const c = (web: boolean) => {
      const { args } = AGENT_CLIS.codex.launch!({ prompt: 'hi', server, tools: [], web });
      return args.filter((a, i) => args[i - 1] === '-c' && a.startsWith('web_search='));
    };
    expect(c(true)).toEqual([]);
    expect(c(false)).toEqual(['web_search="disabled"']);
  });

  it('codex: resume uses exec resume with the thread before the prompt', () => {
    const { args } = AGENT_CLIS.codex.launch!({ prompt: 'again', server, tools: [], resume: 't1' });
    expect(args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(args.slice(-2)).toEqual(['t1', 'again']);
    // A resumed tutor turn still can't search the web.
    expect(args[args.indexOf('web_search="disabled"') - 1]).toBe('-c');
  });

  it('cursor: print mode with stream-json and its MCP servers approved; the prompt goes last', () => {
    const { args } = AGENT_CLIS.cursor.launch!({ prompt: 'hi', server, tools: ['list_tracks'], model: 'auto' });
    // --trust: the job folder is Codemm's own; without it Cursor may stop to ask.
    expect(args).toEqual(['-p', '--output-format', 'stream-json', '--approve-mcps', '--trust', '--model', 'auto', 'hi']);
    expect(args).not.toContain('--force');
    const again = AGENT_CLIS.cursor.launch!({ prompt: 'again', server, tools: [], resume: 'chat-1' }).args;
    expect(again.slice(-3)).toEqual(['--resume', 'chat-1', 'again']);
  });

  it("cursor: the job folder's config holds only the codemm server and allows only the job's tools", () => {
    const { files } = AGENT_CLIS.cursor.launch!({ prompt: 'hi', server, tools: ['list_tracks', 'save_roadmap'] });
    expect(JSON.parse(files!['.cursor/mcp.json'])).toEqual({ mcpServers: { codemm: server } });
    expect(JSON.parse(files!['.cursor/cli.json'])).toEqual({
      permissions: {
        allow: ['Mcp(codemm:list_tracks)', 'Mcp(codemm:save_roadmap)'],
        // No shell, no file reads or writes anywhere, no web.
        deny: ['Shell(*)', 'Read(**)', 'Read(/**)', 'Write(**)', 'Write(/**)', 'WebFetch(*)'],
      },
    });
  });

  it('cursor: research may search and fetch the web, which print mode approves only with --force; the deny rules still hold', () => {
    const { args, files } = AGENT_CLIS.cursor.launch!({ prompt: 'r', server, tools: ['save_roadmap'], web: true });
    expect(args).toContain('--force');
    const { allow, deny } = JSON.parse(files!['.cursor/cli.json']).permissions;
    expect(allow).toContain('WebFetch(*)');
    expect(deny).not.toContain('WebFetch(*)');
  });
});

describe('status commands', () => {
  it('reads sign-in as a yes or no only', () => {
    expect(AGENT_CLIS.claude.signIn.args).toEqual(['auth', 'status', '--json']);
    expect(AGENT_CLIS.claude.signIn.read({ code: 0, output: '{"loggedIn":true,"email":"x@y"}' })).toBe(true);
    expect(AGENT_CLIS.claude.signIn.read({ code: 1, output: '{"loggedIn":false}' })).toBe(false);
    expect(AGENT_CLIS.claude.signIn.read({ code: 0, output: 'not json' })).toBe(false);
    expect(AGENT_CLIS.codex.signIn.read({ code: 0, output: 'Logged in using ChatGPT\n' })).toBe(true);
    expect(AGENT_CLIS.codex.signIn.read({ code: 1, output: 'Not logged in\n' })).toBe(false);
    expect(AGENT_CLIS.cursor.signIn.read({ code: 0, output: '\u001b[2K Not logged in\n' })).toBe(false);
    expect(AGENT_CLIS.cursor.signIn.read({ code: 0, output: 'Logged in as someone\n' })).toBe(true);
  });

  it('reads the full version token, so a prerelease is untested (D6)', () => {
    expect(AGENT_CLIS.claude.version.read({ code: 0, output: '2.1.283 (Claude Code)\n' })).toBe('2.1.283');
    expect(AGENT_CLIS.codex.version.read({ code: 0, output: 'codex-cli 0.156.1\n' })).toBe('0.156.1');
    expect(AGENT_CLIS.cursor.version.read({ code: 0, output: '2026.01.23-916f423\n' })).toBe('2026.01.23-916f423');
    expect(AGENT_CLIS.claude.version.read({ code: 0, output: 'garbage' })).toBeNull();
    expect(AGENT_CLIS.claude.version.read({ code: 1, output: '2.1.283' })).toBeNull();
    expect(isTested('claude', '2.1.283')).toBe(true);
    expect(isTested('codex', '0.157.0')).toBe(false);
    expect(isTested('codex', AGENT_CLIS.codex.version.read({ code: 0, output: 'codex-cli 0.156.1-alpha.1\n' })!)).toBe(false);
    // The fixtures were recorded on 2026.10.16-e3cb207, which cursor-agent updated itself to at sign-in.
    expect(isTested('cursor', '2026.10.16-e3cb207')).toBe(true);
    expect(isTested('cursor', '2026.01.23-916f423')).toBe(false);
  });
});
