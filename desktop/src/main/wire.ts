// Builds the live CodemmApi (DESIGN §2): the bundled core in-process, agents
// and Docker found on this computer, and agent jobs whose MCP server is the
// bundled core run with this app as Node (§2, §7).
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENT_CLIS } from './agent/agents';
import { ask } from './agent/bridge';
import { find, withDockerFolders } from './agent/find';
import { computerCheck, waitWhileStarting } from './computer';
import { connector } from './connect';
import type { CoreApp } from './core/types';
import { createLive, type Live } from './live';
import type { Log } from './log';
import { codemmServer } from './server';
import { desktopState, workspaceOf } from './state';

const RUNTIME_INFO = ['info', '--format', '{{.ServerVersion}}|{{.OSType}}'];

export interface Places {
  /** out/core in development, <resources>/core when packaged. */
  coreDir: string;
  userData: string;
  log: Log;
}

export function liveApi({ coreDir, userData, log }: Places): Live {
  // The bundled core (scripts/bundle-core.mjs), loaded in-process.
  const core = require(join(coreDir, 'dist', 'app.cjs')) as CoreApp;
  const state = desktopState(userData);
  const ws = workspaceOf(state.read(), homedir());
  mkdirSync(ws, { recursive: true });
  const runtime = process.execPath;

  const connect = connector(
    {
      find: (bin) => find(bin),
      signedIn: async (id, exe) => (await ask(exe, AGENT_CLIS[id].signIn.args, AGENT_CLIS[id].signIn.read)) === true,
      version: (id, exe) => ask(exe, AGENT_CLIS[id].version.args, AGENT_CLIS[id].version.read),
    },
    state,
  );

  // GUI apps don't load shell profiles: give core's own docker calls Docker's folders, helpers included (§3.1).
  // At start, not only on Check this computer: a relaunched app goes straight back to the course.
  const findDocker = () => {
    const docker = find('docker');
    if (docker) process.env.PATH = withDockerFolders(process.env.PATH ?? '', docker.path);
    return docker;
  };
  findDocker();

  const computer = computerCheck({
    find: findDocker,
    info: async (docker) => (await ask(docker, RUNTIME_INFO, ({ code, output }) => ({ exit: code ?? -1, output }), { timeoutMs: 20_000 })) ?? { exit: -1, output: '' },
    sandbox: async () => (await core.doctor(false)).some((c) => c.name === 'network isolation' && c.ok),
    now: () => Date.now(),
  });

  return createLive({
    core,
    connect,
    computer,
    state,
    ws,
    runtime,
    log,
    dockerReady: () => waitWhileStarting(computer, () => new Promise((r) => setTimeout(r, 3000))),
    server: codemmServer({ runtime, coreDir, ws, env: process.env }),
  });
}

