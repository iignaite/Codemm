// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { AgentId } from '../shared/api';
import type { Executable } from './agent/bridge';
import { agentInstaller, isAgentHost, type AgentInstallDeps } from './agentInstall';
import { OfflineError } from './download';

const GiB = 1024 ** 3;
const SUM = 'a'.repeat(64);
const MANIFEST = JSON.stringify({ version: '2.1.302', platforms: { 'darwin-arm64': { checksum: SUM, size: 10 }, 'win32-x64': { checksum: SUM, size: 10 } } });

type Call = { file: string; args: string[]; env?: Record<string, string> };

function fake(
  platform: NodeJS.Platform,
  over: Partial<AgentInstallDeps> & { answers?: Record<string, { code: number | null; output: string }>; texts?: Record<string, string>; found?: (bin: string) => Executable } = {},
) {
  const calls: Call[] = [];
  const downloads: { url: string; file: string; allowed: boolean }[] = [];
  const removed: string[] = [];
  const executable: string[] = [];
  const caps: (number | undefined)[] = [];
  const timeouts: (number | undefined)[] = [];
  let installed = false;
  const texts: Record<string, string> = { latest: '2.1.302\n', 'manifest.json': MANIFEST, ...over.texts };
  const answer = (file: string, args: string[]) => {
    const key = [file, ...args].join(' ');
    for (const [prefix, value] of Object.entries(over.answers ?? {})) if (key.startsWith(prefix)) return value;
    if (file === '/usr/bin/codesign') return { code: 0, output: '' };
    if (file.endsWith('powershell.exe') && args.includes('-Command')) return { code: 0, output: 'Valid|CN="Anthropic, PBC", O="Anthropic, PBC", L=San Francisco, S=California, C=US\n' };
    return { code: 0, output: '' };
  };
  const deps: AgentInstallDeps = {
    platform,
    arch: platform === 'win32' ? 'x64' : 'arm64',
    tempDir: () => (platform === 'win32' ? 'C:\\Temp\\codemm-agent' : '/tmp/codemm-agent'),
    freeBytes: async () => 50 * GiB,
    download: async (url, file, progress, allowed, maxBytes) => {
      downloads.push({ url, file, allowed: allowed ? allowed(url) : false });
      caps.push(maxBytes);
      progress(1);
    },
    run: async (file, args, opts) => {
      calls.push({ file, args, ...(opts?.env ? { env: opts.env } : {}) });
      timeouts.push(opts?.timeoutMs);
      const a = answer(file, args);
      // The agent's own install step puts it where find() looks.
      if (a.code === 0 && (args[0] === 'install' || file === '/bin/sh' || file === '/bin/bash' || args.includes('-File'))) installed = true;
      return a;
    },
    launch: async () => undefined,
    exists: () => false,
    remove: (path) => void removed.push(path),
    now: () => 1_000,
    readText: (file) => texts[file.split(/[\\/]/).pop()!] ?? '',
    sha256: async () => SUM,
    makeExecutable: (file) => void executable.push(file),
    realpath: (file) => file.replace('/.local/bin/codex', '/.codex/packages/standalone/current/codex'),
    find: (bin) => (installed ? (over.found?.(bin) ?? { path: `/Users/me/.local/bin/${bin}`, js: false }) : null),
    ...over,
  };
  return { install: agentInstaller(deps), calls, downloads, removed, executable, caps, timeouts };
}

const commands = (calls: Call[]) => calls.map((c) => [c.file, ...c.args].join(' '));
const run = async (f: ReturnType<typeof fake>, id: AgentId) => {
  f.install.install(id);
  await f.install.done(id);
  return f.install.status(id);
};

describe('installing an agent for the learner', () => {
  it('Claude Code on a Mac: the official binary, checked against the release manifest and Anthropic\'s signature, then its own install', async () => {
    const f = fake('darwin');
    expect(await run(f, 'claude')).toEqual({ phase: 'done' });
    const base = 'https://downloads.claude.ai/claude-code-releases';
    expect(f.downloads.map((d) => [d.url, d.allowed])).toEqual([
      [`${base}/latest`, true],
      [`${base}/2.1.302/manifest.json`, true],
      [`${base}/2.1.302/darwin-arm64/claude`, true],
    ]);
    // An Apple-issued Developer ID for Anthropic's team, checked by codesign itself: not display output, and not a codesign from PATH.
    expect(commands(f.calls)).toEqual([
      `/usr/bin/codesign --verify --strict -R=anchor apple generic and certificate leaf[subject.OU] = "Q6L2SF6YDW" /tmp/codemm-agent/claude`,
      '/tmp/codemm-agent/claude install',
    ]);
    // The version and the manifest are small: a huge reply never fills the disk or memory.
    expect(f.caps).toEqual([1024, 1024 * 1024, 2 * 1024 ** 3]);
    expect(f.executable).toEqual(['/tmp/codemm-agent/claude']);
    expect(f.removed).toEqual(['/tmp/codemm-agent']);
  });

  it('Claude Code on Windows: the .exe, its Authenticode signer checked through an environment variable, then its own install', async () => {
    const f = fake('win32');
    expect(await run(f, 'claude')).toEqual({ phase: 'done' });
    expect(f.downloads.at(-1)!.url).toBe('https://downloads.claude.ai/claude-code-releases/2.1.302/win32-x64/claude.exe');
    const sign = f.calls[0];
    expect(sign.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(sign.env).toEqual({ CODEMM_FILE: 'C:\\Temp\\codemm-agent\\claude.exe' });
    expect(sign.args.join(' ')).not.toContain('codemm-agent');
    expect(commands(f.calls).at(-1)).toBe('C:\\Temp\\codemm-agent\\claude.exe install');
  });

  it('refuses a binary whose checksum differs from the manifest, and runs nothing', async () => {
    const f = fake('darwin', { sha256: async () => 'b'.repeat(64) });
    expect(await run(f, 'claude')).toEqual({ phase: 'failed', problem: 'unverified' });
    expect(f.calls).toEqual([]);
    expect(f.removed).toEqual(['/tmp/codemm-agent']);
  });

  it('refuses a binary Anthropic did not sign, and never runs it', async () => {
    const f = fake('darwin', { answers: { '/usr/bin/codesign': { code: 3, output: 'test-requirement: code failed to satisfy specified code requirement(s)' } } });
    expect(await run(f, 'claude')).toEqual({ phase: 'failed', problem: 'unverified' });
    expect(commands(f.calls).some((c) => c.endsWith(' install'))).toBe(false);
  });

  it('refuses a Windows binary signed by anyone else', async () => {
    const f = fake('win32', { answers: { 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive -Command': { code: 0, output: 'Valid|CN=Someone, O=Someone Else\n' } } });
    expect(await run(f, 'claude')).toEqual({ phase: 'failed', problem: 'unverified' });
  });

  it('fails plainly on a version or manifest that is not one', async () => {
    expect(await run(fake('darwin', { texts: { latest: '<html>' } }), 'claude')).toEqual({ phase: 'failed', problem: 'failed' });
    expect(await run(fake('darwin', { texts: { 'manifest.json': '{"platforms":{}}' } }), 'claude')).toEqual({ phase: 'failed', problem: 'failed' });
  });

  it('says offline when the download can\'t reach the vendor, and low disk before downloading', async () => {
    const offline = fake('darwin', { download: async () => Promise.reject(new OfflineError('ENOTFOUND')) });
    expect(await run(offline, 'claude')).toEqual({ phase: 'failed', problem: 'offline' });
    const full = fake('darwin', { freeBytes: async () => 0.2 * GiB });
    expect(await run(full, 'claude')).toEqual({ phase: 'failed', problem: 'disk' });
    expect(full.downloads).toEqual([]);
  });

  it('fails when the agent\'s own install step fails, or leaves nothing Codemm can find', async () => {
    expect(await run(fake('darwin', { answers: { '/tmp/codemm-agent/claude install': { code: 1, output: '' } } }), 'claude')).toEqual({ phase: 'failed', problem: 'failed' });
    expect(await run(fake('darwin', { find: () => null }), 'claude')).toEqual({ phase: 'failed', problem: 'failed' });
  });

  it('Codex on a Mac: OpenAI\'s official script, run as `sh <file>` without prompts, then the binary checked against OpenAI\'s signature', async () => {
    const f = fake('darwin');
    expect(await run(f, 'codex')).toEqual({ phase: 'done' });
    expect(f.downloads).toEqual([{ url: 'https://releases.openai.com/codex/install.sh', file: '/tmp/codemm-agent/install.sh', allowed: true }]);
    expect(f.calls[0]).toEqual({ file: '/bin/sh', args: ['/tmp/codemm-agent/install.sh'], env: { CODEX_NON_INTERACTIVE: '1' } });
    expect(commands(f.calls).slice(1)).toEqual([
      `/usr/bin/codesign --verify --strict -R=anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2" /Users/me/.codex/packages/standalone/current/codex`,
    ]);
  });

  it('Codex on Windows: OpenAI\'s PowerShell script as a file, never a command string', async () => {
    const f = fake('win32', { answers: { 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive -Command': { code: 0, output: 'Valid|CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC"\n' } } });
    expect(await run(f, 'codex')).toEqual({ phase: 'done' });
    expect(f.downloads[0].url).toBe('https://releases.openai.com/codex/install.ps1');
    expect(f.calls[0]).toEqual({
      file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\Temp\\codemm-agent\\install.ps1'],
      env: { CODEX_NON_INTERACTIVE: '1' },
    });
  });

  it('says a Codex that OpenAI did not sign is unverified', async () => {
    const f = fake('darwin', { answers: { '/usr/bin/codesign': { code: 3, output: '' } } });
    expect(await run(f, 'codex')).toEqual({ phase: 'failed', problem: 'unverified' });
  });

  it('fails when the Codex script exits 0 but leaves nothing Codemm can find, offline if it says so', async () => {
    expect(await run(fake('darwin', { find: () => null }), 'codex')).toEqual({ phase: 'failed', problem: 'failed' });
    const offline = fake('darwin', { find: () => null, answers: { '/bin/sh': { code: 0, output: 'curl: (6) Could not resolve host: releases.openai.com' } } });
    expect(await run(offline, 'codex')).toEqual({ phase: 'failed', problem: 'offline' });
    expect(offline.calls).toHaveLength(1);
  });

  it('says offline when the Codex script could not reach OpenAI', async () => {
    const f = fake('darwin', { answers: { '/bin/sh': { code: 1, output: 'curl: (6) Could not resolve host: releases.openai.com' } } });
    expect(await run(f, 'codex')).toEqual({ phase: 'failed', problem: 'offline' });
  });

  it('installs each agent only on macOS and Windows, one at a time per agent', async () => {
    expect(fake('linux').install.canInstall('claude')).toBe(false);
    expect(fake('linux').install.canInstall('cursor')).toBe(false);
    expect(fake('darwin').install.canInstall('cursor')).toBe(true);
    expect(fake('win32').install.canInstall('cursor')).toBe(true);
    const f = fake('darwin');
    f.install.install('claude');
    f.install.install('claude');
    await f.install.done('claude');
    expect(f.downloads.filter((d) => d.url.endsWith('/latest'))).toHaveLength(1);
    // Try again after a failure starts afresh.
    expect(f.install.status('claude')).toEqual({ phase: 'done' });
  });

  // Cursor's scripts (2026.10.22-27dcf5f) fetch downloads.cursor.com/lab/<version>/... and put the CLI in
  // ~/.local/share/cursor-agent (macOS) or %LOCALAPPDATA%\cursor-agent (Windows). They publish no checksum.
  const CURSOR_MAC = '/Users/me/.local/share/cursor-agent/versions/2026.10.22-27dcf5f';
  const CURSOR_WIN = 'C:\\Users\\me\\AppData\\Local\\cursor-agent\\versions\\2026.10.22-27dcf5f';
  /** What find() gives for Cursor on Windows: its own node.exe on its index.js. */
  const NODE_EXE = { path: `${CURSOR_WIN}\\node.exe`, js: false, args: [`${CURSOR_WIN}\\index.js`] };
  const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const SIGN_CHECK = `${PS} -NoProfile -NonInteractive -Command`;
  const SCRIPT_RUN = `${PS} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File`;
  const OPENJS = 'Valid|CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US\n';
  const GIT_LINE = 'Git for Windows (with Git Bash) is required to run a private worker.\nInstall it from https://git-scm.com/download/win\n';
  /** The lines of Cursor's scripts that name the version they install. */
  const SCRIPTS = {
    'install.sh': 'TEMP_EXTRACT_DIR="$HOME/.local/share/cursor-agent/versions/.tmp-2026.10.22-27dcf5f-$(date +%s)"\nFINAL_DIR="$HOME/.local/share/cursor-agent/versions/2026.10.22-27dcf5f"\n',
    'install.ps1': "$downloadUrl = 'https://downloads.cursor.com/lab/2026.10.22-27dcf5f/'\n$version = '2026.10.22-27dcf5f'\n",
  };
  const macCursor = (over: Parameters<typeof fake>[1] = {}) =>
    fake('darwin', { texts: SCRIPTS, realpath: (file) => file.replace('/Users/me/.local/bin/cursor-agent', `${CURSOR_MAC}/cursor-agent`), ...over });
  const winCursor = (answers: Record<string, { code: number | null; output: string }> = {}, over: Parameters<typeof fake>[1] = {}) =>
    fake('win32', { texts: SCRIPTS, found: () => NODE_EXE, answers: { [SIGN_CHECK]: { code: 0, output: OPENJS }, ...answers }, ...over });

  it("Cursor on a Mac: Cursor's script from cursor.com, run as `bash <file>`, then the Node.js it installed checked against the Node.js Foundation's signature", async () => {
    const f = macCursor();
    expect(await run(f, 'cursor')).toEqual({ phase: 'done' });
    expect(f.downloads).toEqual([{ url: 'https://cursor.com/install', file: '/tmp/codemm-agent/install.sh', allowed: true }]);
    expect(f.caps).toEqual([1024 * 1024]);
    // bash, not sh: the script uses bash's [[ ]] and ${var//}.
    expect(f.calls[0]).toEqual({ file: '/bin/bash', args: ['/tmp/codemm-agent/install.sh'] });
    expect(f.timeouts[0]).toBe(15 * 60_000);
    // Cursor signs nothing itself: the check is the Node.js Foundation's Apple team on the node that runs Cursor's code.
    expect(commands(f.calls).slice(1)).toEqual([
      `/usr/bin/codesign --verify --strict -R=anchor apple generic and certificate leaf[subject.OU] = "HX7739G8FX" ${CURSOR_MAC}/node`,
    ]);
    expect(f.removed).toEqual(['/tmp/codemm-agent']);
  });

  it("Cursor on Windows: Cursor's PowerShell script as a file, never `irm | iex`, then node.exe's OpenJS Foundation signature", async () => {
    // The script's Git for Windows line is about Cursor's private workers, which Codemm doesn't use: it never shows.
    const f = winCursor({ [SCRIPT_RUN]: { code: 0, output: GIT_LINE } });
    expect(await run(f, 'cursor')).toEqual({ phase: 'done' });
    expect(f.downloads).toEqual([{ url: 'https://cursor.com/install?win32=true', file: 'C:\\Temp\\codemm-agent\\install.ps1', allowed: true }]);
    expect(f.calls[0]).toEqual({ file: PS, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\Temp\\codemm-agent\\install.ps1'] });
    expect(f.timeouts[0]).toBe(15 * 60_000);
    const sign = f.calls[1];
    expect([sign.file, ...sign.args.slice(0, 3)].join(' ')).toBe(SIGN_CHECK);
    expect(sign.env).toEqual({ CODEMM_FILE: NODE_EXE.path });
    expect(f.calls).toHaveLength(2);
    expect(JSON.stringify(f.install.status('cursor'))).not.toContain('Git');
    const failed = winCursor({ [SCRIPT_RUN]: { code: 1, output: GIT_LINE } });
    expect(await run(failed, 'cursor')).toEqual({ phase: 'failed', problem: 'failed' });
    expect(JSON.stringify(failed.install.status('cursor'))).not.toContain('Git');
  });

  it("refuses a Cursor other than the version the script installs: a stale copy left by a failed run doesn't pass", async () => {
    const OLD = '2026.10.16-e3cb207';
    const mac = macCursor({ realpath: (file) => file.replace('/Users/me/.local/bin/cursor-agent', `/Users/me/.local/share/cursor-agent/versions/${OLD}/cursor-agent`) });
    expect(await run(mac, 'cursor')).toEqual({ phase: 'failed', problem: 'failed' });
    expect(mac.calls).toHaveLength(1);
    // On Windows, a locked node.exe can outlive the script's delete while the download fails, and the script exits 0.
    const stale = `C:\\Users\\me\\AppData\\Local\\cursor-agent\\versions\\${OLD}`;
    const win = winCursor({}, { found: () => ({ path: `${stale}\\node.exe`, js: false, args: [`${stale}\\index.js`] }) });
    expect(await run(win, 'cursor')).toEqual({ phase: 'failed', problem: 'failed' });
    expect(win.calls).toHaveLength(1);
  });

  it("runs no Cursor script that doesn't name the version it installs", async () => {
    for (const f of [macCursor({ texts: { 'install.sh': '<html>' } }), winCursor({}, { texts: { 'install.ps1': "$version = '../../x'" } })]) {
      expect(await run(f, 'cursor')).toEqual({ phase: 'failed', problem: 'failed' });
      expect(f.calls).toEqual([]);
    }
  });

  it("says a Cursor whose Node isn't the Node.js Foundation's is unverified", async () => {
    expect(await run(macCursor({ answers: { '/usr/bin/codesign': { code: 3, output: 'code object is not signed at all' } } }), 'cursor')).toEqual({ phase: 'failed', problem: 'unverified' });
    expect(await run(winCursor({ [SIGN_CHECK]: { code: 0, output: 'NotSigned|\n' } }), 'cursor')).toEqual({ phase: 'failed', problem: 'unverified' });
    expect(await run(winCursor({ [SIGN_CHECK]: { code: 0, output: 'Valid|CN=Someone, O=Someone Else\n' } }), 'cursor')).toEqual({ phase: 'failed', problem: 'unverified' });
  });

  it("says offline when Cursor's script couldn't reach Cursor, even if PowerShell exited 0", async () => {
    expect(await run(macCursor({ answers: { '/bin/bash': { code: 1, output: 'curl: (6) Could not resolve host: downloads.cursor.com\n✗ Download failed.' } } }), 'cursor')).toEqual({ phase: 'failed', problem: 'offline' });
    // Cursor's Windows script doesn't stop on errors, so a failed download can still exit 0, with nothing installed.
    const offline = winCursor({ [SCRIPT_RUN]: { code: 0, output: "Invoke-WebRequest : The remote name could not be resolved: 'downloads.cursor.com'" } }, { find: () => null });
    expect(await run(offline, 'cursor')).toEqual({ phase: 'failed', problem: 'offline' });
    expect(offline.calls).toHaveLength(1);
  });

  it("fails when Cursor's script fails, times out, or leaves nothing Codemm can find, and checks nothing then", async () => {
    const failed = winCursor({ [SCRIPT_RUN]: { code: 1, output: 'tar.exe exited with code 1' } });
    expect(await run(failed, 'cursor')).toEqual({ phase: 'failed', problem: 'failed' });
    expect(failed.calls).toHaveLength(1);
    expect(await run(macCursor({ answers: { '/bin/bash': { code: null, output: '' } } }), 'cursor')).toEqual({ phase: 'failed', problem: 'failed' });
    const missing = macCursor({ find: () => null });
    expect(await run(missing, 'cursor')).toEqual({ phase: 'failed', problem: 'failed' });
    expect(missing.calls).toHaveLength(1);
  });

  it('accepts only the vendors\' own https hosts, at every hop', () => {
    expect(isAgentHost('claude')('https://downloads.claude.ai/claude-code-releases/latest')).toBe(true);
    expect(isAgentHost('claude')('http://downloads.claude.ai/x')).toBe(false);
    expect(isAgentHost('claude')('https://downloads.claude.ai.evil.com/x')).toBe(false);
    expect(isAgentHost('claude')('https://releases.openai.com/codex/install.sh')).toBe(false);
    expect(isAgentHost('codex')('https://releases.openai.com/codex/install.sh')).toBe(true);
    expect(isAgentHost('codex')('https://chatgpt.com/codex/install.sh')).toBe(true);
    expect(isAgentHost('codex')('https://github.com/openai/codex')).toBe(false);
    expect(isAgentHost('cursor')('https://cursor.com/install?win32=true')).toBe(true);
    expect(isAgentHost('cursor')('http://cursor.com/install')).toBe(false);
    expect(isAgentHost('cursor')('https://cursor.com.evil.com/install')).toBe(false);
    expect(isAgentHost('cursor')('https://evil.com/cursor.com/install')).toBe(false);
    expect(isAgentHost('cursor')('https://downloads.claude.ai/claude-code-releases/latest')).toBe(false);
    expect(isAgentHost('claude')('https://cursor.com/install')).toBe(false);
  });
});
