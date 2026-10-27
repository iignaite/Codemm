// @vitest-environment node
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codemmServer } from './server';

describe("the Codemm server an agent job starts (§2, §4.6)", () => {
  it('is the bundled core run by the app as Node, bound to the course and the job tools', () => {
    expect(codemmServer({ runtime: '/App/Codemm', coreDir: '/App/core', ws: '/ws', env: {} })('c1', ['get_roadmap', 'save_lesson'])).toEqual({
      command: '/App/Codemm',
      args: [join('/App/core', 'dist', 'cli.mjs'), 'mcp', '--workspace', '/ws', '--course', 'c1', '--tools', 'get_roadmap,save_lesson', '--desktop'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });

  it("names Codemm's data folder itself: Codex starts MCP servers without the app's environment", () => {
    // Found in the macOS journey: a Codex job's server wrote the course to the default ~/.codemm.
    expect(codemmServer({ runtime: '/App/Codemm', coreDir: '/App/core', ws: '/ws', env: {} })('c1', ['save_exercise'], '/data/progress/j.json').args.slice(-2)).toEqual(['--progress', '/data/progress/j.json']);
    const server = codemmServer({ runtime: '/App/Codemm', coreDir: '/App/core', ws: '/ws', env: { CODEMM_HOME: '/data/codemm', PATH: '/usr/bin:/Applications/Docker.app/Contents/Resources/bin' } })(undefined, ['list_tracks']);
    // PATH too: the app adds Docker's folders to it, and the server's gates run Docker.
    expect(server.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', CODEMM_HOME: '/data/codemm', PATH: '/usr/bin:/Applications/Docker.app/Contents/Resources/bin' });
    expect(server.args).not.toContain('--course');
  });

  it("passes on the app's bundled wasmtime, so the agent's server runs WASI tracks' gates with it (core §4.5)", () => {
    const server = codemmServer({ runtime: '/App/Codemm', coreDir: '/App/core', ws: '/ws', env: { CODEMM_WASMTIME: '/App/wasmtime/wasmtime', SECRET_TOKEN: 'x' } })('c1', ['save_track']);
    expect(server.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', CODEMM_WASMTIME: '/App/wasmtime/wasmtime' });
  });
});
