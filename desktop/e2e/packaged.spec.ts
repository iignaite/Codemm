import { _electron as electron, expect, test } from '@playwright/test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callTool } from './mcp-client.mjs';
import { removeTempDirs, tempDir } from './temp';

test.afterAll(removeTempDirs);

// D1: the packaged app, with no Node or npm on PATH, launches to the welcome
// screen, starts its bundled `codemm mcp` with itself as Node, and runs a
// JavaScript agent the same way (on Windows through an npm .cmd shim).
const exe = process.env.CODEMM_PACKAGED;
const resources = process.env.CODEMM_RESOURCES;
const windows = process.platform === 'win32';

/** A fake Claude Code written in JavaScript, installed the way npm installs one. */
function fakeAgent(): string {
  const dir = tempDir('codemm-agent-');
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
if (args === '--version') console.log('2.1.283 (Claude Code)');
else if (args === 'auth status --json') console.log(JSON.stringify({ loggedIn: true, email: 'never-shown@example.com' }));
`;
  if (windows) {
    mkdirSync(join(dir, 'node_modules', 'fake-claude'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'fake-claude', 'cli.js'), script);
    writeFileSync(join(dir, 'claude.cmd'), '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%_prog%"  "%dp0%\\node_modules\\fake-claude\\cli.js" %*\r\n');
  } else {
    writeFileSync(join(dir, 'claude'), script);
    chmodSync(join(dir, 'claude'), 0o755);
  }
  return dir;
}

test.skip(!exe || !resources, 'set CODEMM_PACKAGED and CODEMM_RESOURCES to a packaged build');

test('packaged: welcome, bundled MCP server and a JavaScript agent, with no Node on PATH', async () => {
  const home = tempDir('codemm-home-');
  const ws = tempDir('codemm-ws-');
  const env = { ...process.env, PATH: fakeAgent(), CODEMM_HOME: home } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;

  const out = await callTool({ command: exe!, args: [join(resources!, 'core', 'dist', 'cli.mjs'), 'mcp', '--workspace', ws, '--tools', 'list_tracks', '--desktop'], env: { ...env, PATH: '', ELECTRON_RUN_AS_NODE: '1' } }, 'list_tracks');
  expect(out).toBe('[]');

  const app = await electron.launch({ executablePath: exe!, env });
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'Learn anything.' })).toBeVisible();
  await page.getByRole('button', { name: 'Connect an agent', exact: true }).click();
  const claude = page.getByRole('listitem', { name: 'Claude Code' });
  await claude.getByRole('button', { name: 'Connect' }).click();
  await expect(claude.getByText('Connected')).toBeVisible();
  await expect(page.getByText('never-shown@example.com')).toHaveCount(0);

  // The app log, in Electron's logs folder, records the connect and never the sign-in output.
  const logs = await app.evaluate(({ app: electronApp }) => electronApp.getPath('logs'));
  const log = readFileSync(join(logs, 'codemm.log'), 'utf8');
  expect(log).toContain('connect agent=claude state=connected');
  expect(log).not.toContain('never-shown');
  await app.close();
});
