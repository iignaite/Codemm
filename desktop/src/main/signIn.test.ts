// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentSignIn, CONSOLE, nodeSignInDeps, type SignInDeps } from './signIn';
import { tempDir } from './testing/temp';

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function fake(platform: NodeJS.Platform) {
  const started: { file: string; args: string[]; env?: Record<string, string> }[] = [];
  const written: { file: string; text: string }[] = [];
  const deps: SignInDeps = {
    platform,
    runtime: '/Applications/Codemm.app/Contents/MacOS/Codemm',
    tempDir: () => '/tmp/codemm-signin',
    write: (file, text) => void written.push({ file, text }),
    inode: () => 4242,
    start: async (file, args, env) => void started.push({ file, args, ...(env && Object.keys(env).length ? { env } : {}) }),
  };
  return { signIn: agentSignIn(deps), started, written };
}

describe("the agent's own sign-in, where the learner sees it", () => {
  it('Claude Code on a Mac: its login in a Terminal window, from a short script with the path quoted', async () => {
    const f = fake('darwin');
    await f.signIn('claude', { path: "/Users/o'neil/.local/bin/claude", js: false });
    const path = "'/Users/o'\\''neil/.local/bin/claude'";
    // Terminal runs it a moment later: only the file Codemm allowed at Sign in runs, not one an install put there since.
    const pin = `[ "$(/usr/bin/stat -L -f %i ${path})" = 4242 ] || { echo 'Claude Code changed. Sign in again from Codemm.'; exit 1; }`;
    expect(f.written).toEqual([{ file: '/tmp/codemm-signin/Sign in to Claude Code.command', text: `#!/bin/sh\n${pin}\nexec ${path} 'auth' 'login'\n` }]);
    expect(f.started).toEqual([{ file: '/usr/bin/open', args: ['/tmp/codemm-signin/Sign in to Claude Code.command'] }]);
  });

  it('a Node-script Claude Code on a Mac signs in with this app as Node, in Terminal too', async () => {
    const f = fake('darwin');
    await f.signIn('claude', { path: '/lib/node_modules/@anthropic-ai/claude-code/cli.js', js: true });
    expect(f.written[0].text.split('\n').slice(1, 3)).toEqual([
      `[ "$(/usr/bin/stat -L -f %i '/lib/node_modules/@anthropic-ai/claude-code/cli.js')" = 4242 ] || { echo 'Claude Code changed. Sign in again from Codemm.'; exit 1; }`,
      "ELECTRON_RUN_AS_NODE='1' exec '/Applications/Codemm.app/Contents/MacOS/Codemm' '/lib/node_modules/@anthropic-ai/claude-code/cli.js' 'auth' 'login'",
    ]);
  });

  it('Claude Code on Windows: its login in its own console window, which Windows opens as for a double-click', async () => {
    const f = fake('win32');
    await f.signIn('claude', { path: 'C:\\Users\\Ann Lee\\.local\\bin\\claude.exe', js: false });
    // The path reaches PowerShell as an environment variable, never inside the command text.
    expect(f.started).toEqual([
      { file: POWERSHELL, args: ['-NoProfile', '-NonInteractive', '-Command', CONSOLE], env: { CODEMM_FILE: 'C:\\Users\\Ann Lee\\.local\\bin\\claude.exe', CODEMM_ARGS: 'auth login' } },
    ]);
    // The Windows shell opens it, so a console program gets a window of its own.
    expect(CONSOLE).toContain("New-Object Diagnostics.ProcessStartInfo $env:CODEMM_FILE, $env:CODEMM_ARGS; $i.UseShellExecute = $true");
    expect(f.written).toEqual([]);
  });

  it('a Node-script Claude Code on Windows runs with this app as Node, its path quoted', async () => {
    const f = fake('win32');
    await f.signIn('claude', { path: 'C:\\Users\\Ann Lee\\AppData\\Roaming\\npm\\node_modules\\cli.js', js: true });
    expect(f.started[0].env).toEqual({
      CODEMM_FILE: '/Applications/Codemm.app/Contents/MacOS/Codemm',
      CODEMM_ARGS: '"C:\\Users\\Ann Lee\\AppData\\Roaming\\npm\\node_modules\\cli.js" auth login',
      ELECTRON_RUN_AS_NODE: '1',
    });
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

  it("Cursor on Windows: its login runs Cursor's own Node on its script, with no shell", async () => {
    const f = fake('win32');
    const node = 'C:\\Users\\Ann Lee\\AppData\\Local\\cursor-agent\\versions\\2026.10.22-27dcf5f\\node.exe';
    const script = 'C:\\Users\\Ann Lee\\AppData\\Local\\cursor-agent\\versions\\2026.10.22-27dcf5f\\index.js';
    await f.signIn('cursor', { path: node, js: false, args: [script], env: { CURSOR_INVOKED_AS: 'cursor-agent.cmd' } });
    expect(f.started).toEqual([{ file: node, args: [script, 'login'], env: { CURSOR_INVOKED_AS: 'cursor-agent.cmd' } }]);
  });

  it("Claude Code's Terminal script on a Mac quotes the words and environment before its arguments", async () => {
    const f = fake('darwin');
    await f.signIn('claude', { path: '/opt/node', js: false, args: ['/opt/claude cli.js'], env: { X: '$(id) a' } });
    expect(f.written[0].text.split('\n')[2]).toBe("X='$(id) a' exec '/opt/node' '/opt/claude cli.js' 'auth' 'login'");
  });

  it("Claude Code's console window on Windows keeps the words before its arguments", async () => {
    const f = fake('win32');
    await f.signIn('claude', { path: 'C:\\node.exe', js: false, args: ['C:\\Program Files\\claude\\cli.js'], env: { X: '1' } });
    expect(f.started[0].env).toEqual({ CODEMM_FILE: 'C:\\node.exe', CODEMM_ARGS: '"C:\\Program Files\\claude\\cli.js" auth login', X: '1' });
  });

  it('a Node-script agent runs with this app as Node, as jobs do', async () => {
    const f = fake('darwin');
    await f.signIn('codex', { path: '/lib/node_modules/@openai/codex/bin/codex.js', js: true });
    expect(f.started).toEqual([{ file: '/Applications/Codemm.app/Contents/MacOS/Codemm', args: ['/lib/node_modules/@openai/codex/bin/codex.js', 'login'], env: { ELECTRON_RUN_AS_NODE: '1' } }]);
  });
});

describe.runIf(process.platform === 'win32')('on this Windows, for real', () => {
  it('opens a Node-script agent through PowerShell, its path with a space quoted, with this app as Node', { timeout: 60_000 }, async () => {
    // CI's Windows machine: Node stands in for this app, and the script for the agent's login.
    const dir = join(tempDir('codemm-signin-'), 'Ann Lee');
    mkdirSync(dir);
    const script = join(dir, 'cli.js');
    const out = join(dir, 'ran.json');
    writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))`);
    await agentSignIn(nodeSignInDeps(process.execPath))('claude', { path: script, js: true });
    for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 300));
    // If it never ran, PowerShell's own words say why.
    const why = () => {
      const env = { ...process.env, CODEMM_FILE: process.execPath, CODEMM_ARGS: `"${script}" auth login` };
      const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', CONSOLE], { env, encoding: 'utf8', timeout: 30_000 });
      return `PowerShell exit ${r.status}: ${r.stdout}${r.stderr}${r.error ?? ''}`;
    };
    expect(existsSync(out), existsSync(out) ? '' : why()).toBe(true);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(['auth', 'login']);
  });
});
