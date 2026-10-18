#!/usr/bin/env node
// A fake cursor-agent for the journey, for when Cursor's own plan is used up: it speaks Cursor's
// stream-json (as recorded from cursor-agent 2026.10.16) and has real Claude Code do the work.
// It reads the job folder's .cursor/mcp.json and .cursor/cli.json exactly as cursor-agent does,
// so Codemm's Cursor adapter, job folder and parser run end to end. CODEMM_REAL_CLAUDE names Claude Code.
const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const args = process.argv.slice(2);
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (args[0] === '--version') {
  console.log('2026.10.16-e3cb207');
  process.exit(0);
}
if (args[0] === 'status') {
  console.log('\n ✓ Logged in as journey@example.test');
  process.exit(0);
}
if (!args.includes('-p')) {
  console.error('fake cursor-agent: only --version, status and -p are supported');
  process.exit(2);
}

const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const prompt = args.at(-1);
const resume = flag('--resume');
const web = args.includes('--force');
const { mcpServers } = JSON.parse(readFileSync(join(process.cwd(), '.cursor', 'mcp.json'), 'utf8'));
const { permissions } = JSON.parse(readFileSync(join(process.cwd(), '.cursor', 'cli.json'), 'utf8'));
const tools = permissions.allow.flatMap((p) => {
  const m = /^Mcp\(codemm:(.+)\)$/.exec(p);
  return m ? [`mcp__codemm__${m[1]}`] : [];
});

const claudeArgs = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', 'sonnet'];
claudeArgs.push('--tools', web ? 'WebSearch,WebFetch' : '', '--mcp-config', JSON.stringify({ mcpServers }), '--strict-mcp-config');
if (tools.length) claudeArgs.push('--allowedTools', tools.join(','));
if (resume) claudeArgs.push('--resume', resume);

const child = spawn(process.env.CODEMM_REAL_CLAUDE || 'claude', claudeArgs, { stdio: ['ignore', 'pipe', 'inherit'] });
const calls = new Map();
let session = '';
let buffer = '';

function translate(e) {
  if (e.type === 'system' && e.subtype === 'init') {
    session = e.session_id;
    out({ type: 'system', subtype: 'init', apiKeySource: 'login', cwd: process.cwd(), session_id: session, model: 'Auto', permissionMode: 'default' });
    return;
  }
  if (e.type === 'result') {
    const ok = e.subtype === 'success' && !e.is_error;
    out({ type: 'result', subtype: ok ? 'success' : 'error', is_error: !ok, duration_ms: e.duration_ms ?? 0, result: String(e.result ?? ''), session_id: session });
    return;
  }
  const content = e.message?.content;
  if (!Array.isArray(content)) return;
  for (const c of content) {
    if (c?.type === 'text' && e.type === 'assistant') {
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: c.text }] }, session_id: session });
    } else if (c?.type === 'tool_use') {
      const m = /^mcp__(.+?)__(.+)$/.exec(c.name);
      const call = m
        ? { mcpToolCall: { args: { name: `${m[1]}-${m[2]}`, args: c.input ?? {}, toolCallId: c.id, providerIdentifier: m[1], toolName: m[2] } } }
        : { [`${c.name[0].toLowerCase()}${c.name.slice(1)}ToolCall`]: { args: c.input ?? {} } };
      calls.set(c.id, call);
      out({ type: 'tool_call', subtype: 'started', call_id: c.id, tool_call: call, session_id: session });
    } else if (c?.type === 'tool_result') {
      const call = calls.get(c.tool_use_id);
      if (!call) continue;
      const text = typeof c.content === 'string' ? c.content : (c.content ?? []).map((p) => p?.text ?? '').join('\n');
      const [kind] = Object.keys(call);
      const result = kind === 'mcpToolCall'
        ? c.is_error ? { error: { error: text } } : { success: { content: [{ text: { text } }] } }
        : c.is_error ? { error: { error: text } } : { success: {} };
      out({ type: 'tool_call', subtype: 'completed', call_id: c.tool_use_id, tool_call: { [kind]: { ...call[kind], result } }, session_id: session });
    }
  }
}

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    try {
      translate(JSON.parse(line));
    } catch {
      // not a JSON line
    }
  }
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('close', (code) => process.exit(code ?? 1));
