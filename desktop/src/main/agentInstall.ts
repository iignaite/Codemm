// Installs Claude Code or Codex for the learner, the vendor's own way, into the learner's own folders: no Node,
// npm or admin rights (DESIGN §3.1). Downloads come only from the vendor's https host, checked at every hop.
// Every command is an argument array, never a shell string, and nothing runs until it is verified where the vendor
// publishes a way to verify it. Codemm never signs in for the learner: the agent's own login does that.
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import type { AgentId, AgentInstall } from '../shared/api';
import type { Executable } from './agent/bridge';
import { nodeDesktopDeps, OfflineError, type DesktopDeps } from './dockerDesktop';

export interface AgentInstallDeps extends DesktopDeps {
  readText(file: string): string;
  sha256(file: string): Promise<string>;
  makeExecutable(file: string): void;
  realpath(file: string): string;
  /** The agent's CLI where Codemm looks for it (find.ts). */
  find(bin: string): Executable | null;
}

const GiB = 1024 ** 3;
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
/** The path arrives as $env:CODEMM_FILE, so nothing outside this text is ever parsed as PowerShell. */
const SIGNATURE = '$s = Get-AuthenticodeSignature -LiteralPath $env:CODEMM_FILE; "$($s.Status)|$($s.SignerCertificate.Subject)"';
const CLAUDE_RELEASES = 'https://downloads.claude.ai/claude-code-releases';
/** OpenAI's documented chatgpt.com/codex/install.* redirect here. */
const CODEX_SCRIPTS = 'https://releases.openai.com/codex';
const INSTALL_MS = 15 * 60_000;
/** A failed script that couldn't reach the network: the computer is offline, not the install broken. */
const OFFLINE_OUTPUT = /could not resolve host|network is unreachable|failed to connect|unable to connect|no such host|name resolution/i;

/** Who signs each agent: Apple team ids (read from the vendors' notarized binaries) and Authenticode organizations. */
const SIGNERS: Record<'claude' | 'codex', { team: string; orgs: string[] }> = {
  claude: { team: 'Q6L2SF6YDW', orgs: ['Anthropic, PBC'] },
  codex: { team: '2DC432GLL2', orgs: ['OpenAI OpCo, LLC'] },
};

const HOSTS: Record<'claude' | 'codex', string[]> = {
  claude: ['downloads.claude.ai'],
  codex: ['releases.openai.com', 'chatgpt.com'],
};

/** The vendor's own download hosts, over https: checked at every hop, redirects included. */
export const isAgentHost = (id: 'claude' | 'codex') => (url: string) => {
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

  async function get(id: 'claude' | 'codex', url: string, file: string, progress = false) {
    try {
      await d.download(url, file, (p) => progress && status.set(id, { phase: 'downloading', progress: p }), isAgentHost(id));
    } catch (e) {
      throw new Stop(e instanceof OfflineError ? 'offline' : 'failed');
    }
  }

  /** The vendor signed this file: Apple's check and team on macOS, Authenticode and organization on Windows. */
  async function assertSigned(id: 'claude' | 'codex', file: string) {
    const { team, orgs } = SIGNERS[id];
    if (d.platform === 'darwin') {
      const signed = ok(await d.run('codesign', ['--verify', '--strict', file])) && new RegExp(`^TeamIdentifier=${team}$`, 'm').test((await d.run('codesign', ['-dv', '--verbose=2', file])).output);
      if (!signed) throw new Stop('unverified');
    } else {
      const r = await d.run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', SIGNATURE], { env: { CODEMM_FILE: file } });
      if (!ok(r) || !signedBy(r.output, orgs)) throw new Stop('unverified');
    }
  }

  /** As Anthropic's install script does, without running a script: the binary is checked before it runs. */
  async function claude(dir: string) {
    const platform = `${d.platform === 'win32' ? 'win32' : 'darwin'}-${d.arch === 'arm64' ? 'arm64' : 'x64'}`;
    await get('claude', `${CLAUDE_RELEASES}/latest`, path.join(dir, 'latest'));
    const version = d.readText(path.join(dir, 'latest')).trim();
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Stop('failed');
    await get('claude', `${CLAUDE_RELEASES}/${version}/manifest.json`, path.join(dir, 'manifest.json'));
    let checksum: unknown;
    try {
      checksum = JSON.parse(d.readText(path.join(dir, 'manifest.json'))).platforms?.[platform]?.checksum;
    } catch {
      throw new Stop('failed');
    }
    if (typeof checksum !== 'string' || !/^[a-f0-9]{64}$/.test(checksum)) throw new Stop('failed');
    const name = d.platform === 'win32' ? 'claude.exe' : 'claude';
    const bin = path.join(dir, name);
    await get('claude', `${CLAUDE_RELEASES}/${version}/${platform}/${name}`, bin, true);
    status.set('claude', { phase: 'checking' });
    if ((await d.sha256(bin)) !== checksum) throw new Stop('unverified');
    await assertSigned('claude', bin);
    status.set('claude', { phase: 'installing' });
    if (d.platform !== 'win32') d.makeExecutable(bin);
    // Claude Code's own installer: the launcher in ~/.local/bin and its versions folder.
    if (!ok(await d.run(bin, ['install'], { timeoutMs: INSTALL_MS }))) throw new Stop('failed');
  }

  /** OpenAI's own install script, as a file run by its interpreter, without prompts; then its binary is checked. */
  async function codex(dir: string) {
    const script = path.join(dir, d.platform === 'win32' ? 'install.ps1' : 'install.sh');
    await get('codex', `${CODEX_SCRIPTS}/${d.platform === 'win32' ? 'install.ps1' : 'install.sh'}`, script);
    status.set('codex', { phase: 'installing' });
    const env = { CODEX_NON_INTERACTIVE: '1' };
    const r =
      d.platform === 'win32'
        ? await d.run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { env, timeoutMs: INSTALL_MS })
        : await d.run('/bin/sh', [script], { env, timeoutMs: INSTALL_MS });
    if (!ok(r)) throw new Stop(OFFLINE_OUTPUT.test(r.output) ? 'offline' : 'failed');
    status.set('codex', { phase: 'checking' });
    const exe = d.find('codex');
    if (!exe) throw new Stop('failed');
    await assertSigned('codex', d.platform === 'win32' ? exe.path : d.realpath(exe.path));
  }

  async function installNow(id: 'claude' | 'codex') {
    let dir: string | undefined;
    try {
      dir = d.tempDir();
      if ((await d.freeBytes(dir)) < GiB) throw new Stop('disk');
      await (id === 'claude' ? claude(dir) : codex(dir));
      // Done only once Codemm finds it where it looks for agents.
      if (!d.find(id === 'claude' ? 'claude' : 'codex')) throw new Stop('failed');
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

  const canInstall = (id: AgentId): id is 'claude' | 'codex' => desktop && (id === 'claude' || id === 'codex');

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
export function nodeAgentDeps(find: (bin: string) => Executable | null): AgentInstallDeps {
  return {
    ...nodeDesktopDeps(),
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
