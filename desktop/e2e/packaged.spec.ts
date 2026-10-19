import { _electron as electron, expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeAgent } from './fake-agent';
import { callTool } from './mcp-client.mjs';
import { removeTempDirs, tempDir } from './temp';

test.afterAll(removeTempDirs);

// D1: the packaged app, with no Node or npm on PATH, launches to the welcome
// screen, starts its bundled `codemm mcp` with itself as Node, and runs a
// JavaScript agent the same way (on Windows through an npm .cmd shim).
const exe = process.env.CODEMM_PACKAGED;
const resources = process.env.CODEMM_RESOURCES;

test.skip(!exe || !resources, 'set CODEMM_PACKAGED and CODEMM_RESOURCES to a packaged build');

test('packaged: welcome, bundled MCP server and a JavaScript agent, with no Node on PATH', async () => {
  const home = tempDir('codemm-home-');
  const ws = tempDir('codemm-ws-');
  const env = { ...process.env, PATH: fakeAgent(), CODEMM_HOME: home } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;

  const out = await callTool({ command: exe!, args: [join(resources!, 'core', 'dist', 'cli.mjs'), 'mcp', '--workspace', ws, '--tools', 'list_tracks', '--desktop'], env: { ...env, PATH: '', ELECTRON_RUN_AS_NODE: '1' } }, 'list_tracks');
  expect(out).toBe('[]');

  // A profile of its own: Codemm runs once per profile, so a Codemm the learner has open never stands in for this one.
  const app = await electron.launch({ executablePath: exe!, args: [`--user-data-dir=${tempDir('codemm-profile-')}`], env });
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'Learn anything.' })).toBeVisible();
  await page.getByRole('button', { name: 'Connect an agent', exact: true }).click();
  // The only agent installed: Codemm runs its sign-in check at once, without a click.
  const claude = page.getByRole('listitem', { name: 'Claude Code' });
  await expect(claude.getByText('Connected')).toBeVisible();
  await expect(page.getByText('never-shown@example.com')).toHaveCount(0);

  // The app log, in Electron's logs folder, records the connect and never the sign-in output.
  const logs = await app.evaluate(({ app: electronApp }) => electronApp.getPath('logs'));
  const log = readFileSync(join(logs, 'codemm.log'), 'utf8');
  expect(log).toContain('connect agent=claude state=connected');
  expect(log).not.toContain('never-shown');
  await app.close();
});
