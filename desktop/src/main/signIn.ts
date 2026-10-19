// Starts an agent's own sign-in where the learner sees it (DESIGN §3.1). Codemm never reads, stores or types
// credentials: Claude Code's login runs in a terminal window (Terminal on a Mac, a console window on Windows), and
// Codex's and Cursor's open the browser. Every program starts from an argument array; the one file Codemm writes
// holds only quoted paths and a number.
import { spawn } from 'node:child_process';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import type { AgentId } from '../shared/api';
import type { Executable } from './agent/bridge';
import { POWERSHELL } from './windows';

export interface SignInDeps {
  platform: NodeJS.Platform;
  /** This app's executable, which runs Node-script agents. */
  runtime: string;
  tempDir(): string;
  write(file: string, text: string): void;
  /** The file's inode, through symlinks: an install that replaces the agent changes it. */
  inode(file: string): number;
  /** Starts a program on its own, without waiting for it. */
  start(file: string, args: string[], env?: Record<string, string>): Promise<void>;
}

const LOGIN: Record<AgentId, string[]> = { claude: ['auth', 'login'], codex: ['login'], cursor: ['login'] };
/** A POSIX shell word: the path, single-quoted. */
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** A Windows command-line word: a path with a space, double-quoted (Windows paths never hold a quote). */
const winQuote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
/**
 * Opens a program through the Windows shell, as a double-click does, so a console program gets a console window of
 * its own. The program and its arguments arrive as environment variables, never inside the command text.
 */
export const CONSOLE = 'Start-Process -FilePath $env:CODEMM_FILE -ArgumentList $env:CODEMM_ARGS';

export function agentSignIn(d: SignInDeps) {
  return async (id: AgentId, exe: Executable): Promise<void> => {
    const args = LOGIN[id];
    // Claude Code asks for its login in a terminal. On a Mac, Terminal runs a one-line script; on Windows, it opens
    // in a console window of its own. A program started straight from Codemm would have no window to show it in.
    if (id === 'claude' && d.platform === 'darwin') {
      const file = posix.join(d.tempDir(), 'Sign in to Claude Code.command');
      // A Node-script agent runs with this app as Node, as its jobs do.
      const command = exe.js ? `ELECTRON_RUN_AS_NODE=1 exec ${quote(d.runtime)} ${quote(exe.path)}` : `exec ${quote(exe.path)}`;
      // Terminal runs it a moment later: only the file Codemm allowed at Sign in runs, not one an install put there since.
      const pin = `[ "$(/usr/bin/stat -L -f %i ${quote(exe.path)})" = ${d.inode(exe.path)} ] || { echo 'Claude Code changed. Sign in again from Codemm.'; exit 1; }`;
      d.write(file, `#!/bin/sh\n${pin}\n${command} ${args.join(' ')}\n`);
      await d.start('/usr/bin/open', [file]);
      return;
    }
    if (id === 'claude' && d.platform === 'win32') {
      // Windows opens it at once, so nothing can replace the file in between, as Terminal's moment allows on a Mac.
      const [file, words, env] = exe.js ? [d.runtime, [exe.path, ...args], { ELECTRON_RUN_AS_NODE: '1' }] : [exe.path, args, {}];
      await d.start(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', CONSOLE], { CODEMM_FILE: file, CODEMM_ARGS: words.map(winQuote).join(' '), ...env });
      return;
    }
    if (exe.js) await d.start(d.runtime, [exe.path, ...args], { ELECTRON_RUN_AS_NODE: '1' });
    else await d.start(exe.path, args);
  };
}

export function nodeSignInDeps(runtime: string): SignInDeps {
  return {
    platform: process.platform,
    runtime,
    tempDir: () => mkdtempSync(join(tmpdir(), 'codemm-signin-')),
    write: (file, text) => writeFileSync(file, text, { mode: 0o700 }),
    inode: (file) => statSync(file).ino,
    start: (file, args, env) =>
      new Promise((resolve, reject) => {
        const child = spawn(file, args, { detached: true, stdio: 'ignore', env: { ...process.env, ...env } });
        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      }),
  };
}
