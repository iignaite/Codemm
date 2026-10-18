// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { agentSignIn, type SignInDeps } from './signIn';

function fake(platform: NodeJS.Platform) {
  const started: { file: string; args: string[]; env?: Record<string, string> }[] = [];
  const written: { file: string; text: string }[] = [];
  const deps: SignInDeps = {
    platform,
    runtime: '/Applications/Codemm.app/Contents/MacOS/Codemm',
    tempDir: () => '/tmp/codemm-signin',
    write: (file, text) => void written.push({ file, text }),
    start: async (file, args, env) => void started.push({ file, args, ...(env ? { env } : {}) }),
  };
  return { signIn: agentSignIn(deps), started, written };
}

describe("the agent's own sign-in, where the learner sees it", () => {
  it('Claude Code on a Mac: its login in a Terminal window, from a one-line script with the path quoted', async () => {
    const f = fake('darwin');
    await f.signIn('claude', { path: "/Users/o'neil/.local/bin/claude", js: false });
    expect(f.written).toEqual([{ file: '/tmp/codemm-signin/Sign in to Claude Code.command', text: "#!/bin/sh\nexec '/Users/o'\\''neil/.local/bin/claude' auth login\n" }]);
    expect(f.started).toEqual([{ file: 'open', args: ['/tmp/codemm-signin/Sign in to Claude Code.command'] }]);
  });

  it('Claude Code on Windows: its login in its own console window', async () => {
    const f = fake('win32');
    await f.signIn('claude', { path: 'C:\\Users\\me\\.local\\bin\\claude.exe', js: false });
    expect(f.started).toEqual([{ file: 'C:\\Users\\me\\.local\\bin\\claude.exe', args: ['auth', 'login'] }]);
    expect(f.written).toEqual([]);
  });

  it('Codex and Cursor: their login opens the browser', async () => {
    const f = fake('darwin');
    await f.signIn('codex', { path: '/Users/me/.local/bin/codex', js: false });
    await f.signIn('cursor', { path: '/Users/me/.local/bin/cursor-agent', js: false });
    expect(f.started).toEqual([
      { file: '/Users/me/.local/bin/codex', args: ['login'] },
      { file: '/Users/me/.local/bin/cursor-agent', args: ['login'] },
    ]);
  });

  it('a Node-script agent runs with this app as Node, as jobs do', async () => {
    const f = fake('darwin');
    await f.signIn('codex', { path: '/lib/node_modules/@openai/codex/bin/codex.js', js: true });
    expect(f.started).toEqual([{ file: '/Applications/Codemm.app/Contents/MacOS/Codemm', args: ['/lib/node_modules/@openai/codex/bin/codex.js', 'login'], env: { ELECTRON_RUN_AS_NODE: '1' } }]);
  });
});
