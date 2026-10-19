// @vitest-environment node
import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { JOBS, runJob, type Job } from './jobs';
import { tempDir } from '../testing/temp';

/** A fake Claude Code: a Node script that replays stream-json lines, the way recorded fixtures do. */
function fakeAgent(lines: object[], { exitCode = 0, hang = false, stderr = [] as string[] } = {}) {
  const dir = tempDir('codemm-agent-');
  const script = join(dir, 'claude.js');
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(join(dir, 'runs'))}, JSON.stringify(process.argv.slice(2)) + '\\n');
fs.appendFileSync(${JSON.stringify(join(dir, 'cwds'))}, process.cwd() + '\\n');
for (const l of ${JSON.stringify(lines.map((l) => JSON.stringify(l)))}) console.log(l);
for (const l of ${JSON.stringify(stderr)}) console.error(l);
${hang ? 'setInterval(() => {}, 1000);' : `process.exit(${exitCode});`}`,
  );
  const runs = () => {
    try {
      return require('node:fs').readFileSync(join(dir, 'runs'), 'utf8').trim().split('\n').filter(Boolean).length as number;
    } catch {
      return 0;
    }
  };
  const argv = () => JSON.parse(require('node:fs').readFileSync(join(dir, 'runs'), 'utf8').trim().split('\n')[0]) as string[];
  const cwds = () => require('node:fs').readFileSync(join(dir, 'cwds'), 'utf8').trim().split('\n') as string[];
  return { exe: { path: script, js: true }, runs, argv, cwds };
}

const init = { type: 'system', subtype: 'init', session_id: 's1' };
const say = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const call = (id: string, name: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__codemm__${name}` }] } });
const result = (id: string, error: boolean) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error }] } });
const success = { type: 'result', subtype: 'success', is_error: false };
const failure = (text: string) => ({ type: 'result', subtype: 'error_during_execution', is_error: true, result: text });

function job(exe: Job['exe'], over: Partial<Job> = {}): Job {
  return {
    kind: 'tutor',
    agent: 'claude',
    exe,
    runtime: process.execPath,
    brief: 'Help.',
    server: (tools) => ({ command: '/app', args: ['cli.js', 'mcp', '--tools', tools.join(',')] }),
    cwd: tmpdir(),
    done: (turn) => turn.ok,
    signedIn: async () => true,
    ...over,
  };
}

describe('jobs (§3.2)', () => {
  it('a tutor turn is done when it ends without error, and keeps its session and text', async () => {
    const agent = fakeAgent([init, say('Look at line 3.'), success]);
    expect(await runJob(job(agent.exe))).toEqual({ ok: true, session: 's1', text: ['Look at line 3.'] });
  });

  it('reports what the run used, with its session', async () => {
    const used = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.05, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 7 } };
    const agent = fakeAgent([init, say('Done.'), used]);
    const reports: unknown[] = [];
    await runJob(job(agent.exe, { onUsage: (u) => reports.push(u) }));
    expect(reports).toEqual([{ input: 100, output: 7, cachedInput: 90, costUsd: 0.05, session: 's1' }]);
  });

  it('counts a fetched page as a source only once its fetch succeeds', async () => {
    const fetch = (id: string, url: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'WebFetch', input: { url } }] } });
    const agent = fakeAgent([init, fetch('f1', 'https://good.example/a'), result('f1', false), fetch('f2', 'https://bad.example/b'), result('f2', true), success]);
    const sources: unknown[] = [];
    const steps: unknown[] = [];
    await runJob(job(agent.exe, { kind: 'research', done: () => true, onEvent: (e) => e.type === 'progress' && steps.push(e.step), onSource: (s) => sources.push(s) }));
    expect(steps).toHaveLength(2);
    expect(sources).toEqual([{ title: 'good.example/a', url: 'https://good.example/a' }]);
  });

  it('launches with only the job tools on the server and in the allowed list', async () => {
    const agent = fakeAgent([init, success]);
    let server: string[] = [];
    await runJob(job(agent.exe, { kind: 'lesson', server: (tools) => ((server = tools), { command: '/app', args: [] }), done: () => true }));
    expect(server).toEqual(JOBS.lesson.tools);
  });

  it('is done only when its check against core records passes, never on the agent\'s word', async () => {
    const agent = fakeAgent([init, say('Saved!'), success]);
    const outcome = await runJob(job(agent.exe, { kind: 'lesson', done: () => false }));
    expect(outcome).toMatchObject({ ok: false, problem: 'failed' });
    expect(agent.runs()).toBe(2);
  });

  it('tells its listener each event and each relaunch, for its progress (§4.11)', async () => {
    const agent = fakeAgent([init, say('Saved!'), success]);
    const heard: string[] = [];
    await runJob(job(agent.exe, { kind: 'lesson', done: () => false, onEvent: (e) => heard.push(e.type), onRelaunch: () => heard.push('relaunch') }));
    expect(heard).toEqual(['session', 'text', 'done', 'relaunch', 'session', 'text', 'done']);
  });

  it('is not relaunched when its save landed just before a crash', async () => {
    const agent = fakeAgent([init], { exitCode: 1 });
    let saved = false;
    const outcome = await runJob(job(agent.exe, { kind: 'author', done: () => ((saved = true), saved) }));
    expect(outcome.ok).toBe(true);
    expect(agent.runs()).toBe(1);
  });

  it('recognizes a plan limit, never relaunches, and spends no retry', async () => {
    const agent = fakeAgent([init, failure("You've hit your usage limit. Try again at 5pm.")]);
    expect(await runJob(job(agent.exe))).toMatchObject({ ok: false, problem: 'plan-limit' });
    expect(agent.runs()).toBe(1);
  });

  it("an agent that can't reach its service is offline: no relaunch, no retry spent", async () => {
    let asked = false;
    const agent = fakeAgent([init, failure('API Error: Connection error. (getaddrinfo ENOTFOUND api.anthropic.com)')], { exitCode: 1 });
    expect(await runJob(job(agent.exe, { signedIn: async () => ((asked = true), true) }))).toMatchObject({ ok: false, problem: 'offline' });
    expect([agent.runs(), asked]).toEqual([1, false]);
  });

  it("a save that can't reach the network is offline, not a plain infrastructure failure", async () => {
    const offline = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: "codemm:offline\nThe track build couldn't reach the network (Could not resolve host: deb.debian.org), so nothing was installed." }] } };
    const agent = fakeAgent([init, call('a', 'save_exercise'), offline], { hang: true });
    expect(await runJob(job(agent.exe, { kind: 'author', done: () => false }))).toMatchObject({ ok: false, problem: 'offline', cause: 'offline' });
    expect(agent.runs()).toBe(1);
  });

  it('a stopped attempt keeps its own reason when its cleanup fails too', async () => {
    const offline = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: "codemm:offline\nThe track build couldn't reach the network (Could not resolve host: deb.debian.org), so nothing was installed." }] } };
    const agent = fakeAgent([init, call('a', 'save_exercise'), offline], { hang: true });
    const cleanup = async () => { throw new Error('Docker stopped.'); };
    expect(await runJob(job(agent.exe, { kind: 'author', done: () => false, cleanup }))).toMatchObject({ ok: false, problem: 'offline' });
  });

  it('reports a sign-out when a failed job finds the agent signed out', async () => {
    const agent = fakeAgent([init, failure('Invalid API key')]);
    expect(await runJob(job(agent.exe, { signedIn: async () => false }))).toMatchObject({ ok: false, problem: 'signed-out' });
    expect(agent.runs()).toBe(1);
  });

  it('cancels after 3 failed saves', async () => {
    const lines = [init, call('a', 'save_exercise'), result('a', true), call('b', 'save_exercise'), result('b', true), call('c', 'save_exercise'), result('c', true)];
    const agent = fakeAgent(lines, { hang: true });
    const started = Date.now();
    expect(await runJob(job(agent.exe, { kind: 'author', done: () => false }))).toMatchObject({ ok: false, problem: 'failed' });
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('never launches once it was cancelled', async () => {
    const agent = fakeAgent([init, success]);
    const outcome = await runJob(job(agent.exe, { signal: AbortSignal.abort(), done: () => false }));
    expect(outcome).toMatchObject({ ok: false, problem: 'failed' });
    expect(agent.runs()).toBe(0);
  });

  it('a turn that says it succeeded but exits with an error is not a success', async () => {
    const agent = fakeAgent([init, say('Done.'), success], { exitCode: 42 });
    expect(await runJob(job(agent.exe))).toMatchObject({ ok: false, problem: 'failed' });
  });

  it('a Codemm server that failed to start is an infrastructure failure: no relaunch', async () => {
    const failedServer = { ...init, mcp_servers: [{ name: 'codemm', status: 'failed' }] };
    // A real agent keeps running its turn without tools; the job cancels it. (One that has already exited
    // can't be confirmed stopped on Windows, which the bridge tests cover.)
    const agent = fakeAgent([failedServer, say('I have no tools.')], { hang: true });
    expect(await runJob(job(agent.exe, { kind: 'lesson', done: () => false }))).toMatchObject({ ok: false, problem: 'infra' });
    expect(agent.runs()).toBe(1);
  });

  it('an agent that exits before it starts (Codex with a required server that failed) is not relaunched', async () => {
    const agent = fakeAgent([], { exitCode: 1 });
    expect(await runJob(job(agent.exe, { kind: 'lesson', done: () => false }))).toMatchObject({ ok: false, problem: 'infra' });
    expect(agent.runs()).toBe(1);
  });

  it('a save that fails on Docker or disk stops the job without a relaunch, and names which', async () => {
    const docker = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: "codemm:runtime-down\nThe container runtime isn't running. Start Docker Desktop." }] } };
    const agent = fakeAgent([init, call('a', 'save_exercise'), docker], { hang: true });
    const started = Date.now();
    expect(await runJob(job(agent.exe, { kind: 'author', done: () => false }))).toMatchObject({ ok: false, problem: 'docker', cause: 'runtime-down' });
    expect(agent.runs()).toBe(1);
    expect(Date.now() - started).toBeLessThan(15_000);

    // Docker that is up but slow isn't called stopped.
    const slow = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: "codemm:runtime-busy\nThe container runtime isn't answering. It may be busy." }] } };
    const busy = fakeAgent([init, call('a', 'save_exercise'), slow], { hang: true });
    expect(await runJob(job(busy.exe, { kind: 'author', done: () => false }))).toMatchObject({ ok: false, problem: 'docker-busy', cause: 'runtime-busy' });
    expect(busy.runs()).toBe(1);

    const disk = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'codemm:host-disk\nNot enough disk space to build the track.' }] } };
    const full = fakeAgent([init, call('a', 'save_exercise'), disk], { hang: true });
    expect(await runJob(job(full.exe, { kind: 'author', done: () => false }))).toMatchObject({ ok: false, problem: 'disk' });
    expect(full.runs()).toBe(1);
  });

  it("a failed save that only quotes Docker's words, without core's code, is the agent's to fix", async () => {
    const quoted = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: "Example 1 didn't run cleanly (exit 1):\nCannot connect to the Docker daemon" }] } };
    const agent = fakeAgent([init, call('a', 'save_lesson'), quoted, { type: 'result', subtype: 'success', is_error: false, result: 'done' }]);
    expect(await runJob(job(agent.exe, { kind: 'lesson', done: () => false }))).toMatchObject({ ok: false, problem: 'failed' });
  });

  it('a save that fails on a track image needing a rebuild stops the job without a relaunch, and says to rebuild', async () => {
    const image = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'codemm:image-missing\nThe image for py@1 is missing or changed. Run `codemm track rebuild py@1`, then retry.' }] } };
    const agent = fakeAgent([init, call('a', 'save_exercise'), image], { hang: true });
    expect(await runJob(job(agent.exe, { kind: 'author', done: () => false }))).toMatchObject({ ok: false, problem: 'rebuild' });
    expect(agent.runs()).toBe(1);
  });

  it("gives Codex's tool calls the job's deadline", async () => {
    const agent = fakeAgent([{ type: 'thread.started', thread_id: 't' }, { type: 'turn.completed' }]);
    await runJob(job(agent.exe, { agent: 'codex', kind: 'author', done: () => true }));
    expect(agent.argv()).toContain('mcp_servers.codemm.tool_timeout_sec=900');
  });

  it('never relaunches once another job found its agent unstoppable', async () => {
    const agent = fakeAgent([init, success]);
    let blocked = false;
    const outcome = await runJob(job(agent.exe, { kind: 'lesson', done: () => false, blocked: () => blocked, signedIn: async () => ((blocked = true), true) }));
    expect(outcome).toMatchObject({ ok: false, problem: 'unstoppable' });
    expect(agent.runs()).toBe(1);
  });

  it('launches nothing of an agent Codemm started installing again, the relaunch included (§3.1)', async () => {
    const agent = fakeAgent([init, success]);
    expect(await runJob(job(agent.exe, { kind: 'lesson', usable: () => false }))).toMatchObject({ ok: false, problem: 'signed-out' });
    expect(agent.runs()).toBe(0);
    let usable = true;
    const outcome = await runJob(job(agent.exe, { kind: 'lesson', done: () => false, usable: () => usable, signedIn: async () => ((usable = false), true) }));
    expect(outcome).toMatchObject({ ok: false, problem: 'signed-out' });
    expect(agent.runs()).toBe(1);
  });

  it('cursor: runs in a Codemm-owned folder holding only its config, the same folder for the same config (so a chat resumes)', async () => {
    const agentDir = tempDir('codemm-agents-');
    const ws = tempDir('codemm-ws-');
    const cursorInit = { type: 'system', subtype: 'init', session_id: 'chat-1' };
    const agent = fakeAgent([cursorInit, success]);
    expect(await runJob(job(agent.exe, { agent: 'cursor', cwd: ws, agentDir }))).toMatchObject({ ok: true, session: 'chat-1' });
    await runJob(job(agent.exe, { agent: 'cursor', cwd: ws, agentDir, resume: 'chat-1' }));
    const [first, second] = agent.cwds().map((d) => realpathSync(d));
    expect(first).toBe(second);
    expect(dirname(first)).toBe(realpathSync(agentDir));
    expect(readdirSync(join(first, '.cursor')).sort()).toEqual(['cli.json', 'mcp.json']);
    expect(JSON.parse(readFileSync(join(first, '.cursor', 'mcp.json'), 'utf8')).mcpServers.codemm.args).toContain(JOBS.tutor.tools.join(','));
    // The workspace gets no agent config.
    expect(readdirSync(ws)).toEqual([]);
    await runJob(job(agent.exe, { agent: 'cursor', kind: 'lesson', cwd: ws, agentDir, done: () => true }));
    expect(new Set(agent.cwds()).size).toBe(2);
  });

  it('cursor: a plan limit on stderr ends the job without a relaunch', async () => {
    const agent = fakeAgent([{ type: 'system', subtype: 'init', session_id: 'chat-1' }], { exitCode: 1, stderr: ["Error: You've hit your usage limit"] });
    const agentDir = tempDir('codemm-agents-');
    expect(await runJob(job(agent.exe, { agent: 'cursor', agentDir }))).toMatchObject({ ok: false, problem: 'plan-limit' });
    expect(agent.runs()).toBe(1);
  });

  it("removes an ended attempt's abandoned containers before relaunching it, and again before finishing", async () => {
    const agent = fakeAgent([init], { hang: true });
    const order: string[] = [];
    const outcome = await runJob(job(agent.exe, { deadlineMs: 300, done: () => false, onRelaunch: () => void order.push('relaunch'), cleanup: async () => void order.push('cleanup') }));
    expect(outcome).toMatchObject({ ok: false, problem: 'failed' });
    expect(order).toEqual(['cleanup', 'relaunch', 'cleanup']);
  });

  it("a cancel finishes only after the cancelled attempt's containers are removed", async () => {
    const agent = fakeAgent([init], { hang: true });
    const stop = new AbortController();
    let finishCleanup!: () => void;
    const cleanup = vi.fn(() => new Promise<void>((r) => (finishCleanup = r)));
    let done = false;
    const running = runJob(job(agent.exe, { signal: stop.signal, done: () => false, cleanup })).then(() => (done = true));
    await vi.waitFor(() => expect(agent.runs()).toBe(1));
    stop.abort();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    finishCleanup();
    await running;
    expect(agent.runs()).toBe(1);
  });

  it("never relaunches an ended attempt whose containers couldn't be removed, and says it's Docker's doing", async () => {
    const agent = fakeAgent([init], { hang: true });
    const slow = Object.assign(new Error("1 abandoned container couldn't be removed."), { name: 'CodemmError', kind: 'docker', code: 'container-remove' });
    const outcome = await runJob(job(agent.exe, { deadlineMs: 300, done: () => false, cleanup: async () => { throw slow; } }));
    expect(outcome).toMatchObject({ ok: false, problem: 'docker-busy', cause: 'container-remove' });
    expect(agent.runs()).toBe(1);
    const other = fakeAgent([init], { hang: true });
    expect(await runJob(job(other.exe, { deadlineMs: 300, done: () => false, cleanup: async () => { throw new Error('boom'); } }))).toMatchObject({ ok: false, problem: 'docker-failed', cause: 'other' });
  });

  it('stops at its deadline', async () => {
    const agent = fakeAgent([init], { hang: true });
    expect(await runJob(job(agent.exe, { deadlineMs: 300, done: () => false }))).toMatchObject({ ok: false, problem: 'failed' });
  });
});
