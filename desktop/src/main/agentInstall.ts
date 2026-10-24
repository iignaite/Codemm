// Installs Claude Code, Codex or Cursor for the learner, the vendor's own way, into the learner's own folders: no
// Node, npm or admin rights (DESIGN §3.1). Downloads come only from the vendor's https host, checked at every hop.
// Every command is an argument array, never a shell string, and nothing runs until it is verified where the vendor
// publishes a way to verify it. Codemm never signs in for the learner: the agent's own login does that.
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import type { AgentId, AgentInstall } from '../shared/api';
import { AGENT_CLIS } from './agent/agents';
import type { Executable } from './agent/bridge';
import { nodeDesktopDeps, type DesktopDeps, type Network } from './dockerDesktop';
import { OfflineError } from './download';
import { POWERSHELL } from './windows';

/** Docker's downloader and processes, without what only Docker's install uses. */
export interface AgentInstallDeps extends Omit<DesktopDeps, 'list' | 'modifiedAt' | 'tempRoot'> {
  readText(file: string): string;
  sha256(file: string): Promise<string>;
  makeExecutable(file: string): void;
  realpath(file: string): string;
  /** The agent's CLI where Codemm looks for it (find.ts). */
  find(bin: string): Executable | null;
}

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 ** 3;
/** System tools by absolute path: a tool earlier on PATH can't answer for them. */
const CODESIGN = '/usr/bin/codesign';
/** The path arrives as $env:CODEMM_FILE, so nothing outside this text is ever parsed as PowerShell. */
const SIGNATURE = '$s = Get-AuthenticodeSignature -LiteralPath $env:CODEMM_FILE; "$($s.Status)|$($s.SignerCertificate.Subject)"';
const CLAUDE_RELEASES = 'https://downloads.claude.ai/claude-code-releases';
/** OpenAI's documented chatgpt.com/codex/install.* redirect here. */
const CODEX_SCRIPTS = 'https://releases.openai.com/codex';
/** Cursor's documented install commands fetch these. */
const CURSOR_SCRIPT = { win32: 'https://cursor.com/install?win32=true', darwin: 'https://cursor.com/install' };
const INSTALL_MS = 15 * 60_000;
/** A script that couldn't reach the network: the computer is offline, not the install broken. */
const OFFLINE_OUTPUT = /could not resolve host|could not be resolved|network is unreachable|failed to connect|unable to connect|no such host|name resolution/i;

/**
 * Who signs each agent: Apple team ids (read from the vendors' notarized binaries) and Authenticode organizations.
 * Cursor signs nothing itself: its package runs its code on a Node.js the Node.js Foundation (macOS) or the OpenJS
 * Foundation (Windows) signed, read from Cursor's 2026.10.22 package.
 */
const SIGNERS: Record<AgentId, { team: string; orgs: string[] }> = {
  claude: { team: 'Q6L2SF6YDW', orgs: ['Anthropic, PBC'] },
  codex: { team: '2DC432GLL2', orgs: ['OpenAI OpCo, LLC'] },
  cursor: { team: 'HX7739G8FX', orgs: ['OpenJS Foundation'] },
};

const HOSTS: Record<AgentId, string[]> = {
  claude: ['downloads.claude.ai'],
  codex: ['releases.openai.com', 'chatgpt.com'],
  // Only the script: Cursor's script downloads its package itself, from downloads.cursor.com.
  cursor: ['cursor.com'],
};

/** The vendor's own download hosts, over https: checked at every hop, redirects included. */
export const isAgentHost = (id: AgentId) => (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && HOSTS[id].includes(u.hostname);
  } catch {
    return false;
  }
};

/** A Get-AuthenticodeSignature result: Valid, and the signer's organization is exactly one of `orgs`. */
export function signedBy(output: string, orgs: string[]): boolean {
  const [status, subject = ''] = output.trim().split('|', 2);
  if (status !== 'Valid') return false;
  const attributes = subject.match(/(?:[^,"]|"[^"]*")+/g)?.map((a) => a.trim()) ?? [];
  return attributes.some((a) => orgs.some((o) => a === `O=${o}` || a === `O="${o}"`));
}

/** A Cursor version, as its launchers match them: `2026.10.22-27dcf5f`, or with a build time, `2026.06.12-19-59-36-f6aba9a`. */
const CURSOR_VERSION = /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/;

/** The version Cursor's install script installs, from its `$version = '…'` line (Windows) or `FINAL_DIR=…/versions/…` (macOS). */
export function cursorVersion(script: string, platform: NodeJS.Platform): string | null {
  const m = platform === 'win32' ? /^\$version = '([^']*)'/m.exec(script) : /^FINAL_DIR="[^"]*\/versions\/([^"/]*)"/m.exec(script);
  return m && CURSOR_VERSION.test(m[1]) ? m[1] : null;
}

class Stop extends Error {
  constructor(readonly problem: NonNullable<AgentInstall['problem']>) {
    super(problem);
  }
}

export function agentInstaller(d: AgentInstallDeps) {
  const path = d.platform === 'win32' ? win32 : posix;
  const desktop = d.platform === 'darwin' || d.platform === 'win32';
  const status = new Map<AgentId, AgentInstall>();
  const running = new Map<AgentId, Promise<void>>();
  const ok = (r: { code: number | null }) => r.code === 0;

  /** A download from the vendor's host, at most `maxBytes`: small files stay small. */
  async function get(id: AgentId, url: string, file: string, maxBytes: number, progress = false) {
    try {
      await d.download(url, file, (p) => progress && status.set(id, { phase: 'downloading', progress: p }), isAgentHost(id), maxBytes);
    } catch (e) {
      throw new Stop(e instanceof OfflineError ? 'offline' : 'failed');
    }
  }

  /**
   * The vendor signed this file. On macOS, codesign itself checks that the signature is valid and that its
   * certificate is Apple-issued for the vendor's team; on Windows, Authenticode and the signer's organization.
   */
  async function assertSigned(id: AgentId, file: string) {
    const { team, orgs } = SIGNERS[id];
    if (d.platform === 'darwin') {
      const requirement = `-R=anchor apple generic and certificate leaf[subject.OU] = "${team}"`;
      if (!ok(await d.run(CODESIGN, ['--verify', '--strict', requirement, file]))) throw new Stop('unverified');
    } else {
      const r = await d.run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', SIGNATURE], { env: { CODEMM_FILE: file } });
      if (!ok(r) || !signedBy(r.output, orgs)) throw new Stop('unverified');
    }
  }

  /** As Anthropic's install script does, without running a script: the binary is checked before it runs. */
  async function claude(dir: string) {
    const platform = `${d.platform === 'win32' ? 'win32' : 'darwin'}-${d.arch === 'arm64' ? 'arm64' : 'x64'}`;
    await get('claude', `${CLAUDE_RELEASES}/latest`, path.join(dir, 'latest'), KiB);
    const version = d.readText(path.join(dir, 'latest')).trim();
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Stop('failed');
    await get('claude', `${CLAUDE_RELEASES}/${version}/manifest.json`, path.join(dir, 'manifest.json'), MiB);
    let checksum: unknown;
    try {
      checksum = JSON.parse(d.readText(path.join(dir, 'manifest.json'))).platforms?.[platform]?.checksum;
    } catch {
      throw new Stop('failed');
    }
    if (typeof checksum !== 'string' || !/^[a-f0-9]{64}$/.test(checksum)) throw new Stop('failed');
    const name = d.platform === 'win32' ? 'claude.exe' : 'claude';
    const bin = path.join(dir, name);
    await get('claude', `${CLAUDE_RELEASES}/${version}/${platform}/${name}`, bin, 2 * GiB, true);
    status.set('claude', { phase: 'checking' });
    if ((await d.sha256(bin)) !== checksum) throw new Stop('unverified');
    await assertSigned('claude', bin);
    status.set('claude', { phase: 'installing' });
    if (d.platform !== 'win32') d.makeExecutable(bin);
    // Claude Code's own installer: the launcher in ~/.local/bin and its versions folder.
    if (!ok(await d.run(bin, ['install'], { timeoutMs: INSTALL_MS }))) throw new Stop('failed');
  }

  /**
   * A downloaded vendor install script, run as a file by its interpreter (`sh` or `bash` on macOS, PowerShell on
   * Windows), never a shell string. Then its CLI must be where Codemm looks. The script's output stays here: it is
   * only read for being offline.
   */
  async function runScript(id: 'codex' | 'cursor', file: string, unix: string, env?: Record<string, string>) {
    status.set(id, { phase: 'installing' });
    const opts = { ...(env ? { env } : {}), timeoutMs: INSTALL_MS };
    const r =
      d.platform === 'win32'
        ? await d.run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], opts)
        : await d.run(unix, [file], opts);
    // A script that exits 0 after a failed download (Cursor's PowerShell one doesn't stop on errors) installed nothing.
    const exe = ok(r) ? d.find(AGENT_CLIS[id].bin) : null;
    if (!exe) throw new Stop(OFFLINE_OUTPUT.test(r.output) ? 'offline' : 'failed');
    status.set(id, { phase: 'checking' });
    return exe;
  }

  /** OpenAI's own install script, without prompts; then its binary is checked against OpenAI's signature. */
  async function codex(dir: string) {
    const name = d.platform === 'win32' ? 'install.ps1' : 'install.sh';
    const file = path.join(dir, name);
    await get('codex', `${CODEX_SCRIPTS}/${name}`, file, MiB);
    const exe = await runScript('codex', file, '/bin/sh', { CODEX_NON_INTERACTIVE: '1' });
    await assertSigned('codex', d.platform === 'win32' ? exe.path : d.realpath(exe.path));
  }

  /**
   * Cursor's own install script (bash on macOS: it uses bash's [[ ]]). Then Codemm must find the version the script
   * names, not a copy an earlier run left, and that version's Node.js, which runs Cursor's code, is checked against
   * its signer. On Windows find() gives that node.exe itself; on macOS `cursor-agent` links to a launcher beside it.
   * Nothing is signed by Cursor, and Cursor publishes no checksum (DESIGN §3.1).
   */
  async function cursor(dir: string) {
    const windows = d.platform === 'win32';
    const file = path.join(dir, windows ? 'install.ps1' : 'install.sh');
    await get('cursor', windows ? CURSOR_SCRIPT.win32 : CURSOR_SCRIPT.darwin, file, MiB);
    const version = cursorVersion(d.readText(file), d.platform);
    if (!version) throw new Stop('failed');
    const exe = await runScript('cursor', file, '/bin/bash');
    const folder = path.dirname(windows ? exe.path : d.realpath(exe.path));
    if (path.basename(folder) !== version) throw new Stop('failed');
    await assertSigned('cursor', path.join(folder, windows ? 'node.exe' : 'node'));
  }

  const INSTALLS: Record<AgentId, (dir: string) => Promise<void>> = { claude, codex, cursor };

  async function installNow(id: AgentId) {
    let dir: string | undefined;
    try {
      dir = d.tempDir();
      if ((await d.freeBytes(dir)) < GiB) throw new Stop('disk');
      await INSTALLS[id](dir);
      // Done only once Codemm finds it where it looks for agents.
      if (!d.find(AGENT_CLIS[id].bin)) throw new Stop('failed');
      status.set(id, { phase: 'done' });
    } catch (e) {
      status.set(id, { phase: 'failed', problem: e instanceof Stop ? e.problem : 'failed' });
    } finally {
      if (dir) {
        try {
          d.remove(dir);
        } catch {
          // Leftovers in a temp folder are harmless; the OS clears it.
        }
      }
    }
  }

  /** Every agent installs the same way on macOS and Windows; nothing installs on Linux. */
  const canInstall = (_id: AgentId) => desktop;

  return {
    canInstall,
    /** Starts an install unless one is running for this agent. Follow it with status(). */
    install(id: AgentId) {
      if (!canInstall(id) || status.get(id)?.phase === 'downloading' || status.get(id)?.phase === 'checking' || status.get(id)?.phase === 'installing') return;
      status.set(id, { phase: 'downloading', progress: 0 });
      running.set(id, installNow(id));
    },
    status: (id: AgentId) => status.get(id),
    /** The current install, for tests and quitting. */
    done: (id: AgentId) => running.get(id) ?? Promise.resolve(),
  };
}

/** The real computer: Docker's downloader and processes, plus file checks. */
export function nodeAgentDeps(find: (bin: string) => Executable | null, network: Network): AgentInstallDeps {
  return {
    ...nodeDesktopDeps(network),
    tempDir: () => mkdtempSync(join(tmpdir(), 'codemm-agent-')),
    readText: (file) => readFileSync(file, 'utf8').slice(0, 1_000_000),
    sha256: (file) =>
      new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(file)
          .on('data', (chunk) => hash.update(chunk))
          .on('end', () => resolve(hash.digest('hex')))
          .on('error', reject);
      }),
    makeExecutable: (file) => chmodSync(file, 0o755),
    realpath: (file) => realpathSync(file),
    find,
  };
}
