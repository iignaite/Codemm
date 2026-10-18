// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_CLIS, isTested, readOf } from './agents';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8').split('\n');
const parseAll = (agent: 'claude' | 'codex', lines: string[]) => lines.flatMap((line) => AGENT_CLIS[agent].parse!(line));
const server = { command: '/abs/Codemm', args: ['/abs/core/cli.js', 'mcp', '--workspace', '/ws'], env: { CODEMM_HOME: '/home', ELECTRON_RUN_AS_NODE: '1' } };

describe('research progress from the stream (one parser for both CLIs)', () => {
  const steps = (agent: 'claude' | 'codex', name: string) => parseAll(agent, fixture(name)).flatMap((e) => (e.type === 'progress' ? [e.step] : []));

  it('claude: web searches, https reads as host and path, and Codemm steps; never a file or plain-http link', () => {
    expect(steps('claude', 'claude-research.jsonl')).toEqual([
      { kind: 'step', label: 'Checking the installed tracks' },
      { kind: 'search', query: 'react roadmap 2026' },
      { kind: 'read', url: 'roadmap.sh/react', href: 'https://roadmap.sh/react' },
      { kind: 'step', label: 'Saving the roadmap' },
    ]);
  });

  it('codex: its web search items (recorded), page reads, and Codemm steps', () => {
    expect(steps('codex', 'codex-research.jsonl')).toEqual([
      { kind: 'step', label: 'Checking the installed tracks' },
      { kind: 'search', query: 'site:react.dev/learn React Learn official tutorial thinking in React state effects refs context reducers' },
      { kind: 'search', query: 'Full Stack Open React curriculum official parts React state hooks routing testing' },
      { kind: 'step', label: 'Saving the roadmap' },
      { kind: 'read', url: 'roadmap.sh/react', href: 'https://roadmap.sh/react' },
    ]);
  });

  it('caps a search at 120 characters, and keeps the full https url for sources', () => {
    const [step] = AGENT_CLIS.claude.parse!(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'WebSearch', input: { query: 'q'.repeat(300) } }] } })).flatMap((e) => (e.type === 'progress' ? [e.step] : []));
    expect(step).toEqual({ kind: 'search', query: 'q'.repeat(120) });
    expect(readOf('https://roadmap.sh/react?utm=1#top')).toEqual({ kind: 'read', url: 'roadmap.sh/react', href: 'https://roadmap.sh/react' });
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
      { type: 'done', ok: true },
    ]);
  });

  it("codex: a rejected model ends with ok false and the agent's message", () => {
    const events = parseAll('codex', fixture('codex-model-rejected.jsonl'));
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'done', ok: false, error: expect.stringMatching(/not supported when using Codex with a ChatGPT account/) });
  });

  it('ignores blank, non-JSON, unknown and malformed lines', () => {
    const malformed = [
      '{"type":"assistant","message":{"content":"a string, not a list"}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1"}]}}',
      '{"type":"assistant","message":{"content":[null,{"type":"text","text":7}]}}',
      '{"type":"item.started","item":{"type":"mcp_tool_call","id":"i1"}}',
      '{"type":"system","subtype":"init"}',
    ];
    for (const agent of ['claude', 'codex'] as const) {
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

  it('codex: resume uses exec resume with the thread before the prompt', () => {
    const { args } = AGENT_CLIS.codex.launch!({ prompt: 'again', server, tools: [], resume: 't1' });
    expect(args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(args.slice(-2)).toEqual(['t1', 'again']);
  });

  it('cursor is experimental: no headless launch', () => {
    expect(AGENT_CLIS.cursor.launch).toBeUndefined();
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
    expect(isTested('cursor', '2026.01.23-916f423')).toBe(false);
  });
});
