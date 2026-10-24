// @vitest-environment node
// Opt-in, on a Mac with network: the vendors' real downloads and the real checks, stopping short of installing.
// CODEMM_REAL_AGENT_DOWNLOAD=1 npx vitest run src/main/agentInstall.real.test.ts
// CODEMM_REAL_CODEX_BIN=<a native codex binary> also checks OpenAI's signature on it.
// CODEMM_REAL_CURSOR_BIN=<an installed cursor-agent, e.g. ~/.local/bin/cursor-agent> also checks its Node.js's signature.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agentInstaller, nodeAgentDeps } from './agentInstall';
import { fetchGet } from './download';

const network = { get: fetchGet, arch: process.arch };

const real = process.env.CODEMM_REAL_AGENT_DOWNLOAD === '1' && process.platform === 'darwin';

describe.skipIf(!real)("the agents' real downloads (opt-in)", () => {
  it("downloads Claude Code's binary, and accepts it only because it matches Anthropic's manifest and signature", { timeout: 20 * 60_000 }, async () => {
    const deps = nodeAgentDeps(() => ({ path: '/never/used', js: false }), network);
    const ran: string[] = [];
    const progress: number[] = [];
    let dir = '';
    const installer = agentInstaller({
      ...deps,
      tempDir: () => (dir = deps.tempDir()),
      download: (url, file, report, allowed) => deps.download(url, file, (f) => (progress.push(f), report(f)), allowed),
      // Everything up to the signature checks is real; Claude Code's own install step is not.
      run: async (file, args, opts) => {
        ran.push([file, ...args].join(' '));
        if (args[0] === 'install') return { code: 0, output: '' };
        return deps.run(file, args, opts);
      },
    });
    installer.install('claude');
    await installer.done('claude');
    expect(installer.status('claude')).toEqual({ phase: 'done' });
    expect(progress.at(-1)).toBe(1);
    expect(ran.filter((c) => c.startsWith('/usr/bin/codesign --verify --strict -R=anchor apple generic'))).toHaveLength(1);
    expect(ran.at(-1)).toMatch(/\/claude install$/);
    expect(deps.exists(dir)).toBe(false);
  });

  it("downloads OpenAI's Codex script from OpenAI, and runs nothing", { timeout: 5 * 60_000 }, async () => {
    const codex = process.env.CODEMM_REAL_CODEX_BIN;
    const deps = nodeAgentDeps(() => (codex ? { path: codex, js: false } : { path: '/no/codex', js: false }), network);
    let script = '';
    const ran: string[] = [];
    const installer = agentInstaller({
      ...deps,
      run: async (file, args, opts) => {
        ran.push([file, ...args].join(' '));
        if (file === '/bin/sh') {
          script = readFileSync(args[0], 'utf8');
          return { code: 0, output: '' };
        }
        return deps.run(file, args, opts);
      },
    });
    installer.install('codex');
    await installer.done('codex');
    expect(script.startsWith('#!/bin/sh')).toBe(true);
    expect(script).toContain('RELEASES_BASE_URL="https://releases.openai.com/codex"');
    expect(script).toContain('CODEX_NON_INTERACTIVE');
    // With a real Codex binary to check, OpenAI's signature is checked too; without one, nothing is found to check.
    expect(installer.status('codex')).toEqual(codex ? { phase: 'done' } : { phase: 'failed', problem: 'unverified' });
  });

  it("downloads Cursor's script from cursor.com, and runs nothing", { timeout: 5 * 60_000 }, async () => {
    const cursor = process.env.CODEMM_REAL_CURSOR_BIN;
    const deps = nodeAgentDeps(() => (cursor ? { path: cursor, js: false } : null), network);
    let script = '';
    const installer = agentInstaller({
      ...deps,
      run: async (file, args, opts) => {
        if (file === '/bin/bash') {
          script = readFileSync(args[0], 'utf8');
          return { code: 0, output: '' };
        }
        return deps.run(file, args, opts);
      },
    });
    installer.install('cursor');
    await installer.done('cursor');
    expect(script.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(script).toContain('https://downloads.cursor.com/');
    // With an installed Cursor, the Node.js Foundation's signature on its node is checked too; without one, nothing is found.
    expect(installer.status('cursor')).toEqual(cursor ? { phase: 'done' } : { phase: 'failed', problem: 'failed' });
  });
});
