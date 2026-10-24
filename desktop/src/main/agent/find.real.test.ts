// @vitest-environment node
// Opt-in, after a vendor's real install (.github/workflows/agent-installs.yml): Codemm's lookup finds the agent or
// Docker with a GUI app's PATH, and the agent answers its version. No sign-in and no model calls.
// CODEMM_REAL_INSTALL=claude|codex|cursor|docker CODEMM_INSTALL_PATH=<the PATH Codemm started with> npx vitest run src/main/agent/find.real.test.ts
// For docker, CODEMM_DOCKER_BIN is Docker Desktop's own CLI folder, which core's Docker calls must get on PATH.
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentId } from '../../shared/api';
import { AGENT_CLIS } from './agents';
import { ask } from './bridge';
import { dockerFolders, find, here } from './find';

const target = process.env.CODEMM_REAL_INSTALL;
// The PATH a Codemm opened from Finder, or opened on Windows before the install, started with.
const env = { ...process.env, PATH: process.env.CODEMM_INSTALL_PATH ?? process.env.PATH };
// Windows folder names ignore case, and PATH entries rarely match the install's own spelling.
const same = (p: string) => (process.platform === 'win32' ? p.toLowerCase().replace(/\\+$/, '') : p);

describe.skipIf(!target)('a real install (opt-in)', () => {
  it.runIf(target === 'docker')("finds Docker, with Docker Desktop's folder for its helpers", () => {
    const docker = find('docker', here(env));
    console.log('found', docker);
    expect(docker).not.toBeNull();
    const folders = dockerFolders(docker!.path);
    console.log('docker folders', folders);
    const bin = process.env.CODEMM_DOCKER_BIN;
    expect(bin).toBeTruthy();
    // The docker found is Docker Desktop's own, through a link or not, and not some other docker on PATH.
    expect(same(dirname(realpathSync(docker!.path)))).toBe(same(bin!));
    expect(folders.map(same)).toContain(same(bin!));
  });

  it.runIf(target !== 'docker')('finds the agent and reads its version', { timeout: 120_000 }, async () => {
    const cli = AGENT_CLIS[target as AgentId];
    expect(cli).toBeDefined();
    const exe = find(cli.bin, here(env));
    console.log('found', exe);
    expect(exe).not.toBeNull();
    // The agent starts with Codemm's environment, so with the same PATH.
    process.env.PATH = env.PATH;
    const version = await ask(exe!, cli.version.args, cli.version.read, { timeoutMs: 90_000 });
    console.log('version', version);
    expect(version).toMatch(/^\d/);
  });
});
