// Starts an agent's own sign-in where the learner sees it (DESIGN §3.1). Codemm never reads, stores or types
// credentials: Claude Code's login runs in a terminal window (Terminal on a Mac, a console window on Windows), and
// Codex's and Cursor's open the browser. Every program starts from an argument array; the one file Codemm writes
// holds only quoted paths and a number.
import { spawn } from 'node:child_process';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import type { AgentId } from '../shared/api';
import { command, type Executable } from './agent/bridge';
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
 * its own. The program and its arguments arrive as environment variables, never inside the command text. .NET's
 * Process.Start, as Docker's elevated install uses (dockerDesktop.ts).
 */
export const CONSOLE = '$i = New-Object Diagnostics.ProcessStartInfo $env:CODEMM_FILE, $env:CODEMM_ARGS; $i.UseShellExecute = $true; $null = [Diagnostics.Process]::Start($i)';

export function agentSignIn(d: SignInDeps) {
  return async (id: AgentId, exe: Executable): Promise<void> => {
    const args = LOGIN[id];
    // Claude Code asks for its login in a terminal. On a Mac, Terminal runs a one-line script; on Windows, it opens
    // in a console window of its own. A program started straight from Codemm would have no window to show it in.
    if (id === 'claude' && d.platform === 'darwin') {
      const file = posix.join(d.tempDir(), 'Sign in to Claude Code.command');
      // A Node-script agent runs with this app as Node, as its jobs do.
      const c = command(exe, [], d.runtime);
      const env = Object.entries(c.env).map(([k, v]) => `${k}=${/^\w+$/.test(v) ? v : quote(v)} `).join('');
      const line = `${env}exec ${[c.file, ...c.args].map(quote).join(' ')}`;
      // Terminal runs it a moment later: only the file Codemm allowed at Sign in runs, not one an install put there since.
      const pin = `[ "$(/usr/bin/stat -L -f %i ${quote(exe.path)})" = ${d.inode(exe.path)} ] || { echo 'Claude Code changed. Sign in again from Codemm.'; exit 1; }`;
      d.write(file, `#!/bin/sh\n${pin}\n${line} ${args.join(' ')}\n`);
      await d.start('/usr/bin/open', [file]);
      return;
    }
    if (id === 'claude' && d.platform === 'win32') {
      // Windows opens it at once, so nothing can replace the file in between, as Terminal's moment allows on a Mac.
      const c = command(exe, args, d.runtime);
      await d.start(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', CONSOLE], { CODEMM_FILE: c.file, CODEMM_ARGS: c.args.map(winQuote).join(' '), ...c.env });
      return;
    }
    // Cursor on Windows: its own Node on its script, never its PowerShell launcher (§3.1).
    const c = command(exe, args, d.runtime);
    if (Object.keys(c.env).length) await d.start(c.file, c.args, c.env);
    else await d.start(c.file, c.args);
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
        // On Windows, a detached program has no console at all, and one Codemm started shows none: hidden, it ends on its
        // own (PowerShell, once it has opened the agent's console window).
        const child = spawn(file, args, { detached: process.platform !== 'win32', windowsHide: true, stdio: 'ignore', env: { ...process.env, ...env } });
        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      }),
  };
}
