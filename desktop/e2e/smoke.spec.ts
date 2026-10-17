import { _electron as electron, expect, test } from '@playwright/test';

// Launches the built app with the mock (CODEMM_MOCK) and walks the main journey.
test('connect, computer check, goal, course, lesson and practice', async () => {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, CODEMM_MOCK: '' } });
  const page = await app.firstWindow();
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const heading = (name: string) => page.getByRole('heading', { name, exact: true });

  await button('Connect an agent').click();
  await page.getByRole('listitem', { name: 'Claude Code' }).getByRole('button', { name: 'Connect' }).click();
  await button('Continue').click();
  await expect(heading('Check this computer')).toBeVisible();
  await expect(page.getByText('This computer is ready.')).toBeVisible();
  await button('Continue').click();
  await button('Start learning').click();

  await page.getByRole('textbox', { name: 'What do you want to learn?' }).fill('React');
  await page.getByRole('textbox', { name: 'I already know' }).fill('Python');
  await button('Start').click();
  await expect(heading('Researching React')).toBeVisible();

  await expect(button('Approve')).toBeVisible({ timeout: 15_000 });
  await button('Approve').click();
  const consent = page.getByRole('dialog', { name: 'Set up React on this computer?' });
  await consent.getByRole('button', { name: 'Set up', exact: true }).click();

  await expect(heading('JavaScript basics')).toBeVisible();
  await expect(button('Read useState')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Setting up React/)).toBeHidden({ timeout: 15_000 });
  await button('Read What javascript basics is').click();
  await button('Next').click();
  await expect(heading('useState')).toBeVisible();
  await button('Next').click();

  await expect(heading('Click Counter')).toBeVisible();
  const results = page.getByRole('region', { name: 'Results' });
  await button('Check').click();
  await expect(results.getByRole('heading', { name: '2 of 4 passed' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Counter.jsx' }).fill('// my answer');
  await button('Check').click();
  await expect(results.getByRole('heading', { name: '4 of 4 passed' })).toBeVisible();

  await app.close();
});

// Learners who lack a prerequisite get a specific next step, acted out by the mock.
test('no agent installed: install links on the connect screen', async () => {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, CODEMM_MOCK: 'no-agent' } });
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Connect an agent', exact: true }).click();
  const claude = page.getByRole('listitem', { name: 'Claude Code' });
  await expect(claude.getByText('Not installed')).toBeVisible();
  await expect(claude.getByRole('link', { name: 'Get Claude Code' })).toHaveAttribute('href', 'https://code.claude.com/docs/en/setup');
  await expect(page.getByRole('link', { name: 'Get Codex' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await app.close();
});

test('no Docker: install steps, a link and a re-check', async () => {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, CODEMM_MOCK: 'no-docker' } });
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Connect an agent', exact: true }).click();
  await page.getByRole('listitem', { name: 'Claude Code' }).getByRole('button', { name: 'Connect' }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const installed = page.getByRole('listitem', { name: 'Docker is installed' });
  await expect(installed.getByText('Needs a step')).toBeVisible();
  await expect(installed.getByRole('link', { name: /^Get Docker/ })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText("Docker isn't installed yet. Checking again every few seconds.");
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ready when you are.' })).toBeVisible();
  await app.close();
});
