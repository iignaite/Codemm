import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fakeAgent } from './fake-agent';
import { removeTempDirs, tempDir } from './temp';

// A published release, installed the way a new learner installs it (.github/workflows/install-test.yml).
// The app opens, installs Claude Code and Codex for real (both end signed out, since Codemm never signs
// in), and Check this computer shows this machine's Docker state.
//   CODEMM_INSTALLED=<exe>   the installed app's executable
//   INSTALL_PATH=<PATH>      a learner's PATH: the system's folders, no Node, npm or agents
//   EXPECT_DOCKER=missing|windows-containers   what this machine has
//   INSTALL_SHOTS=<dir>      where screenshots and each screen's text go
const exe = process.env.CODEMM_INSTALLED;
const expectDocker = process.env.EXPECT_DOCKER;
const MIN = 60_000;

test.skip(!exe, 'set CODEMM_INSTALLED to an installed Codemm');
test.afterAll(removeTempDirs);
test.setTimeout(40 * MIN);

test('installed: opens, installs both agents, and checks this computer', async () => {
  const shots = process.env.INSTALL_SHOTS ?? tempDir('codemm-shots-');
  mkdirSync(shots, { recursive: true });
  const profile = tempDir('codemm-profile-');
  // The run's own workspace (O5), never a real ~/Codemm.
  writeFileSync(join(profile, 'desktop.json'), JSON.stringify({ format_version: 1, sessions: {}, workspace: tempDir('codemm-ws-') }));
  // CODEMM_TEST_FIXED_PATH: on Windows, the registry's PATH (Node, npm, Git on a runner) is never merged into the learner's.
  const env = { ...process.env, CODEMM_HOME: tempDir('codemm-home-'), PATH: process.env.INSTALL_PATH ?? process.env.PATH ?? '', CODEMM_TEST_FIXED_PATH: '1' } as Record<string, string>;
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];

  let app!: ElectronApplication;
  let page!: Page;
  const launch = async (path = env.PATH) => {
    app = await electron.launch({ executablePath: exe!, args: [`--user-data-dir=${profile}`], env: { ...env, PATH: path } });
    page = await app.firstWindow();
  };
  const shot = async (name: string) => {
    await page.screenshot({ path: join(shots, `${name}.png`) });
    writeFileSync(join(shots, `${name}.txt`), await page.locator('body').innerText());
  };
  const toConnect = async () => {
    await expect(page.getByRole('button', { name: 'Connect an agent', exact: true })).toBeVisible({ timeout: MIN });
    await page.getByRole('button', { name: 'Connect an agent', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Connect an agent' })).toBeVisible();
  };

  await launch();
  await expect(page.getByRole('heading', { name: 'Learn anything.' })).toBeVisible({ timeout: MIN });
  await shot('1-welcome');
  await toConnect();
  for (const [i, name] of ['Claude Code', 'Codex'].entries()) {
    const row = page.getByRole('listitem', { name });
    await expect(row.getByText('Not installed')).toBeVisible({ timeout: MIN });
    await row.getByRole('button', { name: 'Install', exact: true }).click();
    const settled = row.getByRole('alert').or(row.getByText('Connected')).or(row.getByRole('button', { name: /^(Connect|Sign in)$/ }));
    await expect(settled.first()).toBeVisible({ timeout: 10 * MIN });
    await shot(`${2 + i}-installed-${name.replace(' ', '-')}`);
    await expect(row.getByRole('alert'), `${name}'s install failed`).toHaveCount(0);
  }
  await app.close();

  // Neither installed agent is signed in, so Continue stays off: a signed-in stand-in goes first on PATH.
  await launch(`${fakeAgent()}${delimiter}${env.PATH}`);
  await toConnect();
  const claude = page.getByRole('listitem', { name: 'Claude Code' });
  if (!(await claude.getByText('Connected').isVisible())) await claude.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(claude.getByText('Connected')).toBeVisible({ timeout: MIN });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check this computer' })).toBeVisible({ timeout: MIN });
  if (expectDocker === 'missing') {
    await expect(page.getByRole('button', { name: 'Install Docker' })).toBeVisible({ timeout: 2 * MIN });
  } else if (expectDocker === 'windows-containers') {
    await expect(page.getByRole('listitem', { name: 'Docker is running' })).toContainText('Switch Docker Desktop to Linux containers', { timeout: 2 * MIN });
  }
  await shot('4-check-this-computer');
  await app.close();
});
