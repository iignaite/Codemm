#!/usr/bin/env node
// A stand-in for Claude Code in the journey's failure states (journey.spec.ts, JOURNEY_PART=fakes).
// It runs the real CLI (CODEMM_REAL_CLAUDE) unless the file CODEMM_FAKE_FILE names a failure:
//   signed-out          `auth status` says signed out
//   offline-research    the research turn fails on the network
//   plan-limit          every turn ends at a usage limit
//   infra-author        the author's save fails because Docker can't be reached; the agent keeps running
//   unstoppable-author  the author's saves fail, and a detached child keeps the output pipe open, so a
//                       cancel can't be confirmed (its pid goes to <CODEMM_FAKE_FILE>.pid for clean-up)
// Deleting the file is the learner fixing the problem.
const { spawn } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');

const args = process.argv.slice(2);
const file = process.env.CODEMM_FAKE_FILE;
const mode = file && existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
const prompt = args.includes('-p') ? args[args.indexOf('-p') + 1] : '';
const author = prompt.startsWith('You write one Codemm exercise');
const line = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const init = { type: 'system', subtype: 'init', session_id: 'fake-session', mcp_servers: [{ name: 'codemm', status: 'connected' }] };
const save = (id) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'mcp__codemm__save_exercise' }] } });
const failed = (id, text) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: text }] } });

if (mode === 'signed-out' && args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: false }));
} else if (mode === 'offline-research' && prompt.startsWith('You plan a Codemm course')) {
  line(init);
  line({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: Connection error. (getaddrinfo ENOTFOUND api.anthropic.com)' });
  process.exit(1);
} else if (mode === 'plan-limit' && prompt) {
  line(init);
  line({ type: 'result', subtype: 'error_during_execution', is_error: true, result: "You've hit your usage limit · resets 5pm" });
  process.exit(1);
} else if (mode === 'infra-author' && author) {
  line(init);
  line(save('a'));
  line(failed('a', 'No container runtime found. Install Docker Desktop for Mac (or Podman, experimental), start it and retry.'));
  setInterval(() => {}, 1000);
} else if (mode === 'unstoppable-author' && author) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  child.unref();
  writeFileSync(`${file}.pid`, String(child.pid));
  line(init);
  for (const id of ['a', 'b', 'c']) {
    line(save(id));
    line(failed(id, 'Invalid exercise: the reference solution fails test 1.'));
  }
  setInterval(() => {}, 1000);
} else {
  const real = spawn(process.env.CODEMM_REAL_CLAUDE, args, { stdio: 'inherit' });
  real.on('exit', (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 1)));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => real.kill(sig));
}
