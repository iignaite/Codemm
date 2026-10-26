// Builds the live CodemmApi (DESIGN §2): the bundled core in-process, agents
// and Docker found on this computer, and agent jobs whose MCP server is the
// bundled core run with this app as Node (§2, §7).
import { app, net } from 'electron';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENT_CLIS } from './agent/agents';
import { ask } from './agent/bridge';
import { signedInOf } from './agent/signedIn';
import { find, withDockerFolders } from './agent/find';
import { livePath, nodeRun } from './agent/livePath';
import { computerCheck, waitWhileStarting } from './computer';
import { agentInstaller, nodeAgentDeps } from './agentInstall';
import { connector } from './connect';
import { dockerDesktop, nativeArch, nodeDesktopDeps } from './dockerDesktop';
import { restartWindows } from './windows';
import { wsl } from './wsl';
import { electronFetch, electronGet } from './download';
import type { CoreApp } from './core/types';
import { createLive, type Live } from './live';
import type { Log } from './log';
import { codemmServer } from './server';
import { agentSignIn, nodeSignInDeps } from './signIn';
import { desktopState, workspaceOf } from './state';
import { usageStore } from './usage';
import { wasmtimeIn } from './wasmtime';

export interface Places {
  /** out/core in development, <resources>/core when packaged. */
  coreDir: string;
  /** Where the bundled wasmtime is: <resources>/wasmtime when packaged, vendor/wasmtime/<os>-<arch> in development. */
  wasmtimeDir: string;
  userData: string;
  log: Log;
}

export function liveApi({ coreDir, wasmtimeDir, userData, log }: Places): Live {
  // Core's WASI engine, in-process and in the agent's server (server.ts), runs WASI tracks on the bundled wasmtime.
  const wasmtime = wasmtimeIn(wasmtimeDir, process.platform);
  if (wasmtime) process.env.CODEMM_WASMTIME = wasmtime;
  // The bundled core (scripts/bundle-core.mjs), loaded in-process.
  const core = require(join(coreDir, 'dist', 'app.cjs')) as CoreApp;
  // A WASI track's toolchain downloads through Chromium's network stack too: school networks need the system's proxy
  // and certificates (core §4.5).
  core.setToolchainFetch?.(electronFetch(net.request));
  const state = desktopState(userData);
  const ws = workspaceOf(state.read(), homedir());
  mkdirSync(ws, { recursive: true });
  const runtime = process.execPath;
  // Downloads go through Chromium's network stack (the system's proxy and certificates), for this computer's own chip.
  const network = { get: electronGet(net.request), arch: nativeArch(process.arch, app.runningUnderARM64Translation) };

  // Claude Code, Codex and Cursor, installed the vendor's own way into the learner's folders, then their own sign-in.
  const installer = agentInstaller(nodeAgentDeps((bin) => find(bin), network));
  const connect = connector(
    {
      find: (bin) => find(bin),
      signedIn: (id, exe) => signedInOf(id, exe),
      version: (id, exe) => ask(exe, AGENT_CLIS[id].version.args, AGENT_CLIS[id].version.read),
    },
    state,
    { ...installer, signIn: agentSignIn(nodeSignInDeps(runtime)) },
  );

  // GUI apps don't load shell profiles: give core's own docker calls Docker's folders, helpers included (§3.1).
  // At start, not only on Check this computer: a relaunched app goes straight back to the course.
  const findDocker = () => {
    const docker = find('docker');
    if (docker) process.env.PATH = withDockerFolders(process.env.PATH ?? '', docker.path);
    return docker;
  };
  findDocker();

  const desktopDeps = nodeDesktopDeps(network);
  // WSL 2, which Docker Desktop runs on in Windows: read while the engine is down, set up on Install's click.
  const windowsWsl = wsl(desktopDeps);
  const desktop = dockerDesktop(desktopDeps, desktopDeps.platform === 'win32' ? windowsWsl : undefined);
  // What an install left when it failed, was declined, or Codemm quit midway.
  void desktop.removeLeftovers();
  const computer = computerCheck({
    find: findDocker,
    desktopInstalled: desktop.installed,
    desktopRunning: desktop.running,
    startedAt: desktop.startedAt,
    canInstall: desktop.canInstall,
    install: desktop.status,
    wsl: windowsWsl.state,
    // Asked of the Docker found here, asynchronously and bounded, so a stuck engine never blocks the app. Core reads the
    // answer, and asks a silent engine once more, for longer, before calling it busy rather than stopped (§6.1).
    state: async (docker) => {
      const state = await core.runtimeState((timeoutMs) => ask(docker, core.RUNTIME_INFO, ({ code, output }) => ({ exit: code ?? -1, output }), { timeoutMs }));
      // Check this computer has no busy row yet: there, an engine that never answered reads as not running.
      return state === 'busy' ? 'down' : state;
    },
    sandbox: () => core.networkIsolation(),
    // No container CLI, as core's containerCli() looks (docker or podman), and the wasmtime core's WASI engine runs
    // (core wasi.ts): the bundled one, else one on PATH, at the major version core needs.
    wasi: async () => {
      if (find('podman')) return false;
      const bin = process.env.CODEMM_WASMTIME ? { path: process.env.CODEMM_WASMTIME, js: false } : find('wasmtime');
      return Boolean(bin && (await ask(bin, ['--version'], ({ code, output }) => code === 0 && /^wasmtime 50\./.test(output))));
    },
    now: () => Date.now(),
  }, process.platform, log);

  return createLive({
    core,
    connect,
    computer,
    state,
    ws,
    runtime,
    agentDir: join(userData, 'agents'),
    usage: usageStore(userData),
    progressDir: join(userData, 'progress'),
    log,
    dockerReady: () => waitWhileStarting(computer, () => new Promise((r) => setTimeout(r, 3000))),
    docker: { ...desktop, restartWindows: () => restartWindows(desktopDeps) },
    server: codemmServer({ runtime, coreDir, ws, env: process.env }),
    // On Windows, what installers added to the registry's PATH since Codemm started (§3.1): agents, and Docker for
    // Check this computer and core's docker calls, rely on it. A steady clock: one set back would hold off the next read.
    livePath: livePath({ platform: process.platform, env: process.env, run: nodeRun, now: () => performance.now() }),
  });
}

