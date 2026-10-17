// @vitest-environment node
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JOBS, runJob, type Job } from './jobs';

/** A fake Claude Code: a Node script that replays stream-json lines, the way recorded fixtures do. */
function fakeAgent(lines: object[], { exitCode = 0, hang = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codemm-agent-'));
  const script = join(dir, 'claude.js');
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(join(dir, 'runs'))}, JSON.stringify(process.argv.slice(2)) + '\\n');
for (const l of ${JSON.stringify(lines.map((l) => JSON.stringify(l)))}) console.log(l);
${hang ? 'setInterval(() => {}, 1000);' : `process.exit(${exitCode});`}`,
  );
  const runs = () => {
    try {
      return require('node:fs').readFileSync(join(dir, 'runs'), 'utf8').trim().split('\n').filter(Boolean).length as number;
    } catch {
      return 0;
    }
  };
  return { exe: { path: script, js: true }, runs };
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

  it('stops at its deadline', async () => {
    const agent = fakeAgent([init], { hang: true });
    expect(await runJob(job(agent.exe, { deadlineMs: 300, done: () => false }))).toMatchObject({ ok: false, problem: 'failed' });
  });
});
